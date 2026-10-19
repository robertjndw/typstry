import { followScrollTop, MANUAL_SCROLL_GRACE_MS } from "./follow";
import type { Layout } from "./geometry";

// At scale 1 with padding 10 and gap 20, pages start at 10, 230 and 450.
const pages = [200, 200, 200].map((height) => ({ width: 100, height }));
const layout: Layout = { scale: 1, padding: 10, gap: 20, viewportWidth: 300 };

const base = {
  pages,
  layout,
  scrollTop: 0,
  viewportHeight: 300,
  lastManualScrollAt: null,
  now: 10_000,
};

describe("followScrollTop", () => {
  it("puts the first changed region a third down the viewport", () => {
    // Page 2 starts at 450, plus 30 into the page.
    expect(
      followScrollTop({
        ...base,
        changes: [{ page: 2, top: 30, bottom: 60 }],
      }),
    ).toBe(480 - 100);
  });

  it("uses the first region when several are off screen", () => {
    expect(
      followScrollTop({
        ...base,
        viewportHeight: 210,
        changes: [
          { page: 1, top: 0, bottom: 10 },
          { page: 2, top: 0, bottom: 10 },
        ],
      }),
    ).toBe(230 - 70);
  });

  it("stays put when any region is visible", () => {
    expect(
      followScrollTop({
        ...base,
        changes: [
          { page: 0, top: 100, bottom: 150 },
          { page: 2, top: 0, bottom: 10 },
        ],
      }),
    ).toBeNull();
  });

  it("counts a region that only overlaps the viewport edge", () => {
    expect(
      followScrollTop({
        ...base,
        scrollTop: 100,
        changes: [{ page: 0, top: 0, bottom: 95 }],
      }),
    ).toBeNull();
    expect(
      followScrollTop({
        ...base,
        scrollTop: 100,
        changes: [{ page: 0, top: 0, bottom: 80 }],
      }),
    ).toBe(0);
  });

  it("never scrolls above the start", () => {
    expect(
      followScrollTop({
        ...base,
        scrollTop: 600,
        changes: [{ page: 0, top: 0, bottom: 5 }],
      }),
    ).toBe(0);
  });

  it("leaves the preview alone right after a manual scroll", () => {
    const changes = [{ page: 2, top: 0, bottom: 10 }];
    expect(
      followScrollTop({
        ...base,
        changes,
        lastManualScrollAt: base.now - (MANUAL_SCROLL_GRACE_MS - 1),
      }),
    ).toBeNull();
    expect(
      followScrollTop({
        ...base,
        changes,
        lastManualScrollAt: base.now - MANUAL_SCROLL_GRACE_MS,
      }),
    ).not.toBeNull();
  });

  it("has nothing to follow without changes or pages", () => {
    expect(followScrollTop({ ...base, changes: [] })).toBeNull();
    expect(
      followScrollTop({
        ...base,
        pages: [],
        changes: [{ page: 0, top: 0, bottom: 1 }],
      }),
    ).toBeNull();
  });
});
