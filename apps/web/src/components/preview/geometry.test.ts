import { pageIndexAt, pointAt, positionOf, type Layout } from "./geometry";

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
});
