// Pure layout math for the preview's page column, so scroll anchoring and
// the page indicator never have to measure the DOM page by page.
//
// The column is laid out as: `padding`, page 0, `gap`, page 1, ... `padding`,
// with every page horizontally centred in a content box that is at least as
// wide as the viewport.

export interface PageSize {
  width: number;
  height: number;
}

export interface Layout {
  scale: number;
  padding: number;
  gap: number;
  /** clientWidth of the scroll container. */
  viewportWidth: number;
}

/**
 * A scale independent position in the document: a page, a vertical offset
 * in pt from that page's top (may run past its bottom into the gap), and a
 * horizontal offset in pt from the column's centre line.
 */
export interface DocPoint {
  page: number;
  y: number;
  x: number;
}

export function contentWidth(pages: PageSize[], layout: Layout): number {
  const widest = pages.reduce((w, p) => Math.max(w, p.width), 0);
  return Math.max(
    layout.viewportWidth,
    widest * layout.scale + 2 * layout.padding,
  );
}

function pageTop(pages: PageSize[], layout: Layout, index: number): number {
  let top = layout.padding;
  for (const page of pages.slice(0, index)) {
    top += page.height * layout.scale + layout.gap;
  }
  return top;
}

/** Index of the page whose slot (page plus the gap after it) contains y. */
export function pageIndexAt(
  pages: PageSize[],
  layout: Layout,
  y: number,
): number {
  let top = layout.padding;
  for (const [i, page] of pages.entries()) {
    top += page.height * layout.scale + layout.gap;
    if (y < top) return i;
  }
  return Math.max(0, pages.length - 1);
}

/** Converts a point in scroll content px into a document point. */
export function pointAt(
  pages: PageSize[],
  layout: Layout,
  x: number,
  y: number,
): DocPoint {
  const page = pageIndexAt(pages, layout, y);
  const top = pageTop(pages, layout, page);
  return {
    page,
    y: (y - top) / layout.scale,
    x: (x - contentWidth(pages, layout) / 2) / layout.scale,
  };
}

/** Inverse of pointAt, in scroll content px at the given layout. */
export function positionOf(
  pages: PageSize[],
  layout: Layout,
  point: DocPoint,
): { x: number; y: number } {
  const page = Math.min(point.page, pages.length - 1);
  return {
    x: contentWidth(pages, layout) / 2 + point.x * layout.scale,
    y: pageTop(pages, layout, page) + point.y * layout.scale,
  };
}
