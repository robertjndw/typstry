// @vitest-environment node
// Cross-language checks against crates/typstry-doc/tests/fixture.rs. The
// clash snapshot is read there and must derive the same paths; the version
// snapshots go both ways, so each side reads a version the other one saved.
// Regenerate with `pnpm --filter web fixtures` after changing a scenario.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  createFile,
  deleteNode,
  FsError,
  move,
  rename,
  validateName,
} from "./fs-ops";
import { buildPathIndex, type PathIndex } from "./paths";
import { initProject, ProjectDoc } from "./schema";
import { fork, newProject, sync } from "./test-utils";
import { listVersions, saveVersion } from "./versions";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../crates/typstry-doc/tests/fixtures",
);
const SNAPSHOT = path.join(FIXTURES, "clash.loro");
const EXPECTED = path.join(FIXTURES, "clash.paths.json");
const JS_VERSION = path.join(FIXTURES, "version.js.loro");
// Written by crates/typstry-doc/tests/fixture.rs.
const RUST_VERSION = path.join(FIXTURES, "version.rust.loro");

// Peers 9 and 10 sort differently as text and as numbers, and the third one
// is above i64::MAX, so a signed or lexicographic comparison breaks the test.
const PEER_A = 10n;
const PEER_B = 9n;
const PEER_C = 9223372036854775813n;

function findId(index: PathIndex, p: string) {
  const id = index.byPath.get(p);
  if (!id) throw new Error(`missing ${p}`);
  return id;
}

function buildScenario(): ProjectDoc {
  const a = initProject(newProject(PEER_A), { title: "Clash" });
  const chapters = createFile(a, null, "chapters", "dir");
  const intro = createFile(a, chapters, "intro.typ", "text");
  const figs = createFile(a, null, "figs", "dir");
  createFile(a, figs, "plot.svg", "text");

  const b = fork(a, PEER_B);
  const c = fork(a, PEER_C);

  createFile(a, chapters, "notes.typ", "text");
  createFile(b, chapters, "notes.typ", "text");
  createFile(c, chapters, "notes.typ", "text");

  createFile(a, null, ".gitignore", "text");
  createFile(c, null, ".gitignore", "text");

  rename(a, intro, "introduction.typ");
  move(b, intro, null);

  rename(a, figs, "images");
  createFile(b, figs, "diagram.svg", "text");

  createFile(b, null, "refs.bib", "text");
  createFile(a, null, "refs.bib", "text");
  createFile(c, null, "Makefile", "text");
  createFile(a, null, "Makefile", "dir");
  deleteNode(c, findId(buildPathIndex(c), "figs/plot.svg"));

  sync(a, b, c);
  return a;
}

function pathList(index: PathIndex) {
  return [...index.byId]
    .map(([id, entry]) => ({
      path: entry.path,
      id,
      kind: entry.kind,
      renamed: entry.renamed,
    }))
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

describe("clash fixture", () => {
  it.runIf(process.env.TYPSTRY_WRITE_FIXTURES === "1")(
    "regenerates the fixture",
    () => {
      const project = buildScenario();
      writeFileSync(SNAPSHOT, project.doc.export({ mode: "snapshot" }));
      writeFileSync(
        EXPECTED,
        JSON.stringify(pathList(buildPathIndex(project)), null, 2) + "\n",
      );
    },
  );

  it("matches the committed snapshot", () => {
    const doc = new LoroDoc();
    doc.import(readFileSync(SNAPSHOT));
    const expected: unknown = JSON.parse(readFileSync(EXPECTED, "utf8"));
    expect(pathList(buildPathIndex(doc))).toEqual(expected);
    expect(pathList(buildPathIndex(buildScenario()))).toEqual(expected);
  });
});

describe("version fixture", () => {
  it.runIf(process.env.TYPSTRY_WRITE_FIXTURES === "1")(
    "regenerates the JS-saved version",
    () => {
      const project = initProject(newProject(10n), { title: "From JS" });
      saveVersion(project, " Draft from JS ", { now: 1700000000123 });
      writeFileSync(JS_VERSION, project.doc.export({ mode: "snapshot" }));
    },
  );

  it("reads a version saved by Rust", () => {
    const doc = new LoroDoc();
    doc.import(readFileSync(RUST_VERSION));
    const project = new ProjectDoc(doc);
    const versions = listVersions(project);
    expect(versions).toHaveLength(1);
    const [version] = versions;
    expect(version).toMatchObject({
      index: 0,
      name: "Draft from Rust",
      createdAt: 1700000000456,
      author: "7",
    });
    // The frontiers name the state before the version entry was added.
    const old = new ProjectDoc(doc.forkAt(version!.frontiers));
    expect(old.title).toBe("From Rust");
    expect(old.versions.length).toBe(0);
  });
});

// names.json is hand-written; Rust checks the same lists against its rules.
describe("name fixture", () => {
  const names = JSON.parse(
    readFileSync(path.join(FIXTURES, "names.json"), "utf8"),
  ) as { valid: string[]; invalid: string[] };

  it.each(names.valid)("accepts %j", (name) => {
    expect(() => validateName(name)).not.toThrow();
  });

  it.each(names.invalid)("rejects %j", (name) => {
    expect(() => validateName(name)).toThrow(FsError);
  });
});
