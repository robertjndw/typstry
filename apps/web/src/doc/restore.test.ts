import { UndoManager, type OpId } from "loro-crdt";

import {
  createAsset,
  createFile,
  deleteNode,
  getText,
  move,
  rename,
  setMainFile,
  setTitle,
} from "./fs-ops";
import { buildPathIndex } from "./paths";
import {
  compareVersions,
  fileText,
  restoreVersion,
  RESTORE_ORIGIN,
  versionAt,
} from "./restore";
import { initProject, PEER_INFO_ORIGIN, type ProjectDoc } from "./schema";
import { fork, newProject, sync } from "./test-utils";
import { listVersions, saveVersion } from "./versions";

/** Path -> text (or asset hash), the observable state of a project. */
function files(project: ProjectDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, id] of buildPathIndex(project).byPath) {
    const node = project.fs.getNodeByID(id)!;
    const kind = node.data.get("kind");
    out[path] =
      kind === "dir"
        ? "<dir>"
        : kind === "asset"
          ? `<asset ${String(node.data.get("hash"))}>`
          : (fileText(project, id) ?? "");
  }
  return out;
}

function mainPath(project: ProjectDoc): string | null {
  const main = project.mainFile;
  return main ? buildPathIndex(project).byId.get(main)!.path : null;
}

function expectRestored(project: ProjectDoc, frontiers: OpId[]) {
  const version = versionAt(project, frontiers);
  restoreVersion(project, version, "test");
  expect(files(project)).toEqual(files(version));
  expect(mainPath(project)).toBe(mainPath(version));
  // A version from before the project was set up has no title; keeping the
  // current one beats blanking it.
  expect(project.title).toBe(version.title || project.title);
}

function setup() {
  const a = initProject(newProject(1), { title: "Paper" });
  const dir = createFile(a, null, "chapters", "dir");
  const intro = createFile(a, dir, "intro.typ", "text", "= Intro\n");
  const logo = createAsset(a, dir, "logo.png", {
    hash: "h1",
    size: 3,
    mime: "image/png",
  });
  return { a, dir, intro, logo, v1: a.doc.oplogFrontiers() };
}

describe("restoreVersion", () => {
  it("reverts text edits in place, keeping the file's id", () => {
    const { a, intro, v1 } = setup();
    getText(a, intro).insert(0, "changed ");
    a.doc.commit();
    expectRestored(a, v1);
    expect(getText(a, intro).toString()).toBe("= Intro\n");
  });

  it("recreates deleted files and folders with their contents", () => {
    const { a, dir, v1 } = setup();
    deleteNode(a, dir);
    deleteNode(a, a.mainFile!);
    expect(Object.keys(files(a))).toEqual([]);
    expectRestored(a, v1);
    expect(a.mainFile).not.toBeNull();
  });

  it("deletes files that did not exist and undoes renames and moves", () => {
    const { a, dir, intro, logo, v1 } = setup();
    createFile(a, null, "extra.typ", "text", "x");
    const other = createFile(a, null, "other", "dir");
    move(a, intro, other);
    rename(a, intro, "renamed.typ");
    rename(a, dir, "chaps");
    move(a, dir, other);
    setTitle(a, "New title");
    setMainFile(a, intro);
    expectRestored(a, v1);
    expect(a.title).toBe("Paper");
    expect(buildPathIndex(a).byId.get(intro)!.path).toBe("chapters/intro.typ");
    expect(buildPathIndex(a).byId.get(logo)!.path).toBe("chapters/logo.png");
  });

  it("swaps nested folders back without cycles", () => {
    const a = initProject(newProject(1), { title: "T" });
    const outer = createFile(a, null, "outer", "dir");
    const inner = createFile(a, outer, "inner", "dir");
    createFile(a, inner, "f.typ", "text", "f");
    const v1 = a.doc.oplogFrontiers();
    move(a, inner, null);
    move(a, outer, inner);
    expect(Object.keys(files(a))).toContain("inner/outer");
    expectRestored(a, v1);
  });

  it("restores asset references and replaces a file whose kind changed", () => {
    const { a, logo, intro, v1 } = setup();
    a.fs.getNodeByID(logo)!.data.set("hash", "h2");
    a.doc.commit();
    deleteNode(a, intro);
    const dir = buildPathIndex(a).byPath.get("chapters")!;
    createFile(a, dir, "intro.typ", "dir");
    expectRestored(a, v1);
    expect(files(a)["chapters/logo.png"]).toBe("<asset h1>");
  });

  it("converges for a concurrent peer and is one change for everyone", () => {
    const { a, intro, v1 } = setup();
    const b = fork(a, 2);
    getText(b, intro).insert(0, "B was here ");
    b.doc.commit();
    createFile(b, null, "b.typ", "text", "b");
    sync(a, b);
    deleteNode(a, intro);
    sync(a, b);

    const before = a.doc.oplogVersion().get("1") ?? 0;
    expectRestored(a, v1);
    sync(a, b);
    expect(files(b)).toEqual(files(a));
    expect(mainPath(b)).toBe(mainPath(a));
    const restoreChanges = a.doc
      .getAllChanges()
      .get("1")!
      .filter((c) => c.counter >= before);
    expect(restoreChanges).toHaveLength(1);
    expect(restoreChanges[0]!.message).toBe("Restore version test");
  });

  it("works while a peer edits concurrently with the restore", () => {
    const { a, intro, v1 } = setup();
    getText(a, intro).insert(0, "draft ");
    a.doc.commit();
    const b = fork(a, 2);
    // b keeps typing while a restores; both edits survive the merge.
    getText(b, intro).insert(getText(b, intro).length, "tail");
    b.doc.commit();
    restoreVersion(a, versionAt(a, v1), "v1");
    sync(a, b);
    expect(getText(a, intro).toString()).toBe("= Intro\ntail");
    expect(files(a)).toEqual(files(b));
  });

  it("keeps named versions and peer info", () => {
    const { a, v1 } = setup();
    a.setPeer("1", { name: "Ada", color: "#000" });
    saveVersion(a, "later");
    expectRestored(a, v1);
    expect(listVersions(a).map((v) => v.name)).toEqual(["later"]);
    expect(a.getPeer("1")?.name).toBe("Ada");
  });

  it("turns an old same-name clash into two distinct names", () => {
    const a = initProject(newProject(1), { title: "T" });
    const b = fork(a, 2);
    createFile(a, null, "x.typ", "text", "a");
    createFile(b, null, "x.typ", "text", "b");
    sync(a, b);
    const clash = a.doc.oplogFrontiers();
    expect(Object.keys(files(a))).toContain("x~0@2.typ");
    for (const id of [...buildPathIndex(a).byPath.values()]) {
      const entry = buildPathIndex(a).byId.get(id)!;
      if (entry.path.startsWith("x")) deleteNode(a, id);
    }
    expectRestored(a, clash);
  });

  it("is a single undo step", () => {
    const { a, intro, v1 } = setup();
    const undo = new UndoManager(a.doc, {
      excludeOriginPrefixes: [PEER_INFO_ORIGIN],
      mergeInterval: 0,
    });
    getText(a, intro).insert(0, "edit ");
    a.doc.commit();
    deleteNode(a, a.mainFile!);
    const edited = files(a);
    restoreVersion(a, versionAt(a, v1), "v1");
    expect(undo.undo()).toBe(true);
    expect(files(a)).toEqual(edited);
    expect(RESTORE_ORIGIN).not.toMatch(PEER_INFO_ORIGIN);
  });

  it("can restore the empty version", () => {
    const { a } = setup();
    expectRestored(a, []);
    expect(Object.keys(files(a))).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("lists added, deleted, modified and renamed files", () => {
    const { a, dir, intro, v1 } = setup();
    getText(a, intro).insert(0, "x");
    a.doc.commit();
    rename(a, intro, "start.typ");
    createFile(a, null, "new.typ", "text");
    deleteNode(a, a.mainFile!);
    const sub = createFile(a, dir, "sub", "dir");
    createFile(a, sub, "deep.typ", "text");
    const before = versionAt(a, v1);
    const after = versionAt(a, a.doc.oplogFrontiers());
    expect(
      compareVersions(before, after).map((c) => [c.path, c.changes, c.oldPath]),
    ).toEqual([
      ["chapters/start.typ", ["renamed", "modified"], "chapters/intro.typ"],
      ["chapters/sub", ["added"], null],
      ["chapters/sub/deep.typ", ["added"], null],
      ["main.typ", ["deleted"], "main.typ"],
      ["new.typ", ["added"], null],
    ]);
  });

  it("collapses a deleted folder into one entry", () => {
    const { a, dir, v1 } = setup();
    deleteNode(a, dir);
    const changes = compareVersions(
      versionAt(a, v1),
      versionAt(a, a.doc.oplogFrontiers()),
    );
    expect(changes.map((c) => c.path)).toEqual(["chapters"]);
  });
});
