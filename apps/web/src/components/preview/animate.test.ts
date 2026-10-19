import {
  MAX_GLYPHS,
  MAX_PAGES,
  animationMode,
  highlightBox,
  planBlocks,
  planGlyphs,
  planSlides,
  toLocal,
  withinGlyphBudget,
  type Guards,
} from "./animate";

const guards = (over: Partial<Guards> = {}): Guards => ({
  reducedMotion: false,
  scaleChanged: false,
  changedPages: 1,
  visible: true,
  ...over,
});

// Glyph text sits under scale(0.012, -0.012) at 1.5 px per pt.
const glyphCtm = { a: 0.018, b: 0, c: 0, d: -0.018 };

describe("animationMode", () => {
  it("passes the kind through when nothing forbids it", () => {
    expect(animationMode("typed", guards())).toBe("typed");
    expect(animationMode("external", guards())).toBe("external");
  });

  it("does nothing without a kind or with reduced motion", () => {
    expect(animationMode(null, guards())).toBeNull();
    expect(animationMode("typed", guards({ reducedMotion: true }))).toBeNull();
    expect(
      animationMode("external", guards({ reducedMotion: true })),
    ).toBeNull();
  });

  it("skips a zoom change and large changes", () => {
    expect(animationMode("typed", guards({ scaleChanged: true }))).toBeNull();
    expect(
      animationMode("typed", guards({ changedPages: MAX_PAGES + 1 })),
    ).toBeNull();
    expect(animationMode("typed", guards({ changedPages: MAX_PAGES }))).toBe(
      "typed",
    );
  });

  it("measures only visible pages but highlights wherever the change is", () => {
    expect(animationMode("typed", guards({ visible: false }))).toBeNull();
    expect(animationMode("external", guards({ visible: false }))).toBe(
      "external",
    );
  });

  it("keeps the glyph count in budget", () => {
    expect(withinGlyphBudget(MAX_GLYPHS, 3)).toBe(true);
    expect(withinGlyphBudget(3, MAX_GLYPHS + 1)).toBe(false);
  });
});

describe("toLocal", () => {
  it("flips the vertical delta under a negative d", () => {
    const local = toLocal(glyphCtm, 9, 9)!;
    expect(local.x).toBeCloseTo(500);
    expect(local.y).toBeCloseTo(-500);
  });

  it("has no answer for a singular or missing matrix", () => {
    expect(toLocal({ a: 0, b: 0, c: 0, d: 0 }, 1, 1)).toBeNull();
    expect(toLocal(null, 1, 1)).toBeNull();
  });
});

describe("planGlyphs", () => {
  const glyph = (href: string, left: number, top: number) => ({
    href,
    left,
    top,
    ctm: glyphCtm,
  });

  it("moves a glyph from its old place and fades in a new one", () => {
    const steps = planGlyphs(
      [
        { href: "#a", left: 10, top: 50 },
        { href: "#c", left: 20, top: 50 },
      ],
      [glyph("#a", 10, 50), glyph("#b", 20, 50), glyph("#c", 30, 50)],
    );
    expect(steps.map((s) => [s.index, s.kind])).toEqual([
      [1, "insert"],
      [2, "move"],
    ]);
    // c moved 10px right, so it starts 10px left of where it is.
    expect(steps[1]!.x).toBeCloseTo(-10 / 0.018);
    expect(steps[1]!.y).toBeCloseTo(0);
    // The insert starts a little to the left.
    expect(steps[0]!.x).toBeLessThan(0);
  });

  it("starts a glyph that moved down above its place", () => {
    const [step] = planGlyphs(
      [{ href: "#a", left: 0, top: 10 }],
      [glyph("#a", 0, 30)],
    );
    // 20px up on screen is 20 / 0.018 units in the flipped space.
    expect(step!.y).toBeCloseTo(20 / 0.018);
  });

  it("leaves glyphs that did not move alone", () => {
    expect(
      planGlyphs([{ href: "#a", left: 5, top: 5 }], [glyph("#a", 5.2, 5.1)]),
    ).toEqual([]);
  });
});

describe("planSlides", () => {
  it("converts the pixel shift of blocks that moved", () => {
    const ctm = { a: 1.5, b: 0, c: 0, d: 1.5 };
    expect(
      planSlides([
        { oldTop: 100, newTop: 130, ctm },
        { oldTop: 50, newTop: 50, ctm },
      ]),
    ).toEqual([{ index: 0, y: -20 }]);
  });
});

describe("planBlocks", () => {
  it("windows the changed blocks and pairs the shared ones", () => {
    const plan = planBlocks(
      ["a", "b", "c", "d", "e", "f"],
      ["a", "b", "X", "Y", "d", "e", "f"],
    );
    // One block of context on each side of what has no partner.
    expect(plan.oldWindow).toEqual([1, 2, 3]);
    expect(plan.newWindow).toEqual([1, 2, 3, 4]);
    expect(plan.pairs).toEqual([
      { old: 0, next: 0 },
      { old: 4, next: 5 },
      { old: 5, next: 6 },
    ]);
  });

  it("keeps a line pushed off the page out of the window", () => {
    // A longer paragraph at the top, and its last old line moved on to the
    // next page: the lines in between only moved.
    const plan = planBlocks(
      ["p1", "p2", "m1", "m2", "m3", "m4", "last"],
      ["P1", "P2", "P3", "m1", "m2", "m3", "m4"],
    );
    expect(plan.newWindow).toEqual([0, 1, 2, 3]);
    expect(plan.oldWindow).toEqual([0, 1, 2, 5, 6]);
    expect(plan.pairs).toEqual([
      { old: 3, next: 4 },
      { old: 4, next: 5 },
    ]);
  });

  it("handles identical lists and a pure removal", () => {
    expect(planBlocks(["a"], ["a"])).toEqual({
      oldWindow: [],
      newWindow: [],
      pairs: [{ old: 0, next: 0 }],
    });
    const removed = planBlocks(["a", "b", "c"], ["a", "c"]);
    expect(removed.newWindow).toEqual([]);
    expect(removed.oldWindow).toEqual([0, 1, 2]);
  });
});

describe("highlightBox", () => {
  it("scales the range and pads it", () => {
    expect(highlightBox({ top: 10, bottom: 30 }, 100, 2)).toEqual({
      left: 4,
      top: 16,
      width: 192,
      height: 48,
    });
  });

  it("keeps a removal visible", () => {
    expect(highlightBox({ top: 0, bottom: 0 }, 100, 1).height).toBe(18);
  });
});
