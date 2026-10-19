// The string half of splitting typst.ts' SVG into pages. It runs in the
// compile worker, which has no DOM, so nothing here may touch DOMParser or
// `document`; svg-pages.ts has the half that does.

const PAGE_START = '<g class="typst-page"';

export interface SplitPage {
  tid: string;
  width: number;
  height: number;
  /** The page's `<g class="typst-page">` element, as emitted. */
  markup: string;
}

export interface SplitSvg {
  /** Opening tag of the stacked SVG. */
  rootTag: string;
  /** Everything between the root tag and the first page. */
  defsSource: string;
  pages: SplitPage[];
}

function attribute(tag: string, name: string): string {
  return new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

/**
 * Cuts typst.ts' single stacked SVG into its defs and one chunk per page,
 * reading the page identity off the top-level `<g class="typst-page">` tags.
 * Page groups never nest, so each page runs up to the next page start.
 */
export function splitSvgString(svg: string): SplitSvg {
  const rootTagEnd = svg.indexOf(">") + 1;
  const firstPage = svg.indexOf(PAGE_START, rootTagEnd);
  const end = svg.lastIndexOf("</svg>");
  const rootTag = svg.slice(0, rootTagEnd);

  if (firstPage < 0 || end < firstPage) {
    // No pages (or an unexpected layout): all of it is defs.
    return {
      rootTag,
      defsSource: svg.slice(rootTagEnd, end < 0 ? svg.length : end),
      pages: [],
    };
  }

  const pages: SplitPage[] = [];
  for (let at = firstPage; at < end;) {
    const next = svg.indexOf(PAGE_START, at + PAGE_START.length);
    const stop = next < 0 || next > end ? end : next;
    const markup = svg.slice(at, stop);
    const tag = markup.slice(0, markup.indexOf(">"));
    pages.push({
      tid: attribute(tag, "data-tid"),
      width: Number(attribute(tag, "data-page-width")) || 0,
      height: Number(attribute(tag, "data-page-height")) || 0,
      markup,
    });
    at = stop;
  }
  return { rootTag, defsSource: svg.slice(rootTagEnd, firstPage), pages };
}
