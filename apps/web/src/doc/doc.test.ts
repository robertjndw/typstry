// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createAsset,
  createFile,
  deleteNode,
  FsError,
  getText,
  move,
  rename,
  setMainFile,
} from "./fs-ops";
import {
  buildPathIndex,
  compareTreeIds,
  disambiguatedName,
  type PathIndex,
} from "./paths";
import { DEFAULT_MAIN_FILE, initProject, SCHEMA_VERSION } from "./schema";
import { fork, newProject, sync } from "./test-utils";

function paths(index: PathIndex): [string, string][] {
  return [...index.byPath].sort(([a], [b]) => (a < b ? -1 : 1));
}

function expectFsError(fn: () => unknown, code: FsError["code"]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FsError);
    expect((err as FsError).code).toBe(code);
    return;
  }
  throw new Error(`expected FsError ${code}`);
}

describe("initProject", () => {
  it("creates main.typ and is idempotent", () => {
    const project = newProject(1);
    initProject(project, { title: "Thesis" });
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.title).toBe("Thesis");
    expect(project.fs.isFractionalIndexEnabled()).toBe(false);
    const main = project.mainFile;
    expect(main).not.toBeNull();
    expect(buildPathIndex(project).byId.get(main!)).toEqual({
      path: DEFAULT_MAIN_FILE,
      kind: "text",
      renamed: false,
    });
    expect(getText(project, main!).toString()).toContain("= Thesis");

    initProject(project.doc, { title: "Other" });
    expect(project.title).toBe("Thesis");
    expect(project.fs.getNodes()).toHaveLength(1);
  });
});

describe("paths", () => {
  it("disambiguates names as specified", () => {
    expect(disambiguatedName("main.typ", "3@42")).toBe("main~3@42.typ");
    expect(disambiguatedName(".gitignore", "3@42")).toBe(".gitignore~3@42");
    expect(disambiguatedName("archive.tar.gz", "0@7")).toBe(
      "archive.tar~0@7.gz",
    );
    expect(disambiguatedName("Makefile", "1@2")).toBe("Makefile~1@2");
  });

  it("orders tree ids by unsigned peer, then counter", () => {
    expect(compareTreeIds("5@9", "0@10")).toBeLessThan(0);
    expect(compareTreeIds("0@9223372036854775813", "9@10")).toBeGreaterThan(0);
    expect(compareTreeIds("1@3", "2@3")).toBeLessThan(0);
  });

  it("builds nested paths and skips deleted nodes", () => {
    const p = newProject(1);
    const dir = createFile(p, null, "chapters", "dir");
    const intro = createFile(p, dir, "intro.typ", "text");
    const gone = createFile(p, dir, "old.typ", "text");
    deleteNode(p, gone);
    const index = buildPathIndex(p);
    expect(paths(index)).toEqual([
      ["chapters", dir],
      ["chapters/intro.typ", intro],
    ]);
    expect(index.byId.has(gone)).toBe(false);
  });
});

describe("validation", () => {
  it("rejects bad names", () => {
    const p = newProject(1);
    for (const name of [
      "",
      ".",
      "..",
      "a/b",
      "tab\there",
      "nul\u0000",
      "\u0085",
      "x".repeat(256),
    ]) {
      expectFsError(() => createFile(p, null, name, "text"), "invalid-name");
    }
    // 255 bytes is fine even when it is fewer characters.
    createFile(p, null, "é".repeat(127) + "x", "text");
    expectFsError(
      () => createFile(p, null, "é".repeat(128), "text"),
      "invalid-name",
    );
  });

  it("rejects local name clashes on create, rename and move", () => {
    const p = newProject(1);
    const a = createFile(p, null, "a.typ", "text");
    const dir = createFile(p, null, "d", "dir");
    createFile(p, dir, "a.typ", "text");
    const inner = createFile(p, dir, "b.typ", "text");
    expectFsError(() => createFile(p, null, "a.typ", "text"), "name-taken");
    expectFsError(
      () => createAsset(p, null, "a.typ", { hash: "h", size: 1, mime: "x" }),
      "name-taken",
    );
    expectFsError(() => rename(p, inner, "a.typ"), "name-taken");
    expectFsError(() => move(p, a, dir), "name-taken");
    rename(p, a, "a.typ");
    expect(buildPathIndex(p).byId.get(a)?.path).toBe("a.typ");
  });

  it("rejects non-directory parents, missing nodes and cycles", () => {
    const p = newProject(1);
    const file = createFile(p, null, "f.typ", "text");
    const outer = createFile(p, null, "outer", "dir");
    const inner = createFile(p, outer, "inner", "dir");
    expectFsError(() => createFile(p, file, "x", "text"), "not-a-directory");
    expectFsError(() => move(p, outer, inner), "cycle");
    expectFsError(() => move(p, outer, outer), "cycle");
    deleteNode(p, inner);
    expectFsError(() => move(p, file, inner), "not-found");
    expectFsError(() => rename(p, inner, "y"), "not-found");
    expectFsError(() => getText(p, outer), "not-a-text-file");
    expectFsError(() => setMainFile(p, outer), "not-a-text-file");
  });
});

describe("main file", () => {
  it("is cleared when the file or an ancestor is deleted", () => {
    const p = initProject(newProject(1), { title: "T" });
    deleteNode(p, p.mainFile!);
    expect(p.mainFile).toBeNull();
    expect(p.meta.get("mainFile")).toBeNull();

    const dir = createFile(p, null, "src", "dir");
    const file = createFile(p, dir, "main.typ", "text");
    setMainFile(p, file);
    expect(p.mainFile).toBe(file);
    deleteNode(p, dir);
    expect(p.mainFile).toBeNull();
  });

  it("reads as null when a remote peer deletes it", () => {
    const a = initProject(newProject(1), { title: "T" });
    const b = fork(a, 2);
    b.fs.delete(a.mainFile!);
    b.doc.commit();
    sync(a, b);
    expect(a.mainFile).toBeNull();
  });
});

describe("concurrency", () => {
  it("converges concurrent edits to the same text", () => {
    const a = initProject(newProject(1), { title: "T" });
    const b = fork(a, 2);
    const id = a.mainFile!;
    getText(a, id).insert(0, "A");
    a.doc.commit();
    const tb = getText(b, id);
    tb.insert(tb.length, "B");
    b.doc.commit();
    sync(a, b);
    const text = getText(a, id).toString();
    expect(text).toBe(getText(b, id).toString());
    expect(text.startsWith("A")).toBe(true);
    expect(text.endsWith("B")).toBe(true);
  });

  it("converges concurrent rename and move", () => {
    const a = newProject(1);
    const dir = createFile(a, null, "dir", "dir");
    const file = createFile(a, null, "x.typ", "text");
    const b = fork(a, 2);
    rename(a, file, "y.typ");
    move(b, file, dir);
    sync(a, b);
    expect(paths(buildPathIndex(a))).toEqual(paths(buildPathIndex(b)));
    expect(buildPathIndex(a).byId.get(file)?.path).toBe("dir/y.typ");
  });

  it("disambiguates concurrent creates of the same name identically", () => {
    const a = newProject(10);
    const b = fork(a, 9);
    const fa = createFile(a, null, "main.typ", "text");
    const fb = createFile(b, null, "main.typ", "text");
    sync(a, b);
    const ia = buildPathIndex(a);
    expect(paths(ia)).toEqual(paths(buildPathIndex(b)));
    // Peer 9 sorts before peer 10 numerically, even though "10" < "9" as text.
    expect(ia.byId.get(fb)).toEqual({
      path: "main.typ",
      kind: "text",
      renamed: false,
    });
    expect(ia.byId.get(fa)).toEqual({
      path: disambiguatedName("main.typ", fa),
      kind: "text",
      renamed: true,
    });
  });

  it("converges crossing moves that would form a cycle", () => {
    const a = newProject(1);
    const x = createFile(a, null, "x", "dir");
    const y = createFile(a, null, "y", "dir");
    const b = fork(a, 2);
    move(a, x, y);
    move(b, y, x);
    sync(a, b);
    const ia = paths(buildPathIndex(a));
    expect(ia).toEqual(paths(buildPathIndex(b)));
    // Exactly one of the moves wins; both dirs stay reachable.
    expect(ia.map(([path]) => path).sort()).toSatisfy(
      (list: string[]) =>
        JSON.stringify(list) === JSON.stringify(["x", "x/y"]) ||
        JSON.stringify(list) === JSON.stringify(["y", "y/x"]),
    );
  });
});
