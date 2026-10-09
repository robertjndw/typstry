import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { pathCompletion, relativePath } from "./path-completion";

const FILES = [
  "main.typ",
  "lib.typ",
  "chapters/intro.typ",
  "chapters/figures/plot.png",
  "logo.svg",
  "refs.bib",
  "data.json",
];

function complete(doc: string, current = "main.typ") {
  const state = EditorState.create({ doc });
  const source = pathCompletion(current, () => FILES);
  const result = source(new CompletionContext(state, doc.length, false));
  if (result instanceof Promise) throw new Error("expected a sync source");
  return (
    result && { from: result.from, labels: result.options.map((o) => o.label) }
  );
}

describe("pathCompletion", () => {
  it("offers Typst files for include and import, without the edited file", () => {
    expect(complete('#include "')?.labels).toEqual([
      "lib.typ",
      "chapters/intro.typ",
    ]);
    expect(complete('#import "ch')).toEqual({
      from: 9,
      labels: ["lib.typ", "chapters/intro.typ"],
    });
  });

  it("filters by what the function reads", () => {
    expect(complete('#image("')?.labels).toEqual([
      "chapters/figures/plot.png",
      "logo.svg",
    ]);
    expect(complete('#bibliography("')?.labels).toEqual(["refs.bib"]);
    expect(complete('#let d = json("')?.labels).toEqual(["data.json"]);
  });

  it("is relative to the edited file, or to the root after a slash", () => {
    expect(complete('#image("', "chapters/intro.typ")?.labels).toEqual([
      "figures/plot.png",
      "../logo.svg",
    ]);
    expect(complete('#image("/', "chapters/intro.typ")?.labels).toEqual([
      "/chapters/figures/plot.png",
      "/logo.svg",
    ]);
  });

  it("stays out of packages, other strings and field calls", () => {
    expect(complete('#import "@preview/')).toBeNull();
    expect(complete('#text("')).toBeNull();
    expect(complete('#image.decode("')).toBeNull();
    expect(complete('#include "a.typ" and "')).toBeNull();
  });
});

describe("relativePath", () => {
  it("walks up and down between folders", () => {
    expect(relativePath("", "a/b.typ")).toBe("a/b.typ");
    expect(relativePath("a", "a/b.typ")).toBe("b.typ");
    expect(relativePath("a/b", "c/d.png")).toBe("../../c/d.png");
    expect(relativePath("a/b", "a/c.png")).toBe("../c.png");
  });
});
