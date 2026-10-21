import type { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The top and bottom share of the viewport that doesn't count as settled. */
const EDGE = 0.25;

/**
 * Where to scroll so a revealed spot is easy to find. Left alone when it is
 * already well inside the view, since moving the text under the reader's eyes
 * for nothing is worse than a match near the edge. Otherwise it goes to the
 * middle: CodeMirror's default puts it flush against the nearest edge, which
 * is where the eye is least likely to look.
 */
export function revealScroll(
  view: EditorView,
  pos: number,
): StateEffect<unknown> {
  const box = view.scrollDOM.getBoundingClientRect();
  const at = view.coordsAtPos(pos);
  const settled =
    at !== null &&
    at.top >= box.top + box.height * EDGE &&
    at.bottom <= box.bottom - box.height * EDGE;
  return EditorView.scrollIntoView(pos, { y: settled ? "nearest" : "center" });
}
