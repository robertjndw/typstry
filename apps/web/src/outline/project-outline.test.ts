import type { TreeID } from "loro-crdt";

import {
  activeItemIndex,
  buildProjectOutline,
  resolveIncludePath,
  type OutlineSource,
} from "./project-outline";

function files(sources: Record<string, string>) {
  const reads: string[] = [];
  const read = (path: string): OutlineSource | null => {
    reads.push(path);
    const text = sources[path];
    return text === undefined ? null : { fileId: path as TreeID, text };
  };
  return { read, reads };
}

describe("resolveIncludePath", () => {
  it("resolves against the including folder or the root", () => {
    expect(resolveIncludePath("main.typ", "a.typ")).toBe("a.typ");
    expect(resolveIncludePath("ch/one.typ", "two.typ")).toBe("ch/two.typ");
    expect(resolveIncludePath("ch/one.typ", "../x/./y.typ")).toBe("x/y.typ");
    expect(resolveIncludePath("ch/one.typ", "/top.typ")).toBe("top.typ");
  });

  it("rejects paths that leave the project", () => {
    expect(resolveIncludePath("main.typ", "../x.typ")).toBeNull();
    expect(resolveIncludePath("main.typ", "")).toBeNull();
  });
});

describe("buildProjectOutline", () => {
  it("expands includes in place, in document order", () => {
    const { read } = files({
      "main.typ": '= A\n#include "b.typ"\n= C\n',
      "b.typ": "== B1\n== B2\n",
    });
    const { items } = buildProjectOutline("main.typ", read);
    expect(items.map((i) => [i.title, i.path, i.depth])).toEqual([
      ["A", "main.typ", 0],
      ["B1", "b.typ", 1],
      ["B2", "b.typ", 1],
      ["C", "main.typ", 0],
    ]);
  });

  it("nests figures under the heading before them", () => {
    const { read } = files({
      "main.typ": "#figure(caption: [Top])\n= A\n#figure(caption: [In A])\n",
    });
    const { items } = buildProjectOutline("main.typ", read);
    expect(items.map((i) => [i.title, i.depth])).toEqual([
      ["Top", 0],
      ["A", 0],
      ["In A", 1],
    ]);
  });

  it("resolves nested includes relative to the including file", () => {
    const { read, reads } = files({
      "main.typ": '#include "ch/one.typ"\n',
      "ch/one.typ": '= One\n#include "sub/two.typ"\n#include "/abs.typ"\n',
      "ch/sub/two.typ": "= Two\n",
      "abs.typ": "= Abs\n",
    });
    const { items, files: seen } = buildProjectOutline("main.typ", read);
    expect(items.map((i) => i.title)).toEqual(["One", "Two", "Abs"]);
    expect(reads).toEqual([
      "main.typ",
      "ch/one.typ",
      "ch/sub/two.typ",
      "abs.typ",
    ]);
    expect([...seen]).toHaveLength(4);
  });

  it("stops at include cycles but lists a repeated file twice", () => {
    const { read } = files({
      "main.typ": '= M\n#include "a.typ"\n#include "a.typ"\n',
      "a.typ": '= A\n#include "main.typ"\n#include "a.typ"\n',
    });
    const { items } = buildProjectOutline("main.typ", read);
    expect(items.map((i) => i.title)).toEqual(["M", "A", "A"]);
  });

  it("skips includes that do not resolve to a readable file", () => {
    const { read } = files({
      "main.typ": '= M\n#include "gone.typ"\n#include "../out.typ"\n= N\n',
    });
    const { items } = buildProjectOutline("main.typ", read);
    expect(items.map((i) => i.title)).toEqual(["M", "N"]);
  });

  it("is empty when the root cannot be read", () => {
    const { read } = files({});
    expect(buildProjectOutline("main.typ", read).items).toEqual([]);
  });
});

describe("activeItemIndex", () => {
  const { read } = files({
    "main.typ": '= A\n#figure(caption: [F])\n#include "b.typ"\n= C\n',
    "b.typ": "= B\n",
  });
  const { items } = buildProjectOutline("main.typ", read);
  const main = "main.typ" as TreeID;

  it("picks the last heading of the file at or before the offset", () => {
    expect(activeItemIndex(items, main, 0)).toBe(0);
    expect(activeItemIndex(items, main, 20)).toBe(0);
    expect(activeItemIndex(items, main, 1000)).toBe(3);
    expect(activeItemIndex(items, "b.typ" as TreeID, 2)).toBe(2);
  });

  it("is -1 above the first heading or for unknown files", () => {
    expect(activeItemIndex(items, "none" as TreeID, 5)).toBe(-1);
    const { items: late } = buildProjectOutline(
      "x.typ",
      files({ "x.typ": "intro\n= H\n" }).read,
    );
    expect(activeItemIndex(late, "x.typ" as TreeID, 2)).toBe(-1);
  });
});
