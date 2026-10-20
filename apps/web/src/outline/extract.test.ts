import { extractOutline } from "./extract";

describe("extractOutline", () => {
  it("reads heading levels and titles", () => {
    const items = extractOutline("= One\n== Two\n=== Three\ntext\n");
    expect(items.map((i) => [i.kind, i.level, i.title])).toEqual([
      ["heading", 1, "One"],
      ["heading", 2, "Two"],
      ["heading", 3, "Three"],
    ]);
  });

  it("attaches a label that ends the heading", () => {
    const [a, b] = extractOutline("= Intro <intro>\n== Plain\n");
    expect(a).toMatchObject({ title: "Intro", label: "intro" });
    expect(b?.label).toBeUndefined();
  });

  it("strips emphasis and inline code from titles", () => {
    const [h] = extractOutline("= The *bold* and _slanted_ `code` day\n");
    expect(h?.title).toBe("The bold and slanted code day");
  });

  it("keeps references, math and escapes readable", () => {
    const [h] = extractOutline("= See @intro and $x^2$ \\# here\n");
    expect(h?.title).toBe("See @intro and $x^2$ \\# here");
  });

  it("reads a figure caption given as a content block", () => {
    const [f] = extractOutline(
      '#figure(image("a.png"), caption: [A *big* cat]) <cat>\n',
    );
    expect(f).toMatchObject({
      kind: "figure",
      level: 0,
      title: "A big cat",
      label: "cat",
    });
  });

  it("reads a figure caption given as a string", () => {
    const [f] = extractOutline('#figure(caption: "Say \\"hi\\"")[body]\n');
    expect(f?.title).toBe('Say "hi"');
    expect(f?.label).toBeUndefined();
  });

  it("finds figures in code and ignores other calls", () => {
    const items = extractOutline(
      '#let f = figure(caption: [Inner])\n#image("x.png")\n#fig.figure()\n',
    );
    expect(items.map((i) => [i.kind, i.title])).toEqual([["figure", "Inner"]]);
  });

  it("does not attach a label after a paragraph break", () => {
    const [f] = extractOutline("#figure(caption: [A])\n\n<far>\n");
    expect(f?.label).toBeUndefined();
  });

  it("finds includes with literal paths only", () => {
    const items = extractOutline(
      '#include "chapters/a.typ"\n#{ include "b.typ" }\n#include path\n',
    );
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ["include", "chapters/a.typ"],
      ["include", "b.typ"],
    ]);
  });

  it("reports UTF-16 offsets that slice back to the node", () => {
    const source = "😀 intro\n\n= 😀 Café 𝒳\nbody\n== After\n";
    const items = extractOutline(source);
    expect(items.map((i) => source.slice(i.from, i.to))).toEqual([
      "= 😀 Café 𝒳",
      "== After",
    ]);
    expect(items[0]?.title).toBe("😀 Café 𝒳");
  });

  it("does not throw on broken input", () => {
    for (const source of [
      "",
      "= ",
      "#figure(",
      "#figure(caption: [unclosed",
      '#include "',
      "= <",
      "#{ let x = ",
      "$ ( [ {",
      "\u0000\uD800",
    ])
      expect(() => extractOutline(source)).not.toThrow();
  });
});
