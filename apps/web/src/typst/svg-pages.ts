import { lcsMatch } from "@/lib/lcs";

import type { PagePosition, RenderPayload } from "./protocol";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Marks the element the preview pages live in. typst.ts ships its CSS with
 * global selectors (a bare `svg { fill: none }` among them, which would
 * blank icons across the app), so the defs' styles are scoped under it.
 */
export const PREVIEW_SCOPE_CLASS = "typst-preview";

export interface PreviewPage {
  /** Content hash typst.ts assigns to the page; equal tid, equal content. */
  tid: string;
  width: number;
  height: number;
  element: SVGSVGElement;
}

/**
 * The part of a page that differs from the previous document's page at the
 * same index, as a vertical range in pt from the page's top.
 */
export interface PageChange {
  page: number;
  top: number;
  bottom: number;
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
  /**
   * Where this document differs from the one it was built against, in page
   * order. Empty for the first document and when only reused pages remain.
   */
  changes: PageChange[];
}

// What typst.ts' SVG backend emits, plus a few harmless shapes. Anything
// else (script, iframe, animation elements that could rewrite an href) is
// dropped with its subtree.
const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "style",
  "title",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "use",
  "symbol",
  "image",
  "a",
  "clipPath",
  "mask",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "foreignObject",
]);
// The text selection layer: one div of escaped text per run.
const HTML_IN_FOREIGN_OBJECT = new Set(["div", "span"]);
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function allowedElement(el: Element): boolean {
  if (el.namespaceURI === SVG_NS) return SVG_ELEMENTS.has(el.localName);
  return (
    el.namespaceURI === XHTML_NS &&
    HTML_IN_FOREIGN_OBJECT.has(el.localName) &&
    el.parentElement?.closest("foreignObject") != null
  );
}

function allowedHref(el: Element, href: string): boolean {
  const value = href.trim();
  switch (el.localName) {
    case "a": {
      // Same-document "#..." links are out too: following one would replace
      // the URL fragment, which holds the project key.
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      return LINK_PROTOCOLS.has(url.protocol);
    }
    case "image":
      return /^data:image\//i.test(value);
    default:
      // Glyph, clip path and gradient references.
      return value.startsWith("#");
  }
}

/**
 * typst.ts builds the SVG from documents collaborators wrote, and does not
 * escape everything it puts into attributes: `#link("@typst:...")` lands
 * verbatim in an `onclick`. The pages end up in the app's own document, so
 * anything that could run script or navigate somewhere unexpected goes
 * before they are imported. The app's CSP blocks inline handlers as well;
 * this is the first line of defense, not the only one.
 *
 * Internal links are turned into `LOCATION_ATTR` before this runs, see
 * parseSvg.
 */
export function sanitizeSvg(root: Element): void {
  const doomed: Element[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
  );
  for (
    let node: Node | null = walker.currentNode;
    node;
    node = walker.nextNode()
  ) {
    const el = node as Element;
    if (!allowedElement(el)) {
      doomed.push(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.localName.toLowerCase();
      if (
        name.startsWith("on") ||
        (name === "href" && !allowedHref(el, attr.value)) ||
        // xml:base would change what relative references resolve against.
        name === "base"
      ) {
        el.removeAttributeNode(attr);
      }
    }
    if (el.localName === "a" && el.hasAttribute("target")) {
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
  // Removed after the walk so the walker does not lose its place; the
  // subtree of a removed element goes with it.
  for (const el of doomed) el.remove();
}

/** Where an internal link points: page (from 1), x and y in pt. */
export const LOCATION_ATTR = "data-typst-location";

// typst.ts writes internal links as an onclick calling a script of its own,
// which is not loaded here. Blink checks the CSP as soon as it parses an
// inline handler, even in a DOMParser document, so sanitizeSvg removing it
// afterwards still logs a violation. Only this exact form is rewritten, and
// the replacement holds nothing but the numbers; any other onclick is left
// for sanitizeSvg.
const INTERNAL_LINK =
  /onclick="handleTypstLocation\(this, (\d+), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\); return false"/g;

/** The target of an internal link in the preview, if `el` is in one. */
export function internalLinkTarget(el: Element): PagePosition | null {
  const value = el.closest(`[${LOCATION_ATTR}]`)?.getAttribute(LOCATION_ATTR);
  const [page, x, y] = (value ?? "").split(" ").map(Number);
  if (!page || x === undefined || y === undefined) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { page: page - 1, x, y };
}

function parseSvg(markup: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(
    markup.replace(INTERNAL_LINK, `${LOCATION_ATTR}="$1 $2 $3"`),
    "image/svg+xml",
  );
  const root = parsed.documentElement;
  if (root.nodeName !== "svg") {
    throw new Error("typst.ts returned malformed SVG");
  }
  sanitizeSvg(root);
  return root as unknown as SVGSVGElement;
}

/**
 * Prefixes every selector of a top-level style rule with `scope`. At-rules
 * (typst.ts has two @keyframes) are kept as they are. This is a brace
 * counter, not a CSS parser: enough for the fixed stylesheet typst.ts
 * emits, which has no comments or braces inside strings.
 */
export function scopeCss(css: string, scope: string): string {
  let out = "";
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf("{", at);
    if (open < 0) {
      out += css.slice(at);
      break;
    }
    // Find the matching close brace, so nested blocks stay inside.
    let depth = 0;
    let close = open;
    for (; close < css.length; close++) {
      if (css[close] === "{") depth++;
      else if (css[close] === "}" && --depth === 0) break;
    }
    const prelude = css.slice(at, open).trim();
    const body = css.slice(open, close + 1);
    if (prelude.startsWith("@")) {
      out += `${prelude} ${body}\n`;
    } else {
      const selectors = prelude
        .split(",")
        .map((sel) => `${scope} ${sel.trim()}`)
        .join(", ");
      out += `${selectors} ${body}\n`;
    }
    at = close + 1;
  }
  return out;
}

function createDefs(rootTag: string, source: string): SVGSVGElement {
  const parsed = parseSvg(rootTag + source + "</svg>");
  for (const style of Array.from(parsed.querySelectorAll("style"))) {
    style.textContent = scopeCss(
      style.textContent ?? "",
      `.${PREVIEW_SCOPE_CLASS}`,
    );
  }
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

/**
 * Brings the live defs in line with `fresh` by adding and removing single
 * glyphs and clip paths instead of swapping the whole element. Swapping makes
 * the browser re-resolve every `<use>` on every page, which costs 100 ms and
 * more in a long document, and typing often adds a glyph. Glyph ids are
 * content hashes, but the markup is compared anyway since that's cheap next
 * to the layout it saves.
 *
 * Returns false, leaving `live` alone, when the two differ in a way this
 * doesn't handle, such as a different set of sections.
 */
function patchDefs(live: SVGSVGElement, fresh: SVGSVGElement): boolean {
  const liveSections = Array.from(live.children);
  const freshSections = Array.from(fresh.children);
  if (
    liveSections.length !== freshSections.length ||
    liveSections.some(
      (el, i) =>
        el.localName !== freshSections[i]!.localName ||
        el.getAttribute("class") !== freshSections[i]!.getAttribute("class"),
    )
  ) {
    return false;
  }
  for (let i = 0; i < liveSections.length; i++) {
    const have = liveSections[i]!;
    const want = freshSections[i]!;
    if (have.outerHTML === want.outerHTML) continue;
    const wanted = Array.from(want.children);
    if (have.localName !== "defs" || wanted.some((el) => !el.id)) {
      // Styles and anything without ids: replace that one section. A style
      // change restyles the pages anyway.
      have.replaceWith(want);
      continue;
    }
    const byId = new Map<string, Element>();
    for (const el of Array.from(have.children)) byId.set(el.id, el);
    for (const el of wanted) {
      const old = byId.get(el.id);
      byId.delete(el.id);
      if (!old) have.appendChild(el);
      else if (old.outerHTML !== el.outerHTML) old.replaceWith(el);
    }
    // No page uses these any more, so nothing has to re-resolve.
    for (const el of byId.values()) el.remove();
  }
  return true;
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

const TRANSLATE_Y = /translate\(\s*[^,\s)]+[\s,]+([^)\s]+)\s*\)/;

/** The top-level blocks of a page: its `.typst-group`'s positioned children. */
export function pageBlocks(page: Element | null): { tid: string; y: number }[] {
  const group = page?.querySelector(":scope > .typst-page > .typst-group");
  if (!group) return [];
  return Array.from(group.children, (el) => ({
    tid: el.getAttribute("data-tid") ?? "",
    y: Number(TRANSLATE_Y.exec(el.getAttribute("transform") ?? "")?.[1]) || 0,
  }));
}

/**
 * The vertical ranges of `next` that are not in `before`, one per run of
 * blocks that have no partner in a diff of the two pages' blocks. A block's
 * tid is a hash of its content, not of where it sits, so text pushed down
 * by an edit above it does not count as changed. A diff and not a shared
 * head and tail: a paragraph that grows also pushes a line off the end of
 * the page, which would make everything in between look changed. Layout is
 * not available here (and not worth forcing), so a run extends down to the
 * next block, or to the end of the page.
 */
export function changedRanges(
  before: PreviewPage | undefined,
  next: PreviewPage,
): { top: number; bottom: number }[] {
  if (!before) return [{ top: 0, bottom: next.height }];
  const old = pageBlocks(before.element);
  const now = pageBlocks(next.element);
  const matches = lcsMatch(
    old.map((b) => b.tid),
    now.map((b) => b.tid),
  );
  const ranges: { top: number; bottom: number }[] = [];
  for (let j = 0; j < now.length;) {
    if (matches[j] !== null) {
      j++;
      continue;
    }
    const start = j;
    while (j < now.length && matches[j] === null) j++;
    const ys = now.slice(start, j).map((b) => b.y);
    ranges.push({
      top: Math.min(...ys),
      bottom: Math.max(...ys, now[j]?.y ?? next.height),
    });
  }
  if (ranges.length > 0) return ranges;
  // Same blocks but a different page (positions or the page itself moved):
  // nothing to narrow it down by.
  if (old.length === now.length) return [{ top: 0, bottom: next.height }];
  // Blocks were only removed: the spot is where the first gap closes, at
  // the block that followed the first removed one.
  const kept = new Set(matches);
  const gone = old.findIndex((_, i) => !kept.has(i));
  const after = matches.findIndex((m) => m !== null && m > gone);
  const at = after < 0 ? next.height : now[after]!.y;
  return [{ top: at, bottom: at }];
}

/**
 * Builds the preview document from a worker render, the DOM half of what
 * svg-split.ts starts. Pages whose tid is in `previous` keep their element
 * unparsed, and the defs are only reparsed when their markup changed. Reused
 * elements also let React and the browser leave those pages alone.
 *
 * Returns null when the render leaves out a page or the defs that `previous`
 * doesn't have; the caller answers with a rerender.
 */
export function buildPreviewDocument(
  render: RenderPayload,
  previous: PreviewDocument | null,
): PreviewDocument | null {
  if (render.defs === null && !previous) return null;

  const reusable = new Map<string, PreviewPage[]>();
  for (const page of previous?.pages ?? []) {
    const list = reusable.get(page.tid);
    if (list) list.push(page);
    else reusable.set(page.tid, [page]);
  }

  // Checked before the live defs are patched, which cannot be undone.
  const slots: (PreviewPage | null)[] = [];
  const fresh: string[] = [];
  for (const { tid, markup } of render.pages) {
    const reused = tid ? reusable.get(tid)?.shift() : undefined;
    if (reused) {
      slots.push(reused);
    } else if (markup === null) {
      return null;
    } else {
      slots.push(null);
      fresh.push(markup);
    }
  }

  let defs: SVGSVGElement;
  let defsSource: string;
  if (render.defs === null) {
    ({ defs, defsSource } = previous!);
  } else {
    defsSource = render.defs;
    if (previous && previous.defsSource === defsSource) {
      defs = previous.defs;
    } else {
      defs = createDefs(render.rootTag, defsSource);
      if (previous && patchDefs(previous.defs, defs)) defs = previous.defs;
    }
  }

  // All changed pages go through a single parse.
  const parsedPages =
    fresh.length > 0
      ? Array.from(
          parseSvg(render.rootTag + fresh.join("") + "</svg>").children,
        )
      : [];
  if (parsedPages.length !== fresh.length) {
    throw new Error("typst.ts returned malformed SVG pages");
  }
  let nextFresh = 0;
  const changes: PageChange[] = [];
  const pages = slots.map((slot, index) => {
    if (slot) return slot;
    const page = createPage(parsedPages[nextFresh++]!);
    if (previous) {
      for (const range of changedRanges(previous.pages[index], page))
        changes.push({ page: index, ...range });
    }
    return page;
  });
  return { defs, defsSource, pages, changes };
}
