import { UndoManager } from "loro-crdt";

import { createFile, deleteNode, getText } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";

import { UNDO_MERGE_INTERVAL_MS } from "@/project/store";

import { replaceMatches } from "./replace";
import { searchProject, type SearchQuery } from "./search";

const q = (pattern: string, rest: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...rest,
});

function setup(contents: Record<string, string>) {
  const project = initProject(newProject(1), { title: "T" });
  const ids = new Map<string, ReturnType<typeof createFile>>();
  for (const [name, text] of Object.entries(contents))
    ids.set(name, createFile(project, null, name, "text", text));
  return { project, ids };
}

function search(
  project: ProjectDoc,
  ids: Map<string, ReturnType<typeof createFile>>,
  query: SearchQuery,
) {
  const inputs = [...ids].map(([path, fileId]) => ({
    fileId,
    path,
    text: getText(project, fileId).toString(),
  }));
  const result = searchProject(inputs, query);
  if ("error" in result) throw new Error(result.error);
  return result.files;
}

const read = (p: ProjectDoc, id: ReturnType<typeof createFile>) =>
  getText(p, id).toString();

describe("replaceMatches", () => {
  it("replaces across files", () => {
    const { project, ids } = setup({
      "a.typ": "foo bar",
      "b.typ": "bar foo foo",
    });
    const query = q("foo");
    const files = search(project, ids, query);
    expect(replaceMatches(project, files, "baz", query)).toEqual({
      replaced: 3,
      skipped: 0,
    });
    expect(read(project, ids.get("a.typ")!)).toBe("baz bar");
    expect(read(project, ids.get("b.typ")!)).toBe("bar baz baz");
  });

  it("keeps offsets valid with several matches per line and length changes", () => {
    const { project, ids } = setup({ "a.typ": "😀 aa aa\naa" });
    const query = q("aa");
    replaceMatches(project, search(project, ids, query), "longer", query);
    expect(read(project, ids.get("a.typ")!)).toBe("😀 longer longer\nlonger");
    const shrink = q("longer");
    replaceMatches(project, search(project, ids, shrink), "", shrink);
    expect(read(project, ids.get("a.typ")!)).toBe("😀  \n");
  });

  it("skips a match a collaborator changed", () => {
    const { project, ids } = setup({ "a.typ": "foo foo" });
    const query = q("foo");
    const files = search(project, ids, query);
    const remote = fork(project, 2);
    getText(remote, ids.get("a.typ")!).update("fox foo");
    remote.doc.commit();
    sync(project, remote);
    expect(replaceMatches(project, files, "X", query)).toEqual({
      replaced: 1,
      skipped: 1,
    });
    expect(read(project, ids.get("a.typ")!)).toBe("fox X");
  });

  it("expands captures in regex mode", () => {
    const { project, ids } = setup({ "a.typ": "k1=v1 k2=v2 ab" });
    const query = q("(?<key>k\\d)=(v\\d)", { regex: true });
    replaceMatches(
      project,
      search(project, ids, query),
      "$2:$<key>[$&]",
      query,
    );
    expect(read(project, ids.get("a.typ")!)).toBe(
      "v1:k1[k1=v1] v2:k2[k2=v2] ab",
    );
  });

  it("applies anchors and lookarounds in context", () => {
    const { project, ids } = setup({ "a.typ": "ab\nab" });
    const query = q("^a(?=b)", { regex: true });
    // "m" is not a search flag, so ^ only matches the file start.
    replaceMatches(project, search(project, ids, query), "X", query);
    expect(read(project, ids.get("a.typ")!)).toBe("Xb\nab");
  });

  it("inserts the replacement verbatim in literal mode", () => {
    const { project, ids } = setup({ "a.typ": "foo" });
    const query = q("foo");
    replaceMatches(project, search(project, ids, query), "$1 $& $$", query);
    expect(read(project, ids.get("a.typ")!)).toBe("$1 $& $$");
  });

  it("skips files that are gone", () => {
    const { project, ids } = setup({ "a.typ": "foo", "b.typ": "foo" });
    const query = q("foo");
    const files = search(project, ids, query);
    deleteNode(project, ids.get("b.typ")!);
    expect(replaceMatches(project, files, "x", query)).toEqual({
      replaced: 1,
      skipped: 1,
    });
  });

  it("is one undo step for all files", () => {
    const { project, ids } = setup({ "a.typ": "foo", "b.typ": "foo foo" });
    const undo = new UndoManager(project.doc, {});
    const query = q("foo");
    replaceMatches(project, search(project, ids, query), "bar", query);
    expect(read(project, ids.get("b.typ")!)).toBe("bar bar");
    undo.undo();
    expect(read(project, ids.get("a.typ")!)).toBe("foo");
    expect(read(project, ids.get("b.typ")!)).toBe("foo foo");
  });

  it("is its own undo step even right after typing", () => {
    const { project, ids } = setup({ "a.typ": "" });
    const undo = new UndoManager(project.doc, {
      mergeInterval: UNDO_MERGE_INTERVAL_MS,
    });
    const text = getText(project, ids.get("a.typ")!);
    text.insert(0, "foo there");
    project.doc.commit();
    const query = q("foo");
    replaceMatches(project, search(project, ids, query), "bar", query, {
      undoManager: undo,
    });
    expect(read(project, ids.get("a.typ")!)).toBe("bar there");
    undo.undo();
    expect(read(project, ids.get("a.typ")!)).toBe("foo there");
    // The interval is back, so ordinary typing still merges.
    text.insert(0, "a");
    project.doc.commit();
    text.insert(0, "b");
    project.doc.commit();
    undo.undo();
    expect(read(project, ids.get("a.typ")!)).toBe("foo there");
  });

  it("keeps the next keystroke out of the replace step", () => {
    const { project, ids } = setup({ "a.typ": "" });
    const undo = new UndoManager(project.doc, {
      mergeInterval: UNDO_MERGE_INTERVAL_MS,
    });
    const text = getText(project, ids.get("a.typ")!);
    text.insert(0, "foo there");
    project.doc.commit();
    const query = q("foo");
    replaceMatches(project, search(project, ids, query), "bar", query, {
      undoManager: undo,
    });
    text.insert(9, "!");
    project.doc.commit();
    undo.undo();
    expect(read(project, ids.get("a.typ")!)).toBe("bar there");
    undo.undo();
    expect(read(project, ids.get("a.typ")!)).toBe("foo there");
  });

  it("skips a literal whole-word match that stopped being one", () => {
    const { project, ids } = setup({ "a.typ": "foo bar" });
    const query = q("foo", { wholeWord: true });
    const files = search(project, ids, query);
    getText(project, ids.get("a.typ")!).insert(3, "s");
    project.doc.commit();
    expect(replaceMatches(project, files, "x", query)).toEqual({
      replaced: 0,
      skipped: 1,
    });
  });

  it("expands replacement patterns like String.replace", () => {
    const { project, ids } = setup({ "a.typ": "<ab>" });
    const query = q("(a)(b)", { regex: true });
    const replacement = "$$|$0|$1$2|$12|$3|$`|$'|$<n>|$x|$";
    replaceMatches(project, search(project, ids, query), replacement, query);
    expect(read(project, ids.get("a.typ")!)).toBe(
      "<ab>".replace(/(a)(b)/u, replacement),
    );
  });
});
