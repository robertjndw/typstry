import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newProject } from "@/crypto/test-utils";
import { fetchMlsBootstrap, resolveShare } from "@/sync/api";
import { connectSpace } from "@/sync/connection";

import { loadBinding, saveBinding } from "./binding";
import type { Directory } from "./directory";
import {
  DirectoryService,
  refreshDirectoryService,
  useDirectorySync,
} from "./service";
import { link, newDirectory } from "./test-utils";

vi.mock("@/sync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/sync/api")>()),
  resolveShare: vi.fn(),
  fetchMlsBootstrap: vi.fn(),
}));
vi.mock("@/sync/connection", () => ({ connectSpace: vi.fn() }));

// The member group has its own tests; here it is a stand-in the test can
// steer: capture the options it was built with and set the phase it reports.
const group = vi.hoisted(() => ({
  options: [] as { onRotated?: (r: unknown) => void }[],
  phase: "active",
  listeners: new Set<() => void>(),
}));
vi.mock("@/mls/session", () => ({
  IDLE: {
    phase: "idle",
    members: [],
    canCommit: false,
    holdsOwnerKey: false,
    stalled: false,
    error: null,
  },
  MlsSession: class {
    constructor(opts: { onRotated?: (r: unknown) => void }) {
      group.options.push(opts);
    }
    subscribe = (fn: () => void) => {
      group.listeners.add(fn);
      return () => group.listeners.delete(fn);
    };
    getSnapshot = () => ({
      phase: group.phase,
      members: [],
      canCommit: false,
      holdsOwnerKey: false,
      stalled: false,
      error: null,
    });
    start = async () => {};
    stop() {}
    keys() {
      return null;
    }
    onKeys() {
      return () => {};
    }
    updateProfile() {}
    catchUp() {}
  },
}));

vi.mock("@/persist/local-doc-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/persist/local-doc-store")>();
  return {
    ...real,
    defaultBackend: () => Promise.resolve(new real.MemoryBackend()),
  };
});

const keys = newProject();
const secret = keys.link.toBase64url();
const identity = { name: "Ada", color: "#ff0000" };
const share = { spaceId: "personal", permission: "write" as const };
const binding = { spaceId: "personal", token: "tok", secret };

/** A relay in place of the server: whatever one doc commits, the others get. */
function relay() {
  const docs: Directory["doc"][] = [];
  vi.mocked(connectSpace).mockImplementation(({ doc }) => {
    for (const other of docs) {
      doc.import(other.export({ mode: "update" }));
      other.import(doc.export({ mode: "update" }));
    }
    docs.push(doc);
    const stop = doc.subscribeLocalUpdates((update) => {
      for (const other of docs) if (other !== doc) other.import(update);
    });
    return {
      getStatus: () => "connected",
      subscribe: (listener) => {
        listener("connected");
        return () => {};
      },
      synced: Promise.resolve(),
      syncNow: () => Promise.resolve("synced"),
      close: stop,
    };
  });
}

function service(dir: Directory) {
  return new DirectoryService(dir, () => identity);
}

beforeEach(() => {
  vi.mocked(resolveShare).mockResolvedValue(share);
  vi.mocked(fetchMlsBootstrap).mockResolvedValue({
    incarnation: 0,
    epoch: 0,
    groupInfo: new Uint8Array(),
    keyring: keys.signed,
    ownerKey: new Uint8Array(32),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(resolveShare).mockReset();
  vi.mocked(fetchMlsBootstrap).mockReset();
  vi.mocked(connectSpace).mockReset();
  group.options.length = 0;
  group.phase = "active";
  group.listeners.clear();
  localStorage.clear();
});

describe("DirectoryService", () => {
  it("does nothing without a binding", async () => {
    const svc = service(newDirectory(1));
    svc.refresh();
    expect(svc.running).toBe(false);
    await refreshDirectoryService();
    expect(connectSpace).not.toHaveBeenCalled();
    expect(resolveShare).not.toHaveBeenCalled();
  });

  it("uploads what the directory held before the binding to the other device", async () => {
    relay();
    const a = newDirectory(1);
    // Recorded while the directory was still local-only.
    a.addLink(link(1, "proj", { secret }));
    a.setTitle("proj", "Thesis");
    const b = newDirectory(2);

    saveBinding(binding);
    const first = service(a);
    const second = service(b);
    first.refresh();
    second.refresh();
    await vi.waitFor(() =>
      expect(b.list(Date.now())).toMatchObject([
        { projectId: "proj", title: "Thesis" },
      ]),
    );

    // And live changes keep flowing.
    a.setTitle("proj", "Renamed");
    expect(b.list(Date.now())[0]!.title).toBe("Renamed");
    first.stop();
    second.stop();
  });

  it("reports the sync state while the service runs", async () => {
    relay();
    const { result } = renderHook(() => useDirectorySync());
    expect(result.current).toBe("off");
    saveBinding(binding);
    const svc = service(newDirectory(1));
    act(() => svc.refresh());
    await vi.waitFor(() => expect(result.current).toBe("synced"));
    act(() => svc.stop());
    expect(result.current).toBe("off");
  });

  it("keeps the entries a device had before it joined another person", async () => {
    relay();
    // The holder's directory is in the space already.
    const holder = newDirectory(1);
    holder.addLink(link(1, "theirs", { secret }));
    saveBinding(binding);
    const first = service(holder);
    first.refresh();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalledTimes(1));

    // A disposable device with a project of its own takes the binding over.
    const mine = newDirectory(2);
    mine.addLink(link(2, "mine", { secret }));
    mine.setTitle("mine", "Left behind");
    const second = service(mine);
    second.refresh();
    await vi.waitFor(() =>
      expect(
        holder
          .list(Date.now())
          .map((e) => e.projectId)
          .sort(),
      ).toEqual(["mine", "theirs"]),
    );
    expect(
      mine
        .list(Date.now())
        .map((e) => e.projectId)
        .sort(),
    ).toEqual(["mine", "theirs"]);
    first.stop();
    second.stop();
  });

  it("follows a rotation by saving the new links", async () => {
    relay();
    saveBinding(binding);
    const svc = service(newDirectory(1));
    svc.refresh();
    await vi.waitFor(() => expect(group.options).toHaveLength(1));

    const next = newProject().link.toBase64url();
    group.options[0]!.onRotated?.({
      link: next,
      token: "new-token",
      viewToken: "new-view",
      canEdit: true,
    });
    expect(loadBinding()).toEqual({
      spaceId: "personal",
      token: "new-token",
      secret: next,
    });
    svc.stop();
  });

  it("keeps syncing on the new token after a rotation", async () => {
    relay();
    saveBinding(binding);
    const svc = service(newDirectory(1));
    svc.refresh();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalledTimes(1));

    group.options[0]!.onRotated?.({
      link: secret,
      token: "new-token",
      viewToken: "new-view",
      canEdit: true,
    });
    await vi.waitFor(() =>
      expect(connectSpace).toHaveBeenLastCalledWith(
        expect.objectContaining({ token: "new-token" }),
      ),
    );
    svc.stop();
  });

  it("clears the binding but keeps the doc when the group removed this device", async () => {
    relay();
    saveBinding(binding);
    const dir = newDirectory(1);
    dir.addLink(link(1, "proj", { secret }));
    const svc = service(dir);
    svc.refresh();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalled());

    group.phase = "removed";
    for (const fn of [...group.listeners]) fn();
    await vi.waitFor(() => expect(loadBinding()).toBeNull());
    expect(svc.running).toBe(false);
    expect(dir.list(Date.now())).toHaveLength(1);
  });

  it("stops and warns when the space turns out not to be a directory", async () => {
    relay();
    saveBinding(binding);
    // Another device's space synced a project doc into this one.
    const foreign = newDirectory(9, false);
    foreign.doc.getMap("meta").set("kind", "project");
    foreign.doc.commit();
    relay();
    vi.mocked(connectSpace).mockImplementation(({ doc }) => {
      doc.import(foreign.doc.export({ mode: "update" }));
      return {
        getStatus: () => "connected",
        subscribe: (listener) => {
          listener("connected");
          return () => {};
        },
        synced: Promise.resolve(),
        syncNow: () => Promise.resolve("synced"),
        close: () => {},
      };
    });
    const dir = newDirectory(1, false);
    const svc = service(dir);
    svc.refresh();
    await vi.waitFor(() => expect(svc.running).toBe(false));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a directory"),
      expect.anything(),
    );
    // Does not come back for the same binding, and the binding stays.
    svc.refresh();
    expect(svc.running).toBe(false);
    expect(loadBinding()).toEqual(binding);
  });

  it("is refused before uploading when the space is not a directory", async () => {
    saveBinding(binding);
    const dir = newDirectory(1);
    dir.addLink(link(1, "proj", { secret }));
    const svc = service(dir);
    let accepted: boolean | undefined;
    vi.mocked(connectSpace).mockImplementation((o) => {
      // What the connection does once the backfill brought a project's kind.
      o.doc.getMap("meta").set("kind", "project");
      o.doc.commit();
      accepted = o.accept?.(o.doc);
      if (!accepted) queueMicrotask(() => o.onRefused?.());
      return {
        getStatus: () => "connecting",
        subscribe: () => () => {},
        synced: new Promise(() => {}),
        syncNow: () => Promise.resolve("offline"),
        close: () => {},
      };
    });
    svc.refresh();
    await vi.waitFor(() => expect(svc.running).toBe(false));
    expect(accepted).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a directory"),
      expect.anything(),
    );
    svc.refresh();
    expect(svc.running).toBe(false);
    expect(loadBinding()).toEqual(binding);
  });

  it("accepts a doc that is a directory or has no kind yet", async () => {
    saveBinding(binding);
    const dir = newDirectory(1, false);
    const svc = service(dir);
    let accept: (() => boolean | undefined) | undefined;
    vi.mocked(connectSpace).mockImplementation((o) => {
      accept = () => o.accept!(o.doc);
      return {
        getStatus: () => "connecting",
        subscribe: () => () => {},
        synced: new Promise(() => {}),
        syncNow: () => Promise.resolve("offline"),
        close: () => {},
      };
    });
    svc.refresh();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalled());
    expect(accept!()).toBe(true);
    dir.init();
    expect(accept!()).toBe(true);
    svc.stop();
  });

  it("stops when the binding is cleared elsewhere", async () => {
    relay();
    saveBinding(binding);
    const svc = service(newDirectory(1));
    svc.refresh();
    expect(svc.running).toBe(true);
    localStorage.clear();
    svc.refresh();
    expect(svc.running).toBe(false);
  });
});
