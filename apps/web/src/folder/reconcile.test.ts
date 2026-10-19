import { describe, expect, it, vi } from "vitest";

import { createFile } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { applyChanges } from "./apply";
import { sameFrontiers as sameFronts, preview, reconcile } from "./reconcile";
import type { FolderBase } from "./base";
import { handleFs, type FolderFs } from "./folder-fs";
import { materialize } from "./materialize";
import {
  fakeAssets,
  fakeFolder,
  type FakeFolder,
  type FakeFolderOptions,
} from "./test-utils";

const BODY = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
// The NUL keeps it from passing as text.
const bytes = (...n: number[]) => new Uint8Array([0, ...n]);

function setup(
  files: Record<string, string | Uint8Array> = {},
  opts: FakeFolderOptions = {},
) {
  const folder = fakeFolder(files, opts);
  const inner = handleFs(folder.handle);
  const calls = { write: vi.fn(), remove: vi.fn() };
  const fs: FolderFs = {
    ...inner,
    write: async (path, data) => {
      calls.write(path);
      return inner.write(path, data);
    },
    remove: async (path) => {
      calls.remove(path);
      return inner.remove(path);
    },
  };
  const project = newProject(1);
  initProject(project, { title: "T", starter: false });
  const assets = fakeAssets();
  const state = {
    base: null as FolderBase | null,
    interrupted: undefined as unknown,
  };

  const run = async (extra: Partial<Parameters<typeof reconcile>[0]> = {}) => {
    const result = await reconcile({
      project,
      fs,
      assets,
      base: state.base,
      canWrite: true,
      ...extra,
    });
    state.base = result.base;
    state.interrupted = result.interrupted;
    return result.report;
  };
  // Another program saving a file: the mtime has to move.
  const save = (f: FakeFolder, path: string, content: string | Uint8Array) => {
    f.clock.advance();
    f.set(path, content);
  };
  const put = (path: string, text: string) =>
    applyChanges(project, new Map([[path, { kind: "text" as const, text }]]), {
      message: "remote edit",
    });
  const text = (path: string) => {
    const f = materialize(project).get(path);
    return f?.kind === "text" ? f.text : undefined;
  };
  return { folder, fs, calls, project, assets, state, run, save, put, text };
}

describe("reconcile: first link", () => {
  it("moves files that exist on one side only and drops identical ones", async () => {
    const t = setup({ "folder.typ": "f", "same.typ": "s" });
    t.put("project.typ", "p");
    t.put("same.typ", "s");
    const report = await t.run();
    expect(t.text("folder.typ")).toBe("f");
    expect(t.folder.text("project.typ")).toBe("p");
    expect(report.conflicts).toEqual([]);
    expect(report.written).toEqual(["project.typ"]);
    expect(t.state.base!.files["same.typ"]).toMatchObject({ kind: "text" });
  });

  it("keeps the folder version of a differing file and reports it", async () => {
    const t = setup({ "a.typ": "disk" });
    t.put("a.typ", "doc");
    const report = await t.run();
    expect(t.text("a.typ")).toBe("disk");
    expect(t.folder.text("a.typ")).toBe("disk");
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.typ"]);
  });

  it("project-wins writes the doc version over the disk file", async () => {
    const t = setup({ "a.typ": "disk", "only.typ": "mine" });
    t.put("a.typ", "doc");
    const report = await t.run({ mode: "project-wins" });
    expect(t.folder.text("a.typ")).toBe("doc");
    expect(t.text("a.typ")).toBe("doc");
    expect(t.text("only.typ")).toBe("mine");
    expect(report.conflicts).toEqual([]);
  });

  it("previews counts and touches nothing", async () => {
    const t = setup({ "a.typ": "disk", "same.typ": "s", "f.typ": "f" });
    t.put("a.typ", "doc");
    t.put("same.typ", "s");
    t.put("p.typ", "p");
    const before = t.project.doc.oplogFrontiers();
    const counts = await preview({
      project: t.project,
      fs: t.fs,
      assets: t.assets,
    });
    expect(counts).toEqual({
      onlyFolder: 1,
      onlyProject: 1,
      differing: ["a.typ"],
    });
    expect(sameFronts(before, t.project.doc.oplogFrontiers())).toBe(true);
    expect(t.calls.write).not.toHaveBeenCalled();
    expect(t.folder.files()).toEqual(["a.typ", "f.typ", "same.typ"]);
  });

  it("falls back to a first link when the base does not fit the doc", async () => {
    const t = setup({ "a.typ": "disk" });
    await t.run();
    const other = newProject(9);
    initProject(other, { title: "O", starter: false });
    applyChanges(other, new Map([["x.typ", { kind: "text", text: "x" }]]));
    // A base from a doc this one never saw.
    t.state.base = { ...t.state.base!, frontiers: other.doc.oplogFrontiers() };
    t.put("a.typ", "doc");
    const report = await t.run();
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.typ"]);
    expect(t.text("a.typ")).toBe("disk");
  });
});

describe("reconcile: one side changed", () => {
  it("copies doc edits, creations and deletions to the folder", async () => {
    const t = setup({ "a.typ": "a", "b.typ": "b" });
    await t.run();
    t.put("a.typ", "a2");
    t.put("c/new.typ", "c");
    applyChanges(t.project, new Map([["b.typ", { kind: "delete" }]]));
    const report = await t.run();
    expect(t.folder.text("a.typ")).toBe("a2");
    expect(t.folder.text("c/new.typ")).toBe("c");
    expect(t.folder.text("b.typ")).toBeUndefined();
    expect(report.written).toEqual(["a.typ", "c/new.typ"]);
    expect(report.deleted).toEqual(["b.typ"]);
  });

  it("copies folder edits, creations and deletions to the doc", async () => {
    const t = setup({ "a.typ": "a", "b.typ": "b" });
    await t.run();
    t.save(t.folder, "a.typ", "a2");
    t.save(t.folder, "d/new.typ", "d");
    t.folder.delete("b.typ");
    const report = await t.run();
    expect(t.text("a.typ")).toBe("a2");
    expect(t.text("d/new.typ")).toBe("d");
    expect(t.text("b.typ")).toBeUndefined();
    expect(report.applied?.changed).toBe(true);
    expect(report.conflicts).toEqual([]);
  });

  it("does not write or commit when nothing changed", async () => {
    const t = setup({ "a.typ": "a", "img.png": bytes(1, 2, 3) });
    await t.run();
    const frontiers = t.project.doc.oplogFrontiers();
    const stores = vi.mocked(t.assets.store).mock.calls.length;
    t.calls.write.mockClear();
    for (let i = 0; i < 2; i++) {
      const before = JSON.stringify(t.state.base);
      const report = await t.run();
      expect(JSON.stringify(t.state.base)).toBe(before);
      expect(report.applied).toBeNull();
      expect(report.written).toEqual([]);
    }
    expect(sameFronts(frontiers, t.project.doc.oplogFrontiers())).toBe(true);
    expect(t.calls.write).not.toHaveBeenCalled();
    expect(t.calls.remove).not.toHaveBeenCalled();
    expect(vi.mocked(t.assets.store).mock.calls.length).toBe(stores);
  });

  it("keeps the node when a file is renamed on disk", async () => {
    const t = setup({ "a.typ": BODY });
    await t.run();
    const id = buildPathIndex(t.project).byPath.get("a.typ");
    t.folder.delete("a.typ");
    t.save(t.folder, "b.typ", BODY);
    const report = await t.run();
    expect(buildPathIndex(t.project).byPath.get("b.typ")).toBe(id);
    expect(report.applied?.renamed).toEqual([{ from: "a.typ", to: "b.typ" }]);
  });

  it("creates folders the doc has but the disk lacks", async () => {
    const t = setup({ "a.typ": "a" });
    await t.run();
    createFile(t.project, null, "empty", "dir");
    await t.run();
    expect(t.folder.dirs()).toEqual(["empty"]);
  });
});

describe("reconcile: changed on both sides", () => {
  it("merges text edits to different places and writes the merge to disk", async () => {
    const t = setup({ "a.typ": BODY });
    await t.run();
    t.put("a.typ", `remote\n${BODY}`);
    t.save(t.folder, "a.typ", `${BODY}local\n`);
    const report = await t.run();
    const merged = `remote\n${BODY}local\n`;
    expect(t.text("a.typ")).toBe(merged);
    expect(t.folder.text("a.typ")).toBe(merged);
    expect(report.merged).toEqual(["a.typ"]);
    expect(report.conflicts).toEqual([]);
    // The next cycle sees nothing to do.
    const again = await t.run();
    expect(again.applied).toBeNull();
    expect(again.written).toEqual([]);
  });

  it("drops an identical change on both sides", async () => {
    const t = setup({ "a.typ": "a" });
    await t.run();
    t.put("a.typ", "same");
    t.save(t.folder, "a.typ", "same");
    t.calls.write.mockClear();
    const report = await t.run();
    expect(report.applied).toBeNull();
    expect(t.calls.write).not.toHaveBeenCalled();
    expect(report.conflicts).toEqual([]);
  });

  it("restores a file the folder edited and the project deleted", async () => {
    const t = setup({ "a.typ": "a" });
    await t.run();
    applyChanges(t.project, new Map([["a.typ", { kind: "delete" }]]));
    t.save(t.folder, "a.typ", "edited");
    const report = await t.run();
    expect(t.text("a.typ")).toBe("edited");
    expect(t.folder.text("a.typ")).toBe("edited");
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.typ"]);
  });

  it("restores a file the folder deleted and the project edited", async () => {
    const t = setup({ "a.typ": "a" });
    await t.run();
    t.put("a.typ", "edited");
    t.folder.delete("a.typ");
    const report = await t.run();
    expect(t.text("a.typ")).toBe("edited");
    expect(t.folder.text("a.typ")).toBe("edited");
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.typ"]);
  });

  it("does nothing when both sides deleted a file", async () => {
    const t = setup({ "a.typ": "a" });
    await t.run();
    applyChanges(t.project, new Map([["a.typ", { kind: "delete" }]]));
    t.folder.delete("a.typ");
    const report = await t.run();
    expect(report.conflicts).toEqual([]);
    expect(report.applied).toBeNull();
    expect(t.state.base!.files["a.typ"]).toBeUndefined();
  });

  it("takes the folder version of a binary edited on both sides", async () => {
    const t = setup({ "pic.png": bytes(1, 2, 3) });
    await t.run();
    t.assets.blobs.set("sha256:theirs", bytes(9, 9));
    applyChanges(
      t.project,
      new Map([
        [
          "pic.png",
          { kind: "asset", hash: "sha256:theirs", size: 2, mime: "image/png" },
        ],
      ]),
    );
    t.save(t.folder, "pic.png", bytes(4, 5, 6, 7));
    const report = await t.run();
    expect(report.conflicts.map((c) => c.path)).toEqual(["pic.png"]);
    expect([...t.folder.bytes("pic.png")!]).toEqual([...bytes(4, 5, 6, 7)]);
    const file = materialize(t.project).get("pic.png")!;
    expect(file).toMatchObject({ kind: "asset", hash: "sha256:pic.png" });
  });

  it("treats a node the project replaced as a conflict", async () => {
    const t = setup({ "a.typ": BODY });
    await t.run();
    applyChanges(t.project, new Map([["a.typ", { kind: "delete" }]]));
    t.put("a.typ", `${BODY}other\n`);
    t.save(t.folder, "a.typ", `${BODY}mine\n`);
    const report = await t.run();
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.typ"]);
    expect(t.text("a.typ")).toBe(`${BODY}mine\n`);
  });

  it("takes the folder version when a file changed type on one side", async () => {
    const t = setup({ "a.dat": "text" });
    await t.run();
    t.put("a.dat", "edited");
    t.save(t.folder, "a.dat", bytes(0, 1, 2));
    const report = await t.run();
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.dat"]);
    expect(materialize(t.project).get("a.dat")!.kind).toBe("asset");
  });
});

describe("reconcile: assets", () => {
  it("uploads a binary once however often its bytes appear", async () => {
    const t = setup({ "one.png": bytes(1, 2), "two.png": bytes(1, 2) });
    await t.run();
    expect(t.assets.store).toHaveBeenCalledTimes(1);
    t.save(t.folder, "three.png", bytes(1, 2));
    await t.run();
    expect(t.assets.store).toHaveBeenCalledTimes(1);
    expect(materialize(t.project).size).toBe(3);
  });

  it("writes project assets to the folder", async () => {
    const t = setup();
    await t.run();
    t.assets.blobs.set("sha256:x", bytes(7, 8));
    applyChanges(
      t.project,
      new Map([
        [
          "x.png",
          { kind: "asset", hash: "sha256:x", size: 2, mime: "image/png" },
        ],
      ]),
    );
    await t.run();
    expect([...t.folder.bytes("x.png")!]).toEqual([...bytes(7, 8)]);
    expect((await t.run()).applied).toBeNull();
  });

  it("keeps an uploaded svg as an asset when it is edited as text", async () => {
    const t = setup({ "logo.svg": bytes(0, 1) });
    await t.run();
    t.save(t.folder, "logo.svg", "<svg/>");
    await t.run();
    expect(materialize(t.project).get("logo.svg")!.kind).toBe("asset");
  });
});

describe("reconcile: files that are not synced", () => {
  it("never writes or deletes an ignored file", async () => {
    const t = setup({ ".gitignore": "*.aux\n", "x.aux": "mine", "a.typ": "a" });
    t.put("y.aux", "from project");
    t.put("x.aux", "from project");
    const report = await t.run();
    expect(t.folder.text("x.aux")).toBe("mine");
    expect(t.folder.text("y.aux")).toBeUndefined();
    expect(report.warnings.join("\n")).toMatch(/x\.aux/);
    // Removing it from the project leaves the ignored file alone too.
    applyChanges(t.project, new Map([["x.aux", { kind: "delete" }]]));
    await t.run();
    expect(t.folder.text("x.aux")).toBe("mine");
    expect(t.calls.remove).not.toHaveBeenCalledWith("x.aux");
  });

  it("does not treat a synced file that became ignored as deleted", async () => {
    const t = setup({ "a.typ": "a", "b.typ": "b" });
    await t.run();
    t.save(t.folder, ".typstryignore", "b.typ\n");
    await t.run();
    expect(t.text("b.typ")).toBe("b");
    expect(t.folder.text("b.typ")).toBe("b");
  });

  it("syncs only one of two paths that differ in case on a case-insensitive disk", async () => {
    const t = setup({ "a.typ": "a" }, { caseInsensitive: true });
    t.put("A.typ", "upper");
    const report = await t.run();
    expect(t.folder.files()).toEqual(["a.typ"]);
    expect(t.folder.text("a.typ")).toBe("a");
    expect(report.warnings.join("\n")).toMatch(/only in case/);
  });
});

describe("reconcile: interruptions", () => {
  it("pins a file that changed on disk during write-back and merges it next cycle", async () => {
    const t = setup({ "a.typ": BODY });
    await t.run();
    t.put("a.typ", `remote\n${BODY}`);
    let armed = true;
    const stat = t.fs.stat;
    t.fs.stat = async (path) => {
      if (armed && path === "a.typ") {
        armed = false;
        t.save(t.folder, "a.typ", `${BODY}local\n`);
      }
      return stat(path);
    };
    const report = await t.run();
    expect(report.warnings.join("\n")).toMatch(/changed on disk/);
    expect(t.folder.text("a.typ")).toBe(`${BODY}local\n`);
    expect(t.state.base!.files["a.typ"]!.at).toBeDefined();

    await t.run();
    const merged = `remote\n${BODY}local\n`;
    expect(t.text("a.typ")).toBe(merged);
    expect(t.folder.text("a.typ")).toBe(merged);
    expect(t.state.base!.files["a.typ"]!.at).toBeUndefined();
  });

  it("leaves the doc and base alone when aborted before the commit", async () => {
    const t = setup({ "a.typ": "a" });
    await t.run();
    const before = JSON.stringify(t.state.base);
    const frontiers = t.project.doc.oplogFrontiers();
    const controller = new AbortController();
    vi.mocked(t.assets.store).mockImplementationOnce(async () => {
      controller.abort();
      return { hash: "sha256:x", size: 1, mime: "image/png" };
    });
    t.save(t.folder, "new.png", bytes(1));
    t.save(t.folder, "a.typ", "a2");
    await expect(t.run({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(JSON.stringify(t.state.base)).toBe(before);
    expect(sameFronts(frontiers, t.project.doc.oplogFrontiers())).toBe(true);
    // Nothing was lost: the next cycle picks the edits up.
    await t.run();
    expect(t.text("a.typ")).toBe("a2");
  });
});

describe("reconcile: view-only", () => {
  it("never writes the doc, holds local edits and still receives the rest", async () => {
    const t = setup({ "a.typ": "a", "b.typ": "b" });
    await t.run();
    t.put("a.typ", "remote a");
    t.put("b.typ", "remote b");
    t.save(t.folder, "a.typ", "local a");
    t.save(t.folder, "new.typ", "new");
    const frontiers = t.project.doc.oplogFrontiers();
    const report = await t.run({ canWrite: false });
    expect(sameFronts(frontiers, t.project.doc.oplogFrontiers())).toBe(true);
    expect(report.heldLocal.sort()).toEqual(["a.typ", "new.typ"]);
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.typ"]);
    expect(t.folder.text("a.typ")).toBe("local a");
    expect(t.folder.text("b.typ")).toBe("remote b");
    // Still held on the next cycle, and applied once the link can write.
    expect((await t.run({ canWrite: false })).heldLocal).toContain("new.typ");
    await t.run();
    expect(t.text("new.typ")).toBe("new");
  });
});

describe("reconcile: failures after the commit", () => {
  const denied = () => new DOMException("denied", "NotAllowedError");

  it("keeps the base when permission is lost while writing a merge, and does not replay the edit", async () => {
    const t = setup({ "a.typ": BODY });
    await t.run();
    t.put("a.typ", `remote\n${BODY}`);
    t.save(t.folder, "a.typ", `${BODY}local\n`);
    const write = t.fs.write;
    t.fs.write = async () => {
      throw denied();
    };
    await t.run();
    expect(t.state.interrupted).toMatchObject({ name: "NotAllowedError" });
    // The doc has the merge, the disk still the old text.
    expect(t.text("a.typ")).toBe(`remote\n${BODY}local\n`);
    expect(t.folder.text("a.typ")).toBe(`${BODY}local\n`);
    expect(t.state.base!.files["a.typ"]).toMatchObject({
      text: `${BODY}local\n`,
    });

    t.fs.write = write;
    await t.run();
    expect(t.state.interrupted).toBeUndefined();
    expect(t.text("a.typ")).toBe(`remote\n${BODY}local\n`);
    expect(t.folder.text("a.typ")).toBe(`remote\n${BODY}local\n`);
    expect(t.state.base!.files["a.typ"]).not.toHaveProperty("text");
  });

  it("returns the base when a removal fails", async () => {
    const t = setup({ "a.typ": "a", "b.typ": "b" });
    await t.run();
    applyChanges(t.project, new Map([["b.typ", { kind: "delete" }]]));
    t.put("a.typ", "a2");
    t.fs.remove = async () => {
      throw denied();
    };
    await t.run();
    expect(t.state.interrupted).toBeDefined();
    expect(t.folder.text("b.typ")).toBe("b");
    expect(t.state.base!.files["b.typ"]).toBeDefined();
  });

  it("merges a disk edit made between the check and the write without repeating either edit", async () => {
    const t = setup({ "a.typ": BODY });
    await t.run();
    t.put("a.typ", `remote\n${BODY}`);
    t.save(t.folder, "a.typ", `${BODY}local\n`);
    const stat = t.fs.stat;
    let calls = 0;
    t.fs.stat = async (path) => {
      // The first call is the check before the commit, the second the one
      // right before the write.
      if (path === "a.typ" && ++calls === 2) {
        t.save(t.folder, "a.typ", `${BODY}local\nlater\n`);
      }
      return stat(path);
    };
    const report = await t.run();
    expect(report.warnings.join("\n")).toMatch(/changed on disk/);
    expect(t.folder.text("a.typ")).toBe(`${BODY}local\nlater\n`);

    await t.run();
    const merged = `remote\n${BODY}local\nlater\n`;
    expect(t.text("a.typ")).toBe(merged);
    expect(t.folder.text("a.typ")).toBe(merged);
    expect((await t.run()).applied).toBeNull();
  });
});
