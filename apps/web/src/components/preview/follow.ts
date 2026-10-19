// Decides whether the preview should scroll to a change the user just typed,
// kept free of the DOM so it can be tested without layout.

import type { PageChange } from "@/typst/svg-pages";

import { positionOf, type Layout, type PageSize } from "./geometry";

/** After the user scrolled the preview themselves, edits leave it alone. */
export const MANUAL_SCROLL_GRACE_MS = 1500;

/** Where the changed region's top lands in the viewport, as a fraction. */
const TOP_FRACTION = 1 / 3;

export interface FollowInput {
  changes: readonly PageChange[];
  pages: PageSize[];
  layout: Layout;
  scrollTop: number;
  viewportHeight: number;
  /** When the user last scrolled by hand, or null if they have not. */
  lastManualScrollAt: number | null;
  now: number;
}

/**
 * The scrollTop that brings the first changed region into view, or null to
 * stay where we are: the user is scrolling, or a change is already visible
 * (which keeps an edit to a heading from jumping to the table of contents).
 */
export function followScrollTop(input: FollowInput): number | null {
  const { changes, pages, layout, scrollTop, viewportHeight } = input;
  if (changes.length === 0 || pages.length === 0) return null;
  if (
    input.lastManualScrollAt !== null &&
    input.now - input.lastManualScrollAt < MANUAL_SCROLL_GRACE_MS
  )
    return null;

  const bottom = scrollTop + viewportHeight;
  let first: number | null = null;
  for (const change of changes) {
    const top = positionOf(pages, layout, {
      page: change.page,
      y: change.top,
      x: 0,
    }).y;
    const end = positionOf(pages, layout, {
      page: change.page,
      y: change.bottom,
      x: 0,
    }).y;
    if (end >= scrollTop && top <= bottom) return null;
    first ??= top;
  }
  return Math.max(0, first! - viewportHeight * TOP_FRACTION);
}
