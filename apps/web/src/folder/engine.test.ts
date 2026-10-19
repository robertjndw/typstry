import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { applyChanges } from "./apply";
import type { FolderLink } from "./base";
import { FolderSync, type FolderLocker, type FolderSyncState } from "./engine";
import { handleFs, type FolderFs } from "./folder-fs";
import { materialize } from "./materialize";
import { fakeAssets, fakeFolder, type FakeFolderOptions } from "./test-utils";

let visibility = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "hidden";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

function setup(
  files: Record<string, string | Uint8Array> = {},
  over: {
    folder?: FakeFolderOptions;
    lock?: FolderLocker;
    synced?: boolean;
    canWrite?: boolean;
    wrap?: (fs: FolderFs) => FolderFs;
  } = {},
) {
  const folder = fakeFolder(files, over.folder);
  const inner = handleFs(folder.handle);
  const scans = { count: 0 };
  const counted: FolderFs = {
    ...inner,
    readdir: async (dir) => {
      if (dir === "") scans.count++;
      return inner.readdir(dir);
    },
  };
  const fs = over.wrap ? over.wrap(counted) : counted;
  const project = newProject(1);
  initProject(project, { title: "T", starter: false });
  const link: FolderLink = {
    spaceId: "s",
    v: 1,
    handle: folder.handle,
    name: "root",
    base: null,
  };
  const saveFolder = vi.fn<(link: FolderLink) => Promise<void>>(async () => {});
  const saveLocally = vi.fn(async () => {});
  const states: FolderSyncState[] = [];
  const flags = { synced: over.synced ?? true };
  const release = vi.fn();
  const sync = new FolderSync({
    spaceId: "s",
    project,
    assets: fakeAssets(),
    canWrite: over.canWrite ?? true,
    link,
    fs,
    backend: { saveFolder },
    saveLocally,
    synced: () => flags.synced,
    onState: (s) => states.push(s),
    lock: over.lock ?? (async () => release),
  });
  const put = (path: string, text: string) =>
    applyChanges(project, new Map([[path, { kind: "text" as const, text }]]));
  const text = (path: string) => {
    const f = materialize(project).get(path);
    return f?.kind === "text" ? f.text : undefined;
  };
  return {
    folder,
    project,
    sync,
    scans,
    saveFolder,
    saveLocally,
    states,
    flags,
    release,
    put,
    text,
  };
}

const last = (t: { states: FolderSyncState[] }) => t.states.at(-1)!;

describe("FolderSync", () => {
  it("imports the folder on the first run and stores doc before base", async () => {
    const t = setup({ "a.typ": "a" });
    const order: string[] = [];
    t.saveLocally.mockImplementation(async () => void order.push("doc"));
    t.saveFolder.mockImplementation(async () => void order.push("base"));
    t.sync.start();
    await t.sync.syncNow();
    expect(t.text("a.typ")).toBe("a");
    expect(order).toEqual(["doc", "base"]);
    expect(last(t).status).toBe("idle");
    const saved = t.saveFolder.mock.calls[0]![0];
    expect(Object.keys(saved.base!.files)).toEqual(["a.typ"]);
    t.sync.stop();
  });

  it("waits for the project before the first link, then goes on", async () => {
    const t = setup({ "a.typ": "a" }, { synced: false });
    t.sync.start();
    await t.sync.syncNow();
    expect(last(t).status).toBe("waiting");
    expect(t.text("a.typ")).toBeUndefined();
    t.flags.synced = true;
    await t.sync.syncNow();
    expect(last(t).status).toBe("idle");
    expect(t.text("a.typ")).toBe("a");
    t.sync.stop();
  });

  it("runs one cycle at a time and one more for triggers during it", async () => {
    const t = setup({ "a.typ": "a" });
    await Promise.all([t.sync.run(), t.sync.run(), t.sync.run()]);
    expect(t.scans.count).toBe(2);
    t.sync.stop();
  });

  it("writes a doc edit to the folder after the debounce", async () => {
    const t = setup({ "a.typ": "a" });
    t.sync.start();
    await t.sync.syncNow();
    t.put("a.typ", "edited");
    await vi.advanceTimersByTimeAsync(799);
    expect(t.folder.text("a.typ")).toBe("a");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(t.folder.text("a.typ")).toBe("edited"));
    t.sync.stop();
  });

  it("caps the debounce under steady typing", async () => {
    const t = setup({ "a.typ": "a" });
    t.sync.start();
    await t.sync.syncNow();
    for (let i = 1; i <= 8; i++) {
      t.put("a.typ", `edit ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.waitFor(() => expect(t.folder.text("a.typ")).toMatch(/^edit/));
    t.sync.stop();
  });

  it("does not trigger itself with the commit it makes", async () => {
    const t = setup({ "a.typ": "a" });
    t.sync.start();
    await t.sync.syncNow();
    t.folder.clock.advance();
    t.folder.set("a.typ", "from disk");
    await t.sync.syncNow();
    expect(t.text("a.typ")).toBe("from disk");
    const scans = t.scans.count;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.scans.count).toBe(scans);
    t.sync.stop();
  });

  it("polls while visible and runs when the tab returns", async () => {
    const t = setup({ "a.typ": "a" });
    t.sync.start();
    await t.sync.syncNow();
    visibility = "visible";
    t.folder.clock.advance();
    t.folder.set("a.typ", "poll me");
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(t.text("a.typ")).toBe("poll me"));

    visibility = "hidden";
    t.folder.clock.advance();
    t.folder.set("a.typ", "while away");
    await vi.advanceTimersByTimeAsync(9000);
    expect(t.text("a.typ")).toBe("poll me");
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(t.text("a.typ")).toBe("while away"));
    t.sync.stop();
  });

  it("asks for permission, and syncs after reconnect", async () => {
    const t = setup(
      { "a.typ": "a" },
      { folder: { permission: "prompt", grantOnRequest: "granted" } },
    );
    t.sync.start();
    await t.sync.syncNow();
    expect(last(t).status).toBe("needs-permission");
    expect(t.scans.count).toBe(0);
    await t.sync.reconnect();
    expect(last(t).status).toBe("idle");
    expect(t.text("a.typ")).toBe("a");
    t.sync.stop();
  });

  it("stays in needs-permission when the user declines", async () => {
    const t = setup(
      { "a.typ": "a" },
      { folder: { permission: "prompt", grantOnRequest: "denied" } },
    );
    t.sync.start();
    await t.sync.reconnect();
    expect(last(t).status).toBe("needs-permission");
    t.sync.stop();
  });

  it("does nothing while another tab holds the lock", async () => {
    const lock = vi.fn(async () => null);
    const t = setup({ "a.typ": "a" }, { lock });
    t.sync.start();
    await t.sync.syncNow();
    expect(last(t).status).toBe("other-tab");
    expect(lock).toHaveBeenCalledWith("typstry:folder:s");
    expect(t.scans.count).toBe(0);
    t.sync.stop();
  });

  it("reports a vanished folder and an unexpected failure, and recovers", async () => {
    const t = setup({ "a.typ": "a" });
    t.folder.delete("a.typ");
    const real = t.folder.handle.entries.bind(t.folder.handle);
    let failure: Error | null = new DOMException("gone", "NotFoundError");
    vi.spyOn(t.folder.handle, "entries").mockImplementation(() => {
      if (failure) throw failure;
      return real();
    });
    t.sync.start();
    await t.sync.syncNow();
    expect(last(t).status).toBe("missing");
    failure = new Error("disk on fire");
    await t.sync.syncNow();
    expect(last(t)).toMatchObject({ status: "error", error: "disk on fire" });
    failure = null;
    await t.sync.syncNow();
    expect(last(t).status).toBe("idle");
    t.sync.stop();
  });

  it("filters the observer records of its own writes", async () => {
    let notify: ((records: unknown[]) => void) | undefined;
    const disconnect = vi.fn();
    class FakeObserver {
      constructor(cb: (records: unknown[]) => void) {
        notify = cb;
      }
      observe = vi.fn(async () => {});
      disconnect = disconnect;
    }
    vi.stubGlobal("FileSystemObserver", FakeObserver);
    const t = setup();
    t.put("p.typ", "p");
    t.sync.start();
    await t.sync.syncNow();
    expect(t.folder.text("p.typ")).toBe("p");
    const scans = t.scans.count;

    notify!([{ type: "modified", relativePathComponents: ["p.typ"] }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.scans.count).toBe(scans);

    t.folder.clock.advance();
    t.folder.set("q.typ", "q");
    notify!([{ type: "appeared", relativePathComponents: ["q.typ"] }]);
    await vi.advanceTimersByTimeAsync(299);
    expect(t.scans.count).toBe(scans);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(t.text("q.typ")).toBe("q"));

    t.sync.stop();
    expect(disconnect).toHaveBeenCalled();
  });

  it("stops every trigger and gives up the lock", async () => {
    const t = setup({ "a.typ": "a" });
    t.sync.start();
    await t.sync.syncNow();
    await t.sync.stop();
    expect(t.release).toHaveBeenCalled();
    const scans = t.scans.count;
    visibility = "visible";
    t.put("a.typ", "late");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    await t.sync.syncNow();
    expect(t.scans.count).toBe(scans);
    expect(t.folder.text("a.typ")).toBe("a");
  });

  it("saves the base, then reports lost permission, when write-back is cut short", async () => {
    const t = setup(
      { "a.typ": "a" },
      {
        wrap: (fs) => ({
          ...fs,
          write: async () => {
            throw new DOMException("denied", "NotAllowedError");
          },
        }),
      },
    );
    t.sync.start();
    await t.sync.syncNow();
    t.put("a.typ", "edited");
    await t.sync.syncNow();
    await t.sync.syncNow();
    expect(last(t).status).toBe("needs-permission");
    expect(t.saveFolder).toHaveBeenCalled();
    await t.sync.stop();
  });

  it("lets a cycle past its commit save before stop resolves, silently", async () => {
    const t = setup({ "a.typ": "a" });
    t.sync.start();
    await t.sync.syncNow();
    t.saveFolder.mockClear();
    let finish: () => void = () => {};
    let saved = false;
    t.saveFolder.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            saved = true;
            resolve();
          };
        }),
    );
    t.folder.clock.advance();
    t.folder.set("a.typ", "from disk");
    const running = t.sync.syncNow();
    await vi.waitFor(() => expect(t.saveFolder).toHaveBeenCalled());
    const states = t.states.length;
    const stopped = t.sync.stop();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await stopped;
    await running;
    expect(saved).toBe(true);
    expect(t.states.length).toBe(states);
  });
});
