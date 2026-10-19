// Update animations for the live preview. The planning is pure so it can be
// tested without layout; the DOM half at the bottom only measures and starts
// animations.
//
// A page update replaces the page's element, so CSS can't help. Instead it's
// FLIP: measure the glyphs before the swap and after, then animate each from
// where it was to where it is. "First" is read from the screen, so a glyph
// still moving from the previous keystroke starts from where it visibly is.

import { lcsMatch } from "@/lib/lcs";
import type { AnimationKind } from "@/typst/compiler-client";
import { pageBlocks, type PageChange } from "@/typst/svg-pages";

export type { AnimationKind };

export const MOVE_MS = 110;
export const INSERT_MS = 130;
export const SLIDE_MS = 140;
export const HIGHLIGHT_MS = 1200;

// Past this the animation is just noise (a pasted page, a global replace) and
// per-glyph measuring gets slow. Counted per page, on the larger of the old
// and new glyph sets.
export const MAX_GLYPHS = 300;
// An edit touching more pages than this is a restructuring, not typing.
export const MAX_PAGES = 2;
// Lines that only shift get one measurement each, so a long page full of them
// is left to jump.
export const MAX_MOVED_BLOCKS = 150;
// Blocks on each side of the changed ones that join the matching, so the rest
// of an edited paragraph moves with it.
const WIDEN_BLOCKS = 1;
// Glyphs that moved less than this are not worth an animation.
const MIN_DELTA_PX = 0.5;
// How far left a new glyph starts, like a caret leaving it behind.
const INSERT_OFFSET_PX = 3;
const HIGHLIGHT_PAD_PX = 4;
const HIGHLIGHT_MIN_HEIGHT_PX = 18;

export interface Guards {
  reducedMotion: boolean;
  scaleChanged: boolean;
  changedPages: number;
  /** Whether the page is on screen; irrelevant to highlights. */
  visible: boolean;
}

/**
 * What a page update should do, or null for a plain swap. Typed edits need a
 * visible page because they measure. Highlights only need the change ranges,
 * and an off-screen one may be where the follow scroll is heading.
 */
export function animationMode(
  kind: AnimationKind | null,
  guards: Guards,
): AnimationKind | null {
  if (!kind || guards.reducedMotion || guards.scaleChanged) return null;
  if (guards.changedPages === 0 || guards.changedPages > MAX_PAGES) return null;
  if (kind === "typed" && !guards.visible) return null;
  return kind;
}

export function withinGlyphBudget(oldCount: number, newCount: number) {
  return Math.max(oldCount, newCount) <= MAX_GLYPHS;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * A screen pixel delta in an element's own units. Glyph text sits under
 * `scale(0.012, -0.012)`, so `d` is negative and a downward move on screen is
 * an upward one locally. Null for a singular matrix.
 */
export function toLocal(
  m: Matrix | null,
  dx: number,
  dy: number,
): { x: number; y: number } | null {
  if (!m) return null;
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    x: (m.d * dx - m.c * dy) / det,
    y: (-m.b * dx + m.a * dy) / det,
  };
}

export interface GlyphBox {
  href: string;
  left: number;
  top: number;
}

export interface GlyphStep {
  index: number;
  kind: "move" | "insert";
  x: number;
  y: number;
}

export function planGlyphs(
  old: readonly GlyphBox[],
  next: readonly (GlyphBox & { ctm: Matrix | null })[],
): GlyphStep[] {
  const matches = lcsMatch(
    old.map((g) => g.href),
    next.map((g) => g.href),
  );
  const steps: GlyphStep[] = [];
  for (const [index, glyph] of next.entries()) {
    const from = matches[index];
    if (from == null) {
      const offset = toLocal(glyph.ctm, -INSERT_OFFSET_PX, 0);
      steps.push({
        index,
        kind: "insert",
        x: offset?.x ?? 0,
        y: offset?.y ?? 0,
      });
      continue;
    }
    const dx = old[from]!.left - glyph.left;
    const dy = old[from]!.top - glyph.top;
    if (Math.hypot(dx, dy) < MIN_DELTA_PX) continue;
    const local = toLocal(glyph.ctm, dx, dy);
    if (local) steps.push({ index, kind: "move", x: local.x, y: local.y });
  }
  return steps;
}

export interface SlideStep {
  index: number;
  y: number;
}

export function planSlides(
  blocks: readonly { oldTop: number; newTop: number; ctm: Matrix | null }[],
): SlideStep[] {
  const steps: SlideStep[] = [];
  for (const [index, b] of blocks.entries()) {
    const dy = b.oldTop - b.newTop;
    if (Math.abs(dy) < MIN_DELTA_PX) continue;
    const local = toLocal(b.ctm, 0, dy);
    if (local) steps.push({ index, y: local.y });
  }
  return steps;
}

export interface BlockPlan {
  oldWindow: number[];
  newWindow: number[];
  pairs: { old: number; next: number }[];
}

/**
 * Pairs two pages' top-level blocks by content hash, like svg-pages does.
 * Unpaired blocks, widened by one block either way, are where glyphs get
 * matched; paired ones outside that are candidates for sliding. It has to be
 * a real diff: an edit that lengthens a paragraph also pushes a line off the
 * page, and trimming a shared head and tail would count everything between.
 */
export function planBlocks(
  oldTids: readonly string[],
  nextTids: readonly string[],
): BlockPlan {
  const matches = lcsMatch(oldTids, nextTids);
  const matchedOld = new Set<number>();
  for (const i of matches) if (i !== null) matchedOld.add(i);
  const widened = (unmatched: number[], length: number) => {
    const out = new Set<number>();
    for (const i of unmatched) {
      for (let k = i - WIDEN_BLOCKS; k <= i + WIDEN_BLOCKS; k++)
        if (k >= 0 && k < length) out.add(k);
    }
    return [...out].sort((x, y) => x - y);
  };
  const newWindow = widened(
    matches.flatMap((m, j) => (m === null ? [j] : [])),
    nextTids.length,
  );
  const oldWindow = widened(
    oldTids.flatMap((_, i) => (matchedOld.has(i) ? [] : [i])),
    oldTids.length,
  );
  const inNew = new Set(newWindow);
  const inOld = new Set(oldWindow);
  const pairs: BlockPlan["pairs"] = [];
  matches.forEach((old, next) => {
    if (old !== null && !inNew.has(next) && !inOld.has(old))
      pairs.push({ old, next });
  });
  return { oldWindow, newWindow, pairs };
}

export interface HighlightBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function highlightBox(
  change: Pick<PageChange, "top" | "bottom">,
  pageWidth: number,
  scale: number,
): HighlightBox {
  const top = Math.max(0, change.top * scale - HIGHLIGHT_PAD_PX);
  const bottom = change.bottom * scale + HIGHLIGHT_PAD_PX;
  return {
    left: HIGHLIGHT_PAD_PX,
    top,
    width: Math.max(0, pageWidth * scale - 2 * HIGHLIGHT_PAD_PX),
    height: Math.max(HIGHLIGHT_MIN_HEIGHT_PX, bottom - top),
  };
}

const EASE = "ease-out";

function blockElements(svg: SVGSVGElement): Element[] {
  const group = svg.querySelector(":scope > .typst-page > .typst-group");
  return group ? Array.from(group.children) : [];
}

function glyphsOf(blocks: Element[], window: readonly number[]) {
  return window.flatMap((i) =>
    Array.from(blocks[i]?.querySelectorAll("use") ?? []),
  );
}

function slider(block: Element | undefined): SVGGraphicsElement | null {
  return (
    (Array.from(block?.children ?? []).find(
      (c) => c.localName === "g" && !c.hasAttribute("transform"),
    ) as SVGGraphicsElement | undefined) ?? null
  );
}

function matrixOf(el: SVGGraphicsElement): Matrix | null {
  const m = el.getScreenCTM?.();
  return m ? { a: m.a, b: m.b, c: m.c, d: m.d } : null;
}

function glyphBoxOf(use: SVGUseElement): GlyphBox {
  const rect = use.getBoundingClientRect();
  return {
    href: use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "",
    left: rect.left,
    top: rect.top,
  };
}

export function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function isVisible(el: Element, viewport: Element): boolean {
  const a = el.getBoundingClientRect();
  const b = viewport.getBoundingClientRect();
  return a.bottom > b.top && a.top < b.bottom;
}

/**
 * The animations this module started, per page element. Asking the element
 * (`getAnimations({ subtree: true })`) walks every node and cost 10 ms or
 * more per keystroke on a dense page.
 */
const started = new WeakMap<Element, Animation[]>();

function track(page: Element, animation: Animation): void {
  const list = started.get(page);
  if (list) list.push(animation);
  else started.set(page, [animation]);
}

function animating(page: Element): boolean {
  return (started.get(page) ?? []).some((a) => a.playState === "running");
}

export interface Captured {
  oldGlyphs: GlyphBox[];
  oldWindow: number[];
  newWindow: number[];
  slides: { next: number; oldTop: number }[];
}

/**
 * The read pass before the swap: where the old page's glyphs and moved blocks
 * are on screen now. Returns null when the page isn't worth animating.
 */
export function captureBefore(
  old: SVGSVGElement,
  next: SVGSVGElement,
): Captured | null {
  const oldBlocks = blockElements(old);
  const nextBlocks = blockElements(next);
  const oldInfo = pageBlocks(old);
  const nextInfo = pageBlocks(next);
  const plan = planBlocks(
    oldInfo.map((b) => b.tid),
    nextInfo.map((b) => b.tid),
  );
  const oldUses = glyphsOf(oldBlocks, plan.oldWindow);
  const newCount = glyphsOf(nextBlocks, plan.newWindow).length;
  if (!withinGlyphBudget(oldUses.length, newCount)) return null;

  // Blocks still sliding from the previous keystroke have the same y on both
  // sides but aren't where that says, so carry them on.
  const inFlight = animating(old);
  const moved = plan.pairs.filter(
    (p) => inFlight || oldInfo[p.old]?.y !== nextInfo[p.next]?.y,
  );
  const slides: Captured["slides"] = [];
  if (moved.length <= MAX_MOVED_BLOCKS) {
    for (const p of moved) {
      const inner = slider(oldBlocks[p.old]);
      if (inner && slider(nextBlocks[p.next]))
        slides.push({
          next: p.next,
          oldTop: inner.getBoundingClientRect().top,
        });
    }
  }
  return {
    oldGlyphs: oldUses.map(glyphBoxOf),
    oldWindow: plan.oldWindow,
    newWindow: plan.newWindow,
    slides,
  };
}

/**
 * The read pass after the swap, then the writes. Animations end on the
 * element's real state, so nothing needs cleaning up when they finish.
 */
export function playAfter(before: Captured, next: SVGSVGElement): void {
  const nextBlocks = blockElements(next);
  const uses = glyphsOf(nextBlocks, before.newWindow);
  const boxes = uses.map((u) => ({ ...glyphBoxOf(u), ctm: matrixOf(u) }));
  const slideEls = before.slides.map((s) => slider(nextBlocks[s.next])!);
  const slideSteps = planSlides(
    before.slides.map((s, i) => ({
      oldTop: s.oldTop,
      newTop: slideEls[i]!.getBoundingClientRect().top,
      ctm: matrixOf(slideEls[i]!),
    })),
  );

  for (const step of planGlyphs(before.oldGlyphs, boxes)) {
    const from = `translate(${step.x}px, ${step.y}px)`;
    if (step.kind === "move") {
      track(
        next,
        uses[step.index]!.animate(
          [{ transform: from }, { transform: "none" }],
          { duration: MOVE_MS, easing: EASE },
        ),
      );
    } else {
      track(
        next,
        uses[step.index]!.animate(
          [
            { opacity: 0, transform: from },
            { opacity: 1, transform: "none" },
          ],
          { duration: INSERT_MS, easing: EASE },
        ),
      );
    }
  }
  for (const step of slideSteps) {
    track(
      next,
      slideEls[step.index]!.animate(
        [{ transform: `translate(0px, ${step.y}px)` }, { transform: "none" }],
        { duration: SLIDE_MS, easing: EASE },
      ),
    );
  }
}

export function cancelAnimations(el: Element): void {
  for (const animation of started.get(el) ?? []) animation.cancel();
  started.delete(el);
}

/**
 * Fades a tint over a changed range. It lives in the page's overlay, outside
 * the SVG, so the next swap doesn't cut it short.
 */
export function showHighlight(
  overlay: HTMLElement,
  change: PageChange,
  pageWidth: number,
  scale: number,
): void {
  const box = highlightBox(change, pageWidth, scale);
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "absolute",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: "6px",
    // The token has a light and a dark value; a low mix keeps the black page
    // text readable in both.
    background: "color-mix(in oklab, var(--warning) 32%, transparent)",
  });
  overlay.appendChild(el);
  if (typeof el.animate !== "function") {
    el.remove();
    return;
  }
  const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: HIGHLIGHT_MS,
    easing: EASE,
  });
  fade.onfinish = fade.oncancel = () => el.remove();
}
