// What the editor and the Comments panel share while nobody has written to
// the doc yet: the thread in focus and a comment being drafted. Lives
// outside React so the editor's CodeMirror extensions can read and change
// it without re-rendering the editor.
import type { ContainerID, LoroText, TreeID } from "loro-crdt";
import { createContext, useContext, useSyncExternalStore } from "react";

import { encodeRange } from "@/doc/cursors";

/** A selection about to be commented on, pinned with Loro cursors. */
export interface CommentDraft {
  fileId: TreeID;
  textId: ContainerID;
  /** Cursors on the first and the last selected character, like a record. */
  anchor: Uint8Array;
  head: Uint8Array;
  /** The selected text when the draft was started, for the preview. */
  quote: string;
}

export interface CommentsUiState {
  active: string | null;
  draft: CommentDraft | null;
}

interface Selection {
  fileId: TreeID;
  text: LoroText;
  from: number;
  to: number;
}

export class CommentsUi {
  private state: CommentsUiState = { active: null, draft: null };
  private selection: Selection | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly panelListeners = new Set<(focus: boolean) => void>();

  /**
   * Called whenever the Comments tab should come up. `focus` is false for
   * a click into highlighted text, which must leave the caret in the
   * editor.
   */
  onShowPanel(listener: (focus: boolean) => void): () => void {
    this.panelListeners.add(listener);
    return () => this.panelListeners.delete(listener);
  }

  private showPanel(focus: boolean): void {
    for (const listener of [...this.panelListeners]) listener(focus);
  }

  getState = (): CommentsUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setActive(active: string | null): void {
    if (active === this.state.active) return;
    this.update({ active });
  }

  /** Puts a thread in focus and shows it in the panel. */
  showThread(id: string): void {
    this.setActive(id);
    this.showPanel(false);
  }

  /**
   * The editor's selection, kept so the shortcut and the menu can start a
   * draft without asking the editor. Changes no state anyone renders.
   */
  setSelection(selection: Selection | null): void {
    this.selection = selection;
  }

  /** Clears the selection only if it still belongs to `fileId`. */
  clearSelection(fileId: TreeID): void {
    if (this.selection?.fileId === fileId) this.selection = null;
  }

  hasSelection(): boolean {
    const s = this.selection;
    return s !== null && s.from < s.to;
  }

  /**
   * Starts a draft on the last reported selection. False when there is no
   * text selected. The range is pinned right away, so edits while the
   * comment is being written move it along instead of shifting it.
   */
  startDraft(): boolean {
    const s = this.selection;
    if (!s || s.from >= s.to) return false;
    const range = encodeRange(s.text, s.from, s.to);
    if (!range) return false;
    this.update({
      draft: { fileId: s.fileId, textId: s.text.id, ...range },
    });
    this.showPanel(true);
    return true;
  }

  cancelDraft(): void {
    if (this.state.draft) this.update({ draft: null });
  }

  private update(patch: Partial<CommentsUiState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

export const CommentsUiContext = createContext<CommentsUi | null>(null);

/** Null outside ProjectWorkspace, e.g. in a version view. */
export function useCommentsUi(): CommentsUi | null {
  return useContext(CommentsUiContext);
}

const EMPTY: CommentsUiState = { active: null, draft: null };
const noop = () => () => {};

export function useCommentsUiState(ui: CommentsUi | null): CommentsUiState {
  return useSyncExternalStore(
    ui ? ui.subscribe : noop,
    ui ? ui.getState : () => EMPTY,
  );
}
