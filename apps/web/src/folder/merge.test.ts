import { describe, expect, it } from "vitest";

import { getText } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";

import { applyChanges } from "./apply";
import { mergeText } from "./merge";

const BODY = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");

function setup() {
  const a = newProject(1);
  initProject(a, { title: "T" });
  applyChanges(a, new Map([["main.typ", { kind: "text", text: BODY }]]));
  const b = fork(a, 2);
  const id = buildPathIndex(a).byPath.get("main.typ")!;
  return { a, b, id, base: a.doc.frontiers() };
}

describe("mergeText", () => {
  it("keeps disk and doc edits in different regions", () => {
    const { a, b, id, base } = setup();
    getText(b, id).insert(0, "remote\n");
    b.doc.commit();
    sync(a, b);
    const merged = mergeText(a.doc, base, "main.typ", `${BODY}local\n`, id);
    expect(merged).toBe(`remote\n${BODY}local\n`);
  });

  it("does not touch the live doc and leaves its peer alone", () => {
    const { a, id, base } = setup();
    const peer = a.doc.peerIdStr;
    const vv = a.doc.oplogVersion().toJSON();
    mergeText(a.doc, base, "main.typ", "other", id);
    expect(a.doc.peerIdStr).toBe(peer);
    expect(a.doc.oplogVersion().toJSON()).toEqual(vv);
  });

  it("returns null when the node was replaced", () => {
    const { a, id, base } = setup();
    applyChanges(a, new Map([["main.typ", { kind: "delete" }]]));
    applyChanges(a, new Map([["main.typ", { kind: "text", text: "new" }]]));
    expect(mergeText(a.doc, base, "main.typ", "disk", id)).toBeNull();
    const fresh = buildPathIndex(a).byPath.get("main.typ")!;
    // The base has no node under the fresh id either.
    expect(mergeText(a.doc, base, "main.typ", "disk", fresh)).toBeNull();
  });

  it("returns null for a path the base lacks", () => {
    const { a, id, base } = setup();
    expect(mergeText(a.doc, base, "nope.typ", "x", id)).toBeNull();
  });
});
