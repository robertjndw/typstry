import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Long enough for the CSS animation in editor.css to finish. */
export const FLASH_MS = 1500;

const flash = StateEffect.define<{ pos: number; step: number }>();
const clear = StateEffect.define<number>();

// A line that is flashed again while its class is still on would keep the
// running animation. Alternating between two identically styled classes makes
// the browser start it over.
const CLASSES = ["cm-flash cm-flash-a", "cm-flash cm-flash-b"];

const field = StateField.define<{ set: DecorationSet; step: number }>({
  create: () => ({ set: Decoration.none, step: 0 }),
  update(value, tr) {
    let { set, step } = value;
    set = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(flash)) {
        const line = tr.state.doc.lineAt(effect.value.pos);
        step = effect.value.step;
        set = Decoration.set([
          Decoration.line({ class: CLASSES[step % 2]! }).range(line.from),
        ]);
      } else if (effect.is(clear) && effect.value === step) {
        set = Decoration.none;
      }
    }
    return { set, step };
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.set),
});

export const lineFlash: Extension = field;

/**
 * Marks the line at `pos` for a moment, so a jump that lands there can be
 * found by eye. A no-op in an editor without `lineFlash`.
 */
export function flashLine(view: EditorView, pos: number): void {
  const current = view.state.field(field, false);
  if (!current) return;
  const step = current.step + 1;
  view.dispatch({ effects: flash.of({ pos, step }) });
  setTimeout(() => {
    // Gone with the editor, or flashed again since: leave that one alone.
    if (view.dom.isConnected) view.dispatch({ effects: clear.of(step) });
  }, FLASH_MS);
}
