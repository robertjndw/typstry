import {
  Annotation,
  EditorState,
  type ChangeSpec,
  type EditorStateConfig,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Delta, LoroDoc, LoroEventBatch, LoroText } from "loro-crdt";

export interface LoroSyncConfig {
  doc: LoroDoc;
  text: LoroText;
}

/**
 * Marks transactions that mirror a Loro change into the editor, so the
 * binding does not write them back into Loro.
 */
export const loroRemote = Annotation.define<true>();

/**
 * Loro stores raw text, CodeMirror by default splits on \r\n, \r and \n and
 * reports every break as "\n". That would make offsets diverge as soon as a
 * file contains CRLF. Splitting only on "\n" keeps any "\r" as a normal
 * character, so editor text and Loro text stay byte-identical (and UTF-16
 * offsets line up 1:1). Files are expected to be normalized to LF on import;
 * this is the safety net for anything that slips through.
 */
const lfOnly = EditorState.lineSeparator.of("\n");

/**
 * Converts one Loro text delta into CodeMirror changes. All positions are in
 * the coordinates of the document before the delta, as CodeMirror expects for
 * a single change set. Adjacent ops are merged because CodeMirror does not
 * define an order for an insert and a delete at the same position.
 */
export function textDeltaToChanges(delta: Delta<string>[]): ChangeSpec[] {
  const changes: { from: number; to: number; insert: string }[] = [];
  let pos = 0;
  const push = (from: number, to: number, insert: string) => {
    const last = changes.at(-1);
    if (last && last.to === from) {
      last.to = to;
      last.insert += insert;
    } else {
      changes.push({ from, to, insert });
    }
  };
  for (const op of delta) {
    if (op.retain !== undefined) {
      pos += op.retain;
    } else if (op.delete !== undefined) {
      push(pos, pos + op.delete, "");
      pos += op.delete;
    } else if (op.insert !== undefined) {
      push(pos, pos, op.insert);
    }
  }
  return changes;
}

/**
 * Builds a minimal replace that turns `from` into `to` by trimming the common
 * prefix and suffix. Used for recovery, where we no longer trust deltas.
 */
function diffReplace(from: string, to: string): ChangeSpec | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) {
    start++;
  }
  let end = 0;
  while (
    end < max - start &&
    from.charCodeAt(from.length - 1 - end) ===
      to.charCodeAt(to.length - 1 - end)
  ) {
    end++;
  }
  return {
    from: start,
    to: from.length - end,
    insert: to.slice(start, to.length - end),
  };
}

/**
 * Replaces the editor content with the Loro text using a minimal diff, so
 * selections far away from the difference survive.
 */
export function resetEditorToLoro(view: EditorView, text: LoroText): void {
  const change = diffReplace(view.state.doc.toString(), text.toString());
  if (change) {
    view.dispatch({ changes: change, annotations: loroRemote.of(true) });
  }
}

/**
 * Two-way sync between one CodeMirror view and one LoroText. The text may
 * live in a doc that holds many other containers; events for those are
 * ignored. Use `createLoroEditorState` (or seed the state with
 * `text.toString()`) so the editor starts out equal to the Loro text.
 *
 * Do not combine with CodeMirror's `history()`; undo goes through Loro's
 * UndoManager instead (see `loroUndo`).
 */
export function loroSync({ doc, text }: LoroSyncConfig): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private committing = false;
      private updating = false;
      private resyncQueued = false;
      private destroyed = false;
      private readonly view: EditorView;
      private readonly unsubscribe: () => void;

      constructor(view: EditorView) {
        this.view = view;
        this.unsubscribe = doc.subscribe((batch) => this.onLoroEvent(batch));
        // The state may have been created from an older snapshot of the text
        // (e.g. a remote import landed between state creation and mount).
        // Dispatching from a plugin constructor is not allowed, so defer.
        if (view.state.doc.toString() !== text.toString()) this.queueResync();
      }

      update(update: ViewUpdate) {
        let changed = false;
        this.updating = true;
        try {
          for (const tr of update.transactions) {
            if (!tr.docChanged || tr.annotation(loroRemote)) continue;
            // iterChanges reports fromA/toA in start-document coordinates and
            // fromB in the coordinates after all earlier changes of this
            // transaction, which is exactly where Loro's text is at this point
            // since we apply the changes in order.
            tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
              if (toA > fromA) text.delete(fromB, toA - fromA);
              if (inserted.length > 0) text.insert(fromB, inserted.toString());
            });
            changed = true;
          }
          if (changed) {
            this.committing = true;
            try {
              doc.commit();
            } finally {
              this.committing = false;
            }
          }
        } catch (err) {
          // Loro rejects out-of-range edits, which only happens if we are
          // already out of sync. Loro is the source of truth, so snap back.
          console.error("loroSync: failed to apply local edit", err);
          this.queueResync();
        } finally {
          this.updating = false;
        }
      }

      destroy() {
        this.destroyed = true;
        this.unsubscribe();
      }

      private onLoroEvent(batch: LoroEventBatch) {
        // Our own commit is already in the editor. We filter on this flag
        // instead of `batch.by === "local"` because other local writers (the
        // UndoManager, file operations, a second editor on the same text)
        // also produce local events that this view must apply.
        if (this.committing) return;

        const specs: TransactionSpec[] = [];
        for (const event of batch.events) {
          if (event.target !== text.id || event.diff.type !== "text") continue;
          const changes = textDeltaToChanges(event.diff.diff);
          // Each event's delta is relative to the text after the previous
          // event, hence `sequential`.
          if (changes.length > 0) {
            specs.push({
              changes,
              sequential: true,
              annotations: loroRemote.of(true),
            });
          }
        }
        if (specs.length === 0) return;

        // When an import reorders concurrent tree ops, Loro replays them by
        // deleting and recreating the affected nodes, and re-announces the
        // child containers of a recreated node as a full insert of their
        // current content. Applied as a delta, that would duplicate the text,
        // so fall back to diffing against the final state.
        const treeReplayed = batch.events.some(
          (e) =>
            e.diff.type === "tree" &&
            e.diff.diff.some((item) => item.action === "create"),
        );
        if (treeReplayed) {
          if (this.updating) this.queueResync();
          else resetEditorToLoro(this.view, text);
          return;
        }

        if (this.updating) {
          // A Loro write triggered synchronously from inside our own update
          // (e.g. another subscriber reacting to our commit). CodeMirror
          // forbids nested dispatches, so catch up afterwards by diffing.
          this.queueResync();
          return;
        }

        try {
          this.view.dispatch(...specs);
        } catch (err) {
          console.error("loroSync: failed to apply remote change", err);
          resetEditorToLoro(this.view, text);
          return;
        }

        if (import.meta.env.DEV) {
          // Recovery path, not expected to trigger. A desync silently corrupts
          // every following edit because offsets no longer match, so in dev
          // we check after each remote batch and make the bug loud.
          const loroText = text.toString();
          if (this.view.state.doc.toString() !== loroText) {
            console.error(
              "loroSync: editor diverged from Loro text after remote change; resetting",
              { container: text.id, by: batch.by },
            );
            resetEditorToLoro(this.view, text);
          }
        }
      }

      private queueResync() {
        if (this.resyncQueued) return;
        this.resyncQueued = true;
        queueMicrotask(() => {
          this.resyncQueued = false;
          if (!this.destroyed) resetEditorToLoro(this.view, text);
        });
      }
    },
  );
  return [lfOnly, plugin];
}

/**
 * Creates an EditorState whose document is the current Loro text, with the
 * sync extension installed. `extensions` go after the binding.
 */
export function createLoroEditorState(
  { doc, text }: LoroSyncConfig,
  config: Omit<EditorStateConfig, "doc"> = {},
): EditorState {
  return EditorState.create({
    ...config,
    doc: text.toString(),
    extensions: [loroSync({ doc, text }), config.extensions ?? []],
  });
}
