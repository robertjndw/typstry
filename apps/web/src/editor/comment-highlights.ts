import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { LoroEventBatch, LoroText, TreeID } from "loro-crdt";

import { listThreads, resolveAnchor } from "@/doc/comments";
import type { ProjectDoc } from "@/doc/schema";
import type { CommentsUi } from "@/project/comments-ui";

export interface CommentHighlightsConfig {
  project: ProjectDoc;
  text: LoroText;
  fileId: TreeID;
  ui: CommentsUi;
}

const THREAD_ATTR = "data-comment-thread";

const setHighlights = StateEffect.define<DecorationSet>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Keeps highlights in place while typing, until the next recompute
    // reads the anchors again.
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlights)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Marks the ranges of this file's open comment threads. Clicking one puts
 * its thread in focus, which the panel scrolls to.
 */
export function commentHighlights(config: CommentHighlightsConfig): Extension {
  const { project, text, fileId, ui } = config;
  const watched = new Set<string>([
    project.comments.id,
    project.resolvedComments.id,
  ]);

  const plugin = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly unsubscribes: (() => void)[];
      private queued = false;
      private destroyed = false;

      constructor(view: EditorView) {
        this.view = view;
        this.unsubscribes = [
          ui.subscribe(() => this.schedule()),
          project.doc.subscribe((batch: LoroEventBatch) => {
            const touches = batch.events.some(
              (e) =>
                watched.has(e.target) ||
                // A restore or a remote replacement swaps the file's text
                // container or deletes the file, which detaches its threads
                // without any event on the comment lists.
                (e.diff.type !== "text" && e.target !== text.id) ||
                // Local edits came from this editor and are already mapped.
                // Remote ones are recomputed, since Loro may merge them
                // around an anchor differently than the mapping guesses.
                (batch.by !== "local" && e.target === text.id),
            );
            if (touches) this.schedule();
          }),
        ];
        this.schedule();
      }

      destroy() {
        this.destroyed = true;
        for (const unsubscribe of this.unsubscribes) unsubscribe();
      }

      // Same reason as in remote-cursors.ts: doc events can arrive in the
      // middle of the binding's own dispatch.
      private schedule() {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (!this.destroyed) this.recompute();
        });
      }

      private recompute() {
        const { active } = ui.getState();
        const length = this.view.state.doc.length;
        const ranges: Range<Decoration>[] = [];
        for (const thread of listThreads(project)) {
          if (thread.resolvedAt !== null || thread.root.fileId !== fileId)
            continue;
          const range = resolveAnchor(project, thread.root);
          if (!range) continue;
          const to = Math.min(range.to, length);
          if (range.from >= to) continue;
          ranges.push(
            Decoration.mark({
              class:
                thread.id === active
                  ? "cm-comment cm-comment-active"
                  : "cm-comment",
              attributes: { [THREAD_ATTR]: thread.id },
            }).range(range.from, to),
          );
        }
        if (
          ranges.length === 0 &&
          this.view.state.field(highlightField).size === 0
        ) {
          return;
        }
        this.view.dispatch({
          effects: setHighlights.of(Decoration.set(ranges, true)),
        });
      }
    },
  );

  const clicks = EditorView.domEventHandlers({
    click(event) {
      const target = event.target;
      if (!(target instanceof Element)) return false;
      const id = target.closest(`[${THREAD_ATTR}]`)?.getAttribute(THREAD_ATTR);
      if (!id) return false;
      ui.showThread(id);
      // The click still places the caret.
      return false;
    },
  });

  return [highlightField, plugin, clicks];
}

/** For tests: the highlighted ranges, with whether each one is active. */
export function commentHighlightRanges(
  view: EditorView,
): { id: string; from: number; to: number; active: boolean }[] {
  const out: { id: string; from: number; to: number; active: boolean }[] = [];
  const set = view.state.field(highlightField, false) ?? Decoration.none;
  set.between(0, view.state.doc.length, (from, to, deco) => {
    const attrs = deco.spec.attributes as Record<string, string> | undefined;
    const cls = deco.spec.class as string | undefined;
    out.push({
      id: attrs?.[THREAD_ATTR] ?? "",
      from,
      to,
      active: cls?.includes("cm-comment-active") ?? false,
    });
  });
  return out;
}

/**
 * For editors only: reports the selection to the shared comments state, so
 * the shortcut and the panel's button can start a comment on it.
 */
export function commentSelection(
  ui: CommentsUi,
  fileId: TreeID,
  text: LoroText,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private reported: Parameters<CommentsUi["clearSelection"]>[0] | null =
        null;
      constructor(view: EditorView) {
        this.report(view.state);
      }
      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged) this.report(update.state);
      }
      destroy() {
        if (this.reported) ui.clearSelection(this.reported);
      }
      private report(state: EditorState) {
        const { from, to } = state.selection.main;
        this.reported = { fileId, text, from, to };
        ui.setSelection(this.reported);
      }
    },
  );
}
