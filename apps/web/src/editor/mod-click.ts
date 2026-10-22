import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { isModClick } from "@/lib/platform";

/**
 * Hands Mod+Click to `onClick` with the clicked offset. CodeMirror would
 * otherwise add another cursor there.
 */
export function modClick(
  onClick: (view: EditorView, pos: number) => void,
): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!isModClick(event)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
      onClick(view, pos);
      return true;
    },
  });
}
