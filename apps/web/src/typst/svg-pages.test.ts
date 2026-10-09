import { splitSvgPages } from "./svg-pages";

const root =
  '<svg class="typst-doc" viewBox="0 0 596 1684" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';
const defs = (glyphs: string) =>
  `<style>.typst-text{}</style><defs class="glyph">${glyphs}</defs>`;
const page = (tid: string, y: number) =>
  `<g class="typst-page" transform="translate(0, ${y})" data-tid="${tid}" data-page-width="596" data-page-height="842"><g class="typst-group"><use xlink:href="#g1"/></g></g>`;

describe("splitSvgPages", () => {
  it("splits pages into standalone svgs and collects the defs", () => {
    const doc = splitSvgPages(
      root +
        defs('<path id="g1" d="M0 0"/>') +
        page("p1", 0) +
        page("p2", 842) +
        "</svg>",
    );
    expect(doc.pages.map((p) => [p.tid, p.width, p.height])).toEqual([
      ["p1", 596, 842],
      ["p2", 596, 842],
    ]);
    const second = doc.pages[1]!.element;
    expect(second.getAttribute("viewBox")).toBe("0 0 596 842");
    expect(
      second.querySelector("g.typst-page")?.hasAttribute("transform"),
    ).toBe(false);
    expect(doc.defs.querySelector("#g1")).not.toBeNull();
    expect(doc.defs.querySelector("style")).not.toBeNull();
  });

  it("reuses unchanged pages and defs from the previous render", () => {
    const glyphs = '<path id="g1" d="M0 0"/>';
    const first = splitSvgPages(
      root + defs(glyphs) + page("a", 0) + page("b", 842) + "</svg>",
    );
    const second = splitSvgPages(
      root + defs(glyphs) + page("a", 0) + page("c", 842) + "</svg>",
      first,
    );
    expect(second.defs).toBe(first.defs);
    expect(second.pages[0]).toBe(first.pages[0]);
    expect(second.pages[1]).not.toBe(first.pages[1]);
    expect(second.pages[1]!.tid).toBe("c");

    const third = splitSvgPages(
      root +
        defs(glyphs + '<path id="g2" d="M1 1"/>') +
        page("a", 0) +
        "</svg>",
      second,
    );
    expect(third.defs).not.toBe(second.defs);
    expect(third.pages).toEqual([second.pages[0]]);
  });

  it("does not hand the same element to two identical pages", () => {
    const first = splitSvgPages(root + defs("") + page("same", 0) + "</svg>");
    const second = splitSvgPages(
      root + defs("") + page("same", 0) + page("same", 842) + "</svg>",
      first,
    );
    expect(second.pages[0]).toBe(first.pages[0]);
    expect(second.pages[1]!.element).not.toBe(first.pages[0]!.element);
  });

  it("handles a document without pages", () => {
    expect(splitSvgPages(root + defs("") + "</svg>").pages).toEqual([]);
  });
});
