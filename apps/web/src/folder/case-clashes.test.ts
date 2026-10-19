import { describe, expect, it } from "vitest";

import { caseClashes } from "./case-clashes";

describe("caseClashes", () => {
  it("keeps the first spelling in sorted order", () => {
    expect(caseClashes(["b.typ", "main.typ", "Main.typ"])).toEqual([
      ["Main.typ", "main.typ"],
    ]);
  });

  it("prefers the spelling that is already on disk", () => {
    expect(
      caseClashes(["b.typ", "main.typ", "Main.typ"], (p) => p === "main.typ"),
    ).toEqual([["main.typ", "Main.typ"]]);
  });

  it("finds clashes in folder names", () => {
    expect(
      caseClashes(["Fig/a.png", "fig/b.png", "fig/c.png", "main.typ"]),
    ).toEqual([
      ["Fig/", "fig/b.png"],
      ["Fig/", "fig/c.png"],
    ]);
    expect(caseClashes(["Fig/a.png", "fig/b.png"], (p) => p === "fig")).toEqual(
      [["fig/", "Fig/a.png"]],
    );
    expect(caseClashes(["a/Fig/x.png", "a/fig/x.png", "a/fig/y.png"])).toEqual([
      ["a/Fig/", "a/fig/x.png"],
      ["a/Fig/", "a/fig/y.png"],
    ]);
  });

  it("treats a file and a folder of the same name as a clash", () => {
    expect(caseClashes(["fig", "Fig/a.png"])).toEqual([["Fig/", "fig"]]);
  });

  it("finds nothing when names differ", () => {
    expect(caseClashes(["a/x.typ", "b/x.typ"])).toEqual([]);
    expect(caseClashes([])).toEqual([]);
  });
});
