import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import type { TreeID } from "loro-crdt";
import { createContext, useContext, useSyncExternalStore } from "react";

export interface EditorCursor {
  fileId: TreeID;
  /** UTF-16 offset of the selection head. */
  head: number;
}

/**
 * Where the local cursor is, for panels that follow it (the outline). Kept
 * outside React state so a keystroke re-renders only its subscribers, not
 * the workspace.
 */
export class CursorStore {
  private cursor: EditorCursor | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = () => this.cursor;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  set(cursor: EditorCursor | null) {
    const prev = this.cursor;
    if (prev?.fileId === cursor?.fileId && prev?.head === cursor?.head) return;
    this.cursor = cursor;
    for (const listener of [...this.listeners]) listener();
  }
}

export const CursorContext = createContext<CursorStore | null>(null);

/** The local cursor, or null before any editor has reported one. */
export function useEditorCursor(): EditorCursor | null {
  const store = useContext(CursorContext);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? noSnapshot,
  );
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** Reports the selection head of one file's editor to `store`. */
export function reportCursor(store: CursorStore, fileId: TreeID): Extension {
  return ViewPlugin.define((view) => {
    store.set({ fileId, head: view.state.selection.main.head });
    return {
      update(update) {
        if (update.selectionSet || update.docChanged)
          store.set({ fileId, head: update.state.selection.main.head });
      },
      destroy() {
        // The next editor may already have reported; only clear our own.
        const current = store.getSnapshot();
        if (current?.fileId === fileId) store.set(null);
      },
    };
  });
}
