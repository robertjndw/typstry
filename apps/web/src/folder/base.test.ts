import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

import { trustedBase, type FolderBase } from "./base";

function docWithOps() {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  doc.getText("t").insert(0, "abc");
  doc.commit();
  return doc;
}

function baseAt(doc: LoroDoc, at?: FolderBase["frontiers"]): FolderBase {
  return {
    frontiers: doc.frontiers(),
    files: {
      "a.typ": {
        kind: "text",
        digest: "d",
        size: 3,
        mtime: 1,
        ...(at && { at }),
      },
    },
  };
}

describe("trustedBase", () => {
  it("keeps a base the doc contains", () => {
    const doc = docWithOps();
    const base = baseAt(doc);
    doc.getText("t").insert(0, "more");
    doc.commit();
    expect(trustedBase(doc, base)).toBe(base);
  });

  it("passes null through", () => {
    expect(trustedBase(docWithOps(), null)).toBeNull();
  });

  it("drops a base from a doc that has since lost history", () => {
    const doc = docWithOps();
    const base = baseAt(doc);
    expect(trustedBase(new LoroDoc(), base)).toBeNull();
    const other = new LoroDoc();
    other.setPeerId(2);
    other.getText("t").insert(0, "x");
    other.commit();
    expect(trustedBase(other, base)).toBeNull();
  });

  it("drops a base whose pinned file version is unknown", () => {
    const doc = docWithOps();
    const base = baseAt(doc, [{ peer: "1", counter: 99 }]);
    expect(trustedBase(doc, base)).toBeNull();
    expect(trustedBase(doc, baseAt(doc, doc.frontiers()))).not.toBeNull();
  });
});
