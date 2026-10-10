import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzy matching", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("chapters/Intro.typ", "cint")?.positions).toEqual([
      0, 9, 10, 11,
    ]);
    expect(fuzzyMatch("main.typ", "xyz")).toBeNull();
  });

  it("ranks file name matches above matches across folders", () => {
    const items = [
      { path: "images/main-figure.png" },
      { path: "main.typ" },
      { path: "chapters/methods.typ" },
    ];
    expect(fuzzyFilter(items, "main").map((i) => i.path)).toEqual([
      "main.typ",
      "images/main-figure.png",
    ]);
    expect(fuzzyFilter(items, "meth").map((i) => i.path)).toEqual([
      "chapters/methods.typ",
    ]);
  });

  it("lists everything by path for an empty query", () => {
    const items = [{ path: "b.typ" }, { path: "a.typ" }];
    expect(fuzzyFilter(items, " ").map((i) => i.path)).toEqual([
      "a.typ",
      "b.typ",
    ]);
  });
});
