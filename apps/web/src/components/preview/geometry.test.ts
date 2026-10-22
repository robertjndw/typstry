import {
  docPointOf,
  pageIndexAt,
  pagePointAt,
  pointAt,
  positionOf,
  type Layout,
} from "./geometry";

const pages = [
  { width: 100, height: 200 },
  { width: 200, height: 100 },
  { width: 100, height: 200 },
];

const at = (scale: number, viewportWidth = 300): Layout => ({
  scale,
  padding: 10,
  gap: 20,
  viewportWidth,
});

describe("preview geometry", () => {
  it("finds the page whose slot holds a y offset", () => {
    // Slots at scale 1: [10, 230), [230, 350), [350, ...)
    expect(pageIndexAt(pages, at(1), 0)).toBe(0);
    expect(pageIndexAt(pages, at(1), 229)).toBe(0);
    expect(pageIndexAt(pages, at(1), 230)).toBe(1);
    expect(pageIndexAt(pages, at(1), 400)).toBe(2);
    expect(pageIndexAt(pages, at(1), 9999)).toBe(2);
    expect(pageIndexAt(pages, at(2), 230)).toBe(0);
  });

  it("keeps a document point stable across scales", () => {
    const point = pointAt(pages, at(1), 180, 300);
    expect(point).toEqual({ page: 1, y: 70, x: 30 });
    // At scale 2 the content (420 px) is wider than the viewport.
    expect(positionOf(pages, at(2), point)).toEqual({
      x: 210 + 60,
      y: 10 + 400 + 20 + 140,
    });
    const back = pointAt(pages, at(2), 270, 570);
    expect(back).toEqual(point);
  });

  it("maps a click to a point from the page's top-left corner", () => {
    // Content is 300 px wide at scale 1; page 1 (200 wide) spans 50..250,
    // top at 230.
    expect(pagePointAt(pages, at(1), 60, 240)).toEqual({
      page: 1,
      x: 10,
      y: 10,
    });
    // Page 0 is 100 wide, so it spans 100..200 and starts at the padding.
    expect(pagePointAt(pages, at(1), 150, 10)).toEqual({
      page: 0,
      x: 50,
      y: 0,
    });
    // At scale 2 the content is 420 wide and page 1 starts at 10 + 400 + 20.
    expect(pagePointAt(pages, at(2), 210 - 200 + 20, 430 + 40)).toEqual({
      page: 1,
      x: 10,
      y: 20,
    });
  });

  it("finds no page in the padding, the gaps and beside narrow pages", () => {
    expect(pagePointAt(pages, at(1), 150, 5)).toBeNull();
    // The gap after page 0 (210..230) belongs to its slot but not the page.
    expect(pagePointAt(pages, at(1), 150, 220)).toBeNull();
    // Beside page 0, which is narrower than page 1.
    expect(pagePointAt(pages, at(1), 60, 100)).toBeNull();
    expect(pagePointAt([], at(1), 0, 0)).toBeNull();
  });

  it("turns a page point back into the same scroll position", () => {
    const layout = at(2);
    const point = pagePointAt(pages, layout, 300, 500)!;
    expect(positionOf(pages, layout, docPointOf(pages, point))).toEqual({
      x: 300,
      y: 500,
    });
  });
});
