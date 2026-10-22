import type { TreeID } from "loro-crdt";

import { searchProject, type SearchQuery } from "./search";

const q = (pattern: string, rest: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...rest,
});

const file = (path: string, text: string) => ({
  fileId: path as TreeID,
  path,
  text,
});

function matches(text: string, query: SearchQuery) {
  const result = searchProject([file("a.typ", text)], query);
  if ("error" in result) throw new Error(result.error);
  return result.files[0]?.matches ?? [];
}

describe("searchProject", () => {
  it("treats regex specials literally in literal mode", () => {
    const found = matches("a.b a+b (x) [y] $1 a\\b", q("a.b"));
    expect(found.map((m) => m.text)).toEqual(["a.b"]);
    expect(matches("f(x) [y] $1 a\\b", q("(x)"))).toHaveLength(1);
    expect(matches("f(x) [y] $1 a\\b", q("[y]"))).toHaveLength(1);
    expect(matches("f(x) [y] $1 a\\b", q("$1"))).toHaveLength(1);
    expect(matches("f(x) [y] $1 a\\b", q("a\\b"))).toHaveLength(1);
  });

  it("matches regexes and reports captured text", () => {
    const found = matches("x1 x22 y3", q("x\\d+", { regex: true }));
    expect(found.map((m) => [m.from, m.to, m.text])).toEqual([
      [0, 2, "x1"],
      [3, 6, "x22"],
    ]);
  });

  it("honours case sensitivity", () => {
    expect(matches("Foo foo FOO", q("foo"))).toHaveLength(3);
    expect(
      matches("Foo foo FOO", q("foo", { caseSensitive: true })),
    ).toHaveLength(1);
  });

  it("matches whole words, including non-ASCII ones", () => {
    const query = q("café", { wholeWord: true });
    expect(matches("café cafés xcafé café.", query).map((m) => m.from)).toEqual(
      [0, 17],
    );
    expect(
      matches("cat concat cat_ cat", q("cat", { wholeWord: true })).map(
        (m) => m.from,
      ),
    ).toEqual([0, 16]);
    expect(matches("日本 日本語", q("日本", { wholeWord: true }))).toHaveLength(
      1,
    );
  });

  it("skips zero-length regex matches", () => {
    expect(matches("abc\ndef", q("^", { regex: true }))).toEqual([]);
    const found = matches("baaac", q("a*", { regex: true }));
    expect(found.map((m) => [m.from, m.to])).toEqual([[1, 4]]);
    expect(matches("😀😀", q("x*", { regex: true }))).toEqual([]);
  });

  it("stops at the limit and says so", () => {
    const files = [file("a.typ", "a a a"), file("b.typ", "a a")];
    const result = searchProject(files, q("a"), { limit: 4 });
    if ("error" in result) throw new Error(result.error);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.files.map((f) => f.matches.length)).toEqual([3, 1]);

    const exact = searchProject(files, q("a"), { limit: 5 });
    expect(exact).toMatchObject({ total: 5, truncated: false });
  });

  it("reports an invalid regex", () => {
    const result = searchProject([file("a.typ", "x")], q("(", { regex: true }));
    expect(result).toHaveProperty("error");
  });

  it("returns nothing for an empty pattern", () => {
    expect(searchProject([file("a.typ", "x")], q(""))).toEqual({
      files: [],
      total: 0,
      truncated: false,
    });
  });

  it("counts offsets in UTF-16 units after astral characters", () => {
    const text = "😀 needle";
    const [m] = matches(text, q("needle"));
    expect(m).toMatchObject({ from: 3, to: 9 });
    expect(text.slice(m!.from, m!.to)).toBe("needle");
    expect(matches("😀", q(".", { regex: true }))[0]).toMatchObject({
      from: 0,
      to: 2,
    });
  });

  it("numbers lines from zero and handles CRLF", () => {
    const found = matches("one\ntwo foo\r\nthree\nfoo", q("foo"));
    expect(found.map((m) => [m.line, m.preview])).toEqual([
      [1, "two foo"],
      [3, "foo"],
    ]);
  });

  it("windows long lines around the match", () => {
    const text = `${"x".repeat(500)}needle${"y".repeat(500)}`;
    const [m] = matches(text, q("needle"));
    expect(m!.preview.length).toBeLessThanOrEqual(120);
    expect(m!.preview.slice(m!.previewFrom, m!.previewTo)).toBe("needle");
    expect(m!.from).toBe(500);
  });

  it("keeps a surrogate pair whole at the window edge", () => {
    const text = `${"😀".repeat(40)}needle`;
    const [m] = matches(text, q("needle"));
    expect(m!.preview).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
    expect(m!.preview.slice(m!.previewFrom, m!.previewTo)).toBe("needle");
  });

  it("previews a multi-line match on its first line", () => {
    const [m] = matches("a b\nc d", q("b\\nc", { regex: true }));
    expect(m).toMatchObject({
      line: 0,
      preview: "a b",
      previewFrom: 2,
      previewTo: 3,
    });
  });

  it("sorts files by path and omits files without matches", () => {
    const result = searchProject(
      [file("z.typ", "a"), file("b.typ", "none"), file("a/x.typ", "a")],
      q("a"),
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.files.map((f) => f.path)).toEqual(["a/x.typ", "z.typ"]);
  });
});
