import { LoroText } from "loro-crdt";
import { describe, expect, it } from "vitest";

import { createFile, getText } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject, META, NODE, type ProjectDoc } from "@/doc/schema";
import { newProject, sync } from "@/doc/test-utils";

import { applyChanges, replaceText, type Change } from "./apply";
import { materialize } from "./materialize";

const text = (body: string): Change => ({ kind: "text", text: body });
const asset = (hash: string): Change => ({
  kind: "asset",
  hash,
  size: 3,
  mime: "image/png",
});
const gone: Change = { kind: "delete" };

function project(): ProjectDoc {
  const p = newProject(1);
  initProject(p, { title: "T" });
  return p;
}

function idOf(p: ProjectDoc, path: string) {
  return buildPathIndex(p).byPath.get(path)!;
}

function apply(p: ProjectDoc, entries: Record<string, Change>) {
  return applyChanges(p, new Map(Object.entries(entries)), {
    message: "test apply",
  });
}

describe("applyChanges", () => {
  it("is a no-op for the current state", () => {
    const p = project();
    const vv = p.doc.oplogVersion().toJSON();
    const entries: Record<string, Change> = {};
    for (const [path, f] of materialize(p))
      entries[path] = f.kind === "text" ? text(f.text) : asset(f.hash);
    entries["gone.typ"] = gone;
    entries["nodir"] = gone;
    const report = apply(p, entries);
    expect(report).toEqual({
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
      skipped: [],
      changed: false,
    });
    expect(p.doc.oplogVersion().toJSON()).toEqual(vv);
  });

  it("creates, modifies and deletes in one commit", () => {
    const p = project();
    const main = idOf(p, "main.typ");
    createFile(p, null, "empty", "dir");
    const report = apply(p, {
      "main.typ": text("= Changed\n"),
      "chapters/one/intro.typ": text("hi"),
      "img/logo.png": asset("sha256:aa"),
    });
    expect(report.created).toEqual(["chapters/one/intro.typ", "img/logo.png"]);
    expect(report.modified).toEqual(["main.typ"]);
    expect(report.changed).toBe(true);
    expect(idOf(p, "main.typ")).toBe(main);
    const frontier = p.doc.frontiers().at(-1)!;
    expect(p.doc.getChangeAt(frontier).message).toBe("test apply");

    const next = apply(p, {
      "chapters/one/intro.typ": gone,
      "img/logo.png": gone,
    });
    expect(next.deleted).toEqual(["chapters/one/intro.typ", "img/logo.png"]);
    // Folders that only held deleted files go too; the always-empty one stays.
    expect([...buildPathIndex(p).byPath.keys()].sort()).toEqual([
      "empty",
      "main.typ",
    ]);
  });

  it("commits with the given origin", () => {
    const p = project();
    const origins: string[] = [];
    p.doc.subscribe((batch) => origins.push(batch.origin ?? ""));
    applyChanges(p, new Map([["a.typ", text("a")]]), {
      origin: "typstry:folder",
    });
    return Promise.resolve().then(() => {
      expect(origins).toContain("typstry:folder");
    });
  });

  it("leaves hidden nodes alone", () => {
    const p = project();
    const dir = createFile(p, null, "d", "dir");
    createFile(p, dir, "x.typ", "text");
    const pending = p.fs.createNode();
    pending.data.set(NODE.kind, "asset");
    pending.data.set(NODE.name, "pending.png");
    const report = apply(p, { "d/x.typ": gone });
    expect(report.deleted).toEqual(["d/x.typ"]);
    const index = buildPathIndex(p);
    expect(index.byPath.has("pending.png")).toBe(true);
    expect(index.byPath.has("d")).toBe(false);

    // A new file at a hidden node's path takes the node over.
    const next = apply(p, { "pending.png": asset("sha256:bb") });
    expect(next.created).toEqual(["pending.png"]);
    expect(idOf(p, "pending.png")).toBe(pending.id);
  });

  it("keeps folders that still hold hidden nodes", () => {
    const p = project();
    const dir = createFile(p, null, "img", "dir");
    createFile(p, dir, "old.typ", "text");
    const pending = p.fs.createNode(dir);
    pending.data.set(NODE.kind, "asset");
    pending.data.set(NODE.name, "pending.png");
    const report = apply(p, { "img/old.typ": gone });
    expect(report.deleted).toEqual(["img/old.typ"]);
    expect(buildPathIndex(p).byPath.has("img/pending.png")).toBe(true);
  });

  it("pairs renames and keeps the node", () => {
    const p = project();
    apply(p, {
      "a.typ": text("unique"),
      "dup1.typ": text("same"),
      "dup2.typ": text("same"),
      "pic.png": asset("sha256:cc"),
    });
    const a = idOf(p, "a.typ");
    const pic = idOf(p, "pic.png");
    const dup = idOf(p, "dup1.typ");
    const report = apply(p, {
      "a.typ": gone,
      "ch/b.typ": text("unique"),
      "dup1.typ": gone,
      "dup3.typ": text("same"),
      "pic.png": gone,
      "img/pic.png": asset("sha256:cc"),
    });
    expect(report.renamed).toEqual([
      { from: "a.typ", to: "ch/b.typ" },
      { from: "dup1.typ", to: "dup3.typ" },
      { from: "pic.png", to: "img/pic.png" },
    ]);
    expect(report.created).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(idOf(p, "ch/b.typ")).toBe(a);
    expect(idOf(p, "img/pic.png")).toBe(pic);
    expect(idOf(p, "dup3.typ")).toBe(dup);

    // Two candidates with the same content: too ambiguous to guess.
    const next = apply(p, {
      "dup2.typ": gone,
      "dup3.typ": gone,
      "x.typ": text("same"),
      "y.typ": text("same"),
    });
    expect(next.renamed).toEqual([]);
    expect(next.created).toEqual(["x.typ", "y.typ"]);
    expect(next.deleted).toEqual(["dup2.typ", "dup3.typ"]);
  });

  it("follows the main file through a rename and clears it on delete", () => {
    const p = project();
    const main = idOf(p, "main.typ");
    const body = materialize(p).get("main.typ")!;
    if (body.kind !== "text") throw new Error("expected text");
    apply(p, { "main.typ": gone, "src/thesis.typ": text(body.text) });
    expect(p.mainFile).toBe(main);

    apply(p, { "src/thesis.typ": gone, "other.typ": text("x") });
    expect(p.mainFile).toBeNull();
    expect(p.meta.get(META.mainFile)).toBeNull();
  });

  it("recreates a node that changes kind", () => {
    const p = project();
    const main = idOf(p, "main.typ");
    const report = apply(p, { "main.typ": asset("sha256:dd") });
    expect(report.modified).toEqual(["main.typ"]);
    expect(idOf(p, "main.typ")).not.toBe(main);
    expect(p.mainFile).toBeNull();

    // A file becoming a folder and back.
    const down = apply(p, {
      "main.typ": gone,
      "main.typ/inner.typ": text("x"),
    });
    expect(down.created).toEqual(["main.typ/inner.typ"]);
    expect(down.deleted).toEqual(["main.typ"]);
    const up = apply(p, { "main.typ": text("y") });
    expect(up.deleted).toEqual(["main.typ/inner.typ"]);
    expect(up.created).toEqual(["main.typ"]);
  });

  it("skips invalid paths and files inside files", () => {
    const p = project();
    const report = apply(p, {
      "ok.typ": text("1"),
      "a\\b.typ": text(""),
      "/abs.typ": text(""),
      "a//b.typ": text(""),
      "../up.typ": text(""),
      "dir/./x.typ": text(""),
      "bell\u0007.typ": text(""),
      ["a".repeat(256)]: text(""),
      ".git/config": text(""),
      "ok.typ/nested.typ": text(""),
    });
    expect(report.skipped.map((s) => s.path)).toEqual([
      "a\\b.typ",
      "/abs.typ",
      "a//b.typ",
      "../up.typ",
      "dir/./x.typ",
      "bell\u0007.typ",
      "a".repeat(256),
      ".git/config",
      "ok.typ/nested.typ",
    ]);
    expect(report.skipped.at(-1)!.reason).toEqual({
      kind: "inside-file",
      file: "ok.typ",
    });
    expect(report.skipped[1]?.reason).toMatchObject({
      kind: "invalid-name",
      segment: "",
    });
    expect([...materialize(p).keys()]).toEqual(["main.typ", "ok.typ"]);
  });

  it("resolves clash paths to their own node", () => {
    const a = project();
    const b = newProject(2);
    b.doc.import(a.doc.export({ mode: "snapshot" }));
    const fa = createFile(a, null, "x.typ", "text");
    const fb = createFile(b, null, "x.typ", "text");
    sync(a, b);
    expect(idOf(a, "x~0@2.typ")).toBe(fb);

    apply(a, { "x.typ": text("a"), "x~0@2.typ": text("b") });
    expect(getText(a, fa).toString()).toBe("a");
    expect(getText(a, fb).toString()).toBe("b");

    // Without the winner the loser would fall back to "x.typ"; it keeps the
    // path it was pushed under instead.
    const report = apply(a, { "x.typ": gone });
    expect(report.deleted).toEqual(["x.typ"]);
    expect(idOf(a, "x~0@2.typ")).toBe(fb);
  });

  it("touches only what it names", () => {
    const p = project();
    apply(p, {
      "ch/a.typ": text("a"),
      "ch/b.typ": text("b"),
      "old.typ": text("moved"),
    });
    const old = idOf(p, "old.typ");
    const report = apply(p, {
      "ch/a.typ": gone,
      "ch/b.typ": gone,
      "new/old.typ": text("moved"),
      "x.typ": text("x"),
      "old.typ": gone,
      "x.typ/in.typ": text(""),
      "bad\\name.typ": text(""),
    });
    expect(report.created).toEqual(["x.typ"]);
    expect(report.deleted).toEqual(["ch/a.typ", "ch/b.typ"]);
    expect(report.renamed).toEqual([{ from: "old.typ", to: "new/old.typ" }]);
    expect(report.skipped.map((s) => s.path)).toEqual([
      "bad\\name.typ",
      "x.typ/in.typ",
    ]);
    expect(idOf(p, "new/old.typ")).toBe(old);
    expect([...buildPathIndex(p).byPath.keys()].sort()).toEqual([
      "main.typ",
      "new",
      "new/old.typ",
      "x.typ",
    ]);
  });

  it("blocks on untouched files only", () => {
    const p = project();
    apply(p, { a: text("file"), "d/x.typ": text("x") });
    const blocked = apply(p, { "a/b.typ": text("") });
    expect(blocked.skipped[0]?.reason).toEqual({
      kind: "inside-file",
      file: "a",
    });
    expect(blocked.changed).toBe(false);
    // Deleted in the same change, it can.
    const freed = apply(p, { a: gone, "a/b.typ": text("") });
    expect(freed.created).toEqual(["a/b.typ"]);
    expect(freed.deleted).toEqual(["a"]);
    // A file replacing a folder takes the folder's files with it.
    const replaced = apply(p, { d: text("now a file") });
    expect(replaced.created).toEqual(["d"]);
    expect(replaced.deleted).toEqual(["d/x.typ"]);
    expect(replaced.skipped).toEqual([]);
  });

  it("keeps files whose names the rules reject", () => {
    const p = project();
    const odd = p.fs.createNode();
    odd.data.set(NODE.kind, "text");
    odd.data.set(NODE.name, "a\\b.typ");
    odd.data.setContainer(NODE.content, new LoroText());
    p.doc.commit();
    const report = apply(p, { "main.typ": text("m") });
    expect(report.deleted).toEqual([]);
    expect(idOf(p, "a\\b.typ")).toBe(odd.id);
  });

  it("keeps the paths of untouched clash losers", () => {
    const a = project();
    const b = newProject(2);
    b.doc.import(a.doc.export({ mode: "snapshot" }));
    createFile(a, null, "x.typ", "text");
    const fb = createFile(b, null, "x.typ", "text");
    sync(a, b);
    const report = apply(a, { "x.typ": gone });
    expect(report.deleted).toEqual(["x.typ"]);
    expect(idOf(a, "x~0@2.typ")).toBe(fb);
  });

  it("agrees with materialize after random change sets", () => {
    const p = project();
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const segs = ["a", "b.typ", ".hidden", "c"];
    const bodies = ["", "x", "hello\n", "\u{1F600}"];
    for (let round = 0; round < 60; round++) {
      const entries: Record<string, Change> = {};
      const count = 1 + rand(5);
      for (let i = 0; i < count; i++) {
        const parts = Array.from(
          { length: 1 + rand(3) },
          () => segs[rand(segs.length)],
        );
        const path = parts.join("/");
        entries[path] =
          rand(4) === 0
            ? gone
            : rand(3) === 0
              ? asset(`sha256:${rand(3)}`)
              : text(bodies[rand(bodies.length)] ?? "");
      }
      const report = apply(p, entries);
      const skipped = new Set(report.skipped.map((s) => s.path));
      // Skipped paths (file inside a file) are the only ones allowed to differ.
      const after = materialize(p);
      for (const [path, change] of Object.entries(entries)) {
        if (skipped.has(path) || change.kind === "delete") continue;
        const got = after.get(path);
        expect(got, `${round}: ${path}`).toBeDefined();
        if (change.kind === "text")
          expect(got).toMatchObject({ kind: "text", text: change.text });
        else expect(got).toMatchObject({ kind: "asset", hash: change.hash });
      }
      // Applying the result again changes nothing.
      const again: Record<string, Change> = {};
      for (const [path, f] of after)
        again[path] = f.kind === "text" ? text(f.text) : asset(f.hash);
      expect(apply(p, again).changed).toBe(false);
    }
  });
});

describe("replaceText", () => {
  it("handles small and large texts", () => {
    const p = project();
    const id = createFile(p, null, "t.typ", "text", "hello");
    const t = getText(p, id);
    replaceText(t, "hello world");
    expect(t.toString()).toBe("hello world");
    const big = "line\n".repeat(20_000);
    replaceText(t, big);
    expect(t.toString()).toBe(big);
    replaceText(t, big + "tail");
    expect(t.toString()).toBe(big + "tail");
  });
});
