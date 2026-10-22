import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { FLASH_MS, flashLine, lineFlash } from "./flash";

function setup(doc = "first\nsecond\nthird") {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [lineFlash] }),
    parent: document.body,
  });
  const flashed = () =>
    Array.from(view.dom.querySelectorAll(".cm-flash"), (el) => el.textContent);
  return { view, flashed };
}

describe("flashLine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("marks the line of an offset, then lets go", () => {
    const { view, flashed } = setup();
    flashLine(view, 8);
    expect(flashed()).toEqual(["second"]);
    vi.advanceTimersByTime(FLASH_MS);
    expect(flashed()).toEqual([]);
    view.destroy();
  });

  it("restarts the animation when the same line is flashed again", () => {
    const { view } = setup();
    flashLine(view, 8);
    const first = view.dom.querySelector(".cm-flash")!.className;
    flashLine(view, 8);
    const second = view.dom.querySelector(".cm-flash")!.className;
    expect(second).not.toBe(first);
    view.destroy();
  });

  it("does not clear a newer flash when an older one expires", () => {
    const { view, flashed } = setup();
    flashLine(view, 0);
    vi.advanceTimersByTime(FLASH_MS - 100);
    flashLine(view, 8);
    vi.advanceTimersByTime(100);
    expect(flashed()).toEqual(["second"]);
    vi.advanceTimersByTime(FLASH_MS);
    expect(flashed()).toEqual([]);
    view.destroy();
  });

  it("follows the line while the document changes", () => {
    const { view, flashed } = setup();
    flashLine(view, 8);
    view.dispatch({ changes: { from: 0, insert: "zero\n" } });
    expect(flashed()).toEqual(["second"]);
    view.destroy();
  });

  it("ignores an editor without the extension", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "text" }),
      parent: document.body,
    });
    expect(() => flashLine(view, 0)).not.toThrow();
    view.destroy();
  });
});
