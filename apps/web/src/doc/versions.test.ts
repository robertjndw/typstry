import { UndoManager } from "loro-crdt";

import { getText, normalizeTitle, setTitle } from "./fs-ops";
import { versionAt } from "./restore";
import { initProject, PEER_INFO_ORIGIN, ROOT } from "./schema";
import { fork, newProject, sync } from "./test-utils";
import { deleteVersion, listVersions, saveVersion } from "./versions";

describe("named versions", () => {
  it("saves the current frontiers and syncs to other peers", () => {
    const a = initProject(newProject(1), { title: "T" });
    const main = a.mainFile!;
    getText(a, main).insert(0, "v1 ");
    a.doc.commit();
    const saved = saveVersion(a, "  Draft 1  ", { now: 1234 });
    expect(saved).toMatchObject({
      index: 0,
      name: "Draft 1",
      createdAt: 1234,
      author: "1",
    });

    getText(a, main).insert(0, "later ");
    a.doc.commit();
    const b = fork(a, 2);
    saveVersion(b, "From B");
    sync(a, b);

    const versions = listVersions(a);
    expect(versions.map((v) => v.name)).toEqual(["Draft 1", "From B"]);
    expect(versions[1]!.author).toBe("2");
    expect(versions[0]!.frontiers).toEqual(saved.frontiers);
    const old = versionAt(a, versions[0]!.frontiers);
    expect(getText(old, main).toString()).toMatch(/^v1 /);
  });

  it("is not undone with the user's edits", () => {
    const a = initProject(newProject(1), { title: "T" });
    const undo = new UndoManager(a.doc, {
      excludeOriginPrefixes: [PEER_INFO_ORIGIN],
    });
    getText(a, a.mainFile!).insert(0, "x");
    a.doc.commit();
    saveVersion(a, "v");
    undo.undo();
    expect(listVersions(a)).toHaveLength(1);
    expect(getText(a, a.mainFile!).toString()).not.toMatch(/^x/);
  });

  it("rejects bad names and skips malformed entries", () => {
    const a = initProject(newProject(1), { title: "T" });
    expect(() => saveVersion(a, "   ")).toThrow();
    expect(() => saveVersion(a, "x".repeat(101))).toThrow();
    a.doc.getList(ROOT.versions).push({ name: 3 });
    a.doc.commit();
    saveVersion(a, "ok");
    expect(listVersions(a).map((v) => [v.index, v.name])).toEqual([[1, "ok"]]);
  });
});

describe("project title", () => {
  it("syncs a rename between two docs", () => {
    const a = initProject(newProject(1), { title: "Old" });
    const b = fork(a, 2);
    setTitle(a, "  New name ");
    sync(a, b);
    expect(b.title).toBe("New name");
    const last = a.doc.getAllChanges().get("1")!.at(-1)!;
    expect(last.message).toBe("rename project");
  });

  it("validates like the server", () => {
    expect(normalizeTitle("  ")).toBeNull();
    expect(normalizeTitle("a".repeat(200))).toHaveLength(200);
    expect(normalizeTitle("a".repeat(201))).toBeNull();
    // Counted in code points: 200 emoji are 400 UTF-16 units but allowed.
    expect(normalizeTitle("😀".repeat(200))).not.toBeNull();
    const a = initProject(newProject(1), { title: "Old" });
    expect(() => setTitle(a, "")).toThrow();
    expect(a.title).toBe("Old");
  });

  it("deletes a version for every peer and keeps the others' indexes", () => {
    const a = initProject(newProject(1), { title: "T" });
    const first = saveVersion(a, "First");
    saveVersion(a, "Second");
    const b = fork(a, 2);

    deleteVersion(b, first, { now: 99 });
    sync(a, b);

    for (const project of [a, b]) {
      expect(listVersions(project).map((v) => [v.index, v.name])).toEqual([
        [1, "Second"],
      ]);
    }
    expect(a.deletedVersions.get(first.id)).toBe(99);
  });

  it("deletes the right one when saves were concurrent", () => {
    const a = initProject(newProject(1), { title: "T" });
    const b = fork(a, 2);
    // Both land at index 0 locally; after syncing one of them moves to 1.
    const fromA = saveVersion(a, "From A");
    saveVersion(b, "From B");
    expect(fromA.index).toBe(0);
    deleteVersion(a, fromA);
    sync(a, b);

    for (const project of [a, b]) {
      expect(listVersions(project).map((v) => v.name)).toEqual(["From B"]);
    }
  });

  it("is not undone with the user's edits either", () => {
    const a = initProject(newProject(1), { title: "T" });
    const undo = new UndoManager(a.doc, {
      excludeOriginPrefixes: [PEER_INFO_ORIGIN],
    });
    getText(a, a.mainFile!).insert(0, "x");
    a.doc.commit();
    deleteVersion(a, saveVersion(a, "v"));
    undo.undo();
    expect(listVersions(a)).toHaveLength(0);
  });
});
