import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { revealScroll } from "./reveal-scroll";

// jsdom has no layout, so the viewport and the line's position are staged.
function setup(coords: { top: number; bottom: number } | null) {
  const view = new EditorView({
    state: EditorState.create({ doc: "line\n".repeat(100) }),
    parent: document.body,
  });
  vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 400,
    height: 400,
  } as DOMRect);
  vi.spyOn(view, "coordsAtPos").mockReturnValue(
    coords &&
      ({ ...coords, left: 0, right: 0 } as ReturnType<
        EditorView["coordsAtPos"]
      >),
  );
  return view;
}

/** What the effect asks CodeMirror for. */
const placement = (view: EditorView) =>
  (revealScroll(view, 10).value as { y: string }).y;

describe("revealScroll", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("centres a spot near the bottom edge", () => {
    const view = setup({ top: 380, bottom: 398 });
    expect(placement(view)).toBe("center");
    view.destroy();
  });

  it("centres a spot near the top edge", () => {
    const view = setup({ top: 5, bottom: 23 });
    expect(placement(view)).toBe("center");
    view.destroy();
  });

  it("centres a spot that is not on screen", () => {
    const view = setup(null);
    expect(placement(view)).toBe("center");
    view.destroy();
  });

  it("leaves a spot that is already well in view", () => {
    const view = setup({ top: 190, bottom: 208 });
    expect(placement(view)).toBe("nearest");
    view.destroy();
  });
});
