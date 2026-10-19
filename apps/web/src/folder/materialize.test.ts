import { describe, expect, it } from "vitest";

import { createAsset, createFile, getText } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject, NODE } from "@/doc/schema";
import { newProject, sync } from "@/doc/test-utils";

import { materialize, materializeDirs } from "./materialize";

function project() {
  const p = newProject(1);
  initProject(p, { title: "T" });
  return p;
}

describe("materialize", () => {
  it("lists text files and assets sorted by path", () => {
    const p = project();
    const dir = createFile(p, null, "b", "dir");
    createFile(p, dir, "z.typ", "text", "z");
    createAsset(p, null, "a.png", {
      hash: "sha256:aa",
      size: 3,
      mime: "image/png",
    });
    const files = materialize(p);
    expect([...files.keys()]).toEqual(["a.png", "b/z.typ", "main.typ"]);
    const asset = files.get("a.png")!;
    expect(asset).toMatchObject({ kind: "asset", hash: "sha256:aa", size: 3 });
    expect(files.get("b/z.typ")).toMatchObject({ kind: "text", text: "z" });
  });

  it("skips folders, hashless assets and unsafe names", () => {
    const p = project();
    createFile(p, null, "empty", "dir");
    const pending = p.fs.createNode();
    pending.data.set(NODE.kind, "asset");
    pending.data.set(NODE.name, "pending.png");
    const odd = createFile(p, null, "ok.typ", "text");
    p.fs.getNodeByID(odd)!.data.set(NODE.name, "a\\b.typ");
    expect([...materialize(p).keys()]).toEqual(["main.typ"]);
    expect([...materializeDirs(p)]).toEqual(["empty"]);
  });

  it("uses clash display names", () => {
    const a = project();
    const b = newProject(2);
    b.doc.import(a.doc.export({ mode: "snapshot" }));
    createFile(a, null, "x.typ", "text", "a");
    createFile(b, null, "x.typ", "text", "b");
    sync(a, b);
    const files = materialize(a);
    expect(files.get("x.typ")).toMatchObject({ text: "a" });
    expect(files.get("x~0@2.typ")).toMatchObject({ text: "b" });
  });

  it("works on a fork at an older version", () => {
    const p = project();
    const before = p.doc.frontiers();
    const id = buildPathIndex(p).byPath.get("main.typ")!;
    getText(p, id).insert(0, "new ");
    p.doc.commit();
    const old = materialize(p.doc.forkAt(before));
    expect(old.get("main.typ")).toMatchObject({
      text: expect.not.stringContaining("new ") as unknown as string,
    });
  });
});
