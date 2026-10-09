import { Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import type { Cursor, LoroDoc, LoroText, UndoManager } from "loro-crdt";

import { loroRemote } from "./loro-binding";

export interface LoroUndoConfig {
  doc: LoroDoc;
  text: LoroText;
  undoManager: UndoManager;
}

interface BoundEditor {
  view: EditorView;
  doc: LoroDoc;
  text: LoroText;
}

interface Registry {
  editors: Set<BoundEditor>;
  lastActive: BoundEditor | undefined;
}

// One UndoManager covers the whole doc and can serve several editors at once,
// but it only has a single onPush/onPop slot. The registry owns that slot and
// routes cursor bookkeeping to the editor of the affected text.
const registries = new WeakMap<UndoManager, Registry>();

function registryFor(undoManager: UndoManager): Registry {
  let registry = registries.get(undoManager);
  if (registry) return registry;
  const reg: Registry = { editors: new Set(), lastActive: undefined };
  registries.set(undoManager, reg);

  undoManager.setOnPush((_isUndo, _range, event) => {
    const targets = new Set(event?.events.map((e) => e.target));
    let editor = reg.lastActive;
    if (targets.size > 0 && !(editor && targets.has(editor.text.id))) {
      editor = [...reg.editors].find((e) => targets.has(e.text.id));
    }
    if (!editor) return { value: null, cursors: [] };
    const { anchor, head } = editor.view.state.selection.main;
    const a = editor.text.getCursor(anchor);
    const h = editor.text.getCursor(head);
    return { value: editor.text.id, cursors: a && h ? [a, h] : [] };
  });

  undoManager.setOnPop((_isUndo, { value, cursors }) => {
    const [a, h] = cursors as (Cursor | undefined)[];
    if (!a || !h) return;
    const editor = [...reg.editors].find((e) => e.text.id === value);
    if (!editor) return;
    const len = editor.view.state.doc.length;
    const anchor = editor.doc.getCursorPos(a)?.offset;
    const head = editor.doc.getCursorPos(h)?.offset;
    if (anchor === undefined || head === undefined) return;
    editor.view.dispatch({
      selection: { anchor: Math.min(anchor, len), head: Math.min(head, len) },
      scrollIntoView: true,
    });
  });

  registry = reg;
  return registry;
}

/**
 * Undo/redo through Loro's UndoManager, which only reverts this peer's own
 * edits and transforms them over concurrent remote edits. CodeMirror's
 * `history()` must not be installed alongside it: it would also record
 * remote changes and undo other people's work.
 *
 * The selection is restored on undo/redo via Loro cursors, which stay valid
 * across concurrent edits. This takes over the manager's onPush/onPop.
 */
export function loroUndo({
  doc,
  text,
  undoManager,
}: LoroUndoConfig): Extension {
  const run = (fn: () => boolean) => () => {
    fn();
    // Always claim the key so the browser's native undo never touches the
    // contenteditable behind CodeMirror's back.
    return true;
  };
  const undo = run(() => undoManager.undo());
  const redo = run(() => undoManager.redo());

  const tracker = ViewPlugin.fromClass(
    class {
      private readonly entry: BoundEditor;
      private readonly registry: Registry;

      constructor(view: EditorView) {
        this.entry = { view, doc, text };
        this.registry = registryFor(undoManager);
        this.registry.editors.add(this.entry);
      }

      update(update: ViewUpdate) {
        const localEdit = update.transactions.some(
          (tr) => tr.docChanged && !tr.annotation(loroRemote),
        );
        if (localEdit || (update.focusChanged && update.view.hasFocus)) {
          this.registry.lastActive = this.entry;
        }
      }

      destroy() {
        this.registry.editors.delete(this.entry);
        if (this.registry.lastActive === this.entry) {
          this.registry.lastActive = undefined;
        }
      }
    },
  );

  return [
    tracker,
    Prec.high(
      keymap.of([
        { key: "Mod-z", run: undo, preventDefault: true },
        { key: "Mod-Shift-z", run: redo, preventDefault: true },
        { key: "Mod-y", run: redo, preventDefault: true },
      ]),
    ),
  ];
}
