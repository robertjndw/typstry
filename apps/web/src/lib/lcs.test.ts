import { lcsMatch } from "./lcs";

describe("lcsMatch", () => {
  it("matches equal sequences one to one", () => {
    expect(lcsMatch(["a", "b"], ["a", "b"])).toEqual([0, 1]);
  });

  it("leaves an inserted glyph unmatched", () => {
    expect(lcsMatch(["a", "c"], ["a", "b", "c"])).toEqual([0, null, 1]);
  });

  it("drops deleted glyphs from the old side", () => {
    expect(lcsMatch(["a", "x", "c"], ["a", "c"])).toEqual([0, 2]);
  });

  it("keeps matches in order across repeated letters", () => {
    const matches = lcsMatch(["a", "b", "a"], ["a", "a", "b", "a"]);
    const used = matches.filter((m): m is number => m !== null);
    expect(used).toEqual([...used].sort((x, y) => x - y));
    expect(used).toHaveLength(3);
  });

  it("handles empty sides", () => {
    expect(lcsMatch([], ["a"])).toEqual([null]);
    expect(lcsMatch(["a"], [])).toEqual([]);
  });
});
