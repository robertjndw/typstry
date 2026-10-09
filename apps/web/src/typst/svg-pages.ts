const SVG_NS = "http://www.w3.org/2000/svg";
const PAGE_START = '<g class="typst-page"';

export interface PreviewPage {
  /** Content hash typst.ts assigns to the page; equal tid, equal content. */
  tid: string;
  width: number;
  height: number;
  element: SVGSVGElement;
}

export interface PreviewDocument {
  /**
   * Hidden <svg> with the document's glyph and clip/gradient defs plus the
   * typst.ts CSS. Page elements reference these by id, so it must be in the
   * same HTML document as the pages.
   */
  defs: SVGSVGElement;
  /** Source markup of `defs`, used to skip reparsing when it is unchanged. */
  defsSource: string;
  pages: PreviewPage[];
}

function parseSvg(markup: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.nodeName !== "svg") {
    throw new Error("typst.ts returned malformed SVG");
  }
  return root as unknown as SVGSVGElement;
}

function createDefs(rootTag: string, source: string): SVGSVGElement {
  const parsed = parseSvg(rootTag + source + "</svg>");
  const defs = document.createElementNS(SVG_NS, "svg");
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  // Not display:none: browsers skip gradients and clip paths defined inside
  // an undisplayed <svg>, even when referenced from elsewhere.
  defs.setAttribute(
    "style",
    "position:absolute;width:0;height:0;overflow:hidden",
  );
  for (const child of Array.from(parsed.children)) {
    defs.appendChild(document.importNode(child, true));
  }
  return defs;
}

function createPage(g: Element): PreviewPage {
  const tid = g.getAttribute("data-tid") ?? "";
  const width = Number(g.getAttribute("data-page-width")) || 0;
  const height = Number(g.getAttribute("data-page-height")) || 0;
  const element = document.createElementNS(SVG_NS, "svg");
  element.setAttribute("viewBox", `0 0 ${width} ${height}`);
  element.setAttribute("class", "typst-doc");
  const page = document.importNode(g, true);
  page.removeAttribute("transform");
  element.appendChild(page);
  return { tid, width, height, element };
}

/**
 * Splits typst.ts' single stacked SVG into one <svg> per page so the preview
 * can lay pages out with gaps and shadows and skip work on pages that did
 * not change.
 *
 * Parsing dominates the cost (about 40 ms for 20 dense pages, 2.5 MB of
 * markup), so this works on the string first: the page tids are read off the
 * top-level `<g class="typst-page">` tags, pages already in `previous` keep
 * their element unparsed, and the defs are only reparsed when their markup
 * changed. Reused elements also let React and the browser leave those
 * pages alone.
 */
export function splitSvgPages(
  svg: string,
  previous?: PreviewDocument | null,
): PreviewDocument {
  const rootTagEnd = svg.indexOf(">") + 1;
  const firstPage = svg.indexOf(PAGE_START, rootTagEnd);
  const end = svg.lastIndexOf("</svg>");
  const rootTag = svg.slice(0, rootTagEnd);

  if (firstPage < 0 || end < firstPage) {
    // No pages (or an unexpected layout): parse everything as defs.
    const source = svg.slice(rootTagEnd, end < 0 ? svg.length : end);
    return { defs: createDefs(rootTag, source), defsSource: source, pages: [] };
  }

  const defsSource = svg.slice(rootTagEnd, firstPage);
  const defs =
    previous && previous.defsSource === defsSource
      ? previous.defs
      : createDefs(rootTag, defsSource);

  const reusable = new Map<string, PreviewPage[]>();
  for (const page of previous?.pages ?? []) {
    const list = reusable.get(page.tid);
    if (list) list.push(page);
    else reusable.set(page.tid, [page]);
  }

  // Page groups never nest, so each top-level page runs up to the next
  // page start (or the closing </svg>).
  const chunks: string[] = [];
  for (let at = firstPage; at < end;) {
    const next = svg.indexOf(PAGE_START, at + PAGE_START.length);
    const stop = next < 0 || next > end ? end : next;
    chunks.push(svg.slice(at, stop));
    at = stop;
  }

  const slots: (PreviewPage | null)[] = [];
  const fresh: string[] = [];
  for (const chunk of chunks) {
    const tagEnd = chunk.indexOf(">");
    const tid = /data-tid="([^"]*)"/.exec(chunk.slice(0, tagEnd))?.[1] ?? "";
    const reused = tid ? reusable.get(tid)?.shift() : undefined;
    if (reused) {
      slots.push(reused);
    } else {
      slots.push(null);
      fresh.push(chunk);
    }
  }

  // All changed pages go through a single parse.
  const parsedPages =
    fresh.length > 0
      ? Array.from(parseSvg(rootTag + fresh.join("") + "</svg>").children)
      : [];
  if (parsedPages.length !== fresh.length) {
    throw new Error("typst.ts returned malformed SVG pages");
  }
  let nextFresh = 0;
  const pages = slots.map(
    (slot) => slot ?? createPage(parsedPages[nextFresh++]!),
  );
  return { defs, defsSource, pages };
}
