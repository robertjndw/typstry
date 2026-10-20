import type { LoroEventBatch, TreeID } from "loro-crdt";
import { useMemo, useSyncExternalStore } from "react";

import { listThreads, resolveAnchor, type CommentThread } from "@/doc/comments";
import type { PathIndex } from "@/doc/paths";
import type { ProjectDoc } from "@/doc/schema";

export type CommentScope = "file" | "all";

export interface ThreadView {
  thread: CommentThread;
  /** Where the root's range is now, null once it is detached. */
  range: { from: number; to: number } | null;
}

/**
 * A value derived from the doc, recomputed lazily after every event batch
 * `relevant` accepts, so a burst of remote updates costs one recompute.
 */
function docStore<T>(
  project: ProjectDoc,
  compute: () => T,
  relevant: (batch: LoroEventBatch) => boolean,
) {
  let value: T;
  let stale = true;
  return {
    subscribe: (listener: () => void) => {
      // The first value was read during render, before this subscription, so
      // a batch that landed in between would otherwise never show up.
      stale = true;
      return project.doc.subscribe((batch) => {
        if (!relevant(batch)) return;
        stale = true;
        listener();
      });
    },
    get: (): T => {
      if (stale) {
        value = compute();
        stale = false;
      }
      return value;
    },
  };
}

function touchesComments(project: ProjectDoc, batch: LoroEventBatch) {
  const ids = [project.comments.id, project.resolvedComments.id];
  return batch.events.some((e) => ids.includes(e.target));
}

/**
 * Every thread with its current range. Ranges move with any text edit, so
 * this follows every change to the doc; mount it only where the list is
 * on screen.
 */
export function useComments(project: ProjectDoc): ThreadView[] {
  const store = useMemo(
    () =>
      docStore(
        project,
        () =>
          listThreads(project).map((thread) => ({
            thread,
            range: resolveAnchor(project, thread.root),
          })),
        () => true,
      ),
    [project],
  );
  return useSyncExternalStore(store.subscribe, store.get);
}

/** How many threads are open, for the tab badge. Ignores text edits. */
export function useUnresolvedCount(project: ProjectDoc): number {
  const store = useMemo(
    () =>
      docStore(
        project,
        () => listThreads(project).filter((t) => t.resolvedAt === null).length,
        (batch) => touchesComments(project, batch),
      ),
    [project],
  );
  return useSyncExternalStore(store.subscribe, store.get);
}

function byPosition(a: ThreadView, b: ThreadView): number {
  return (
    (a.range?.from ?? 0) - (b.range?.from ?? 0) ||
    a.thread.root.createdAt - b.thread.root.createdAt ||
    (a.thread.id < b.thread.id ? -1 : 1)
  );
}

/**
 * Splits the threads in scope into the ones still anchored, in document
 * order (by path first across files), and the detached ones.
 */
export function arrangeThreads(
  threads: readonly ThreadView[],
  options: {
    scope: CommentScope;
    openFileId: TreeID | null;
    showResolved: boolean;
    index: PathIndex;
  },
): { attached: ThreadView[]; detached: ThreadView[] } {
  const { scope, openFileId, showResolved, index } = options;
  const shown = threads.filter(
    (t) =>
      (showResolved || t.thread.resolvedAt === null) &&
      (scope === "all" || t.thread.root.fileId === openFileId),
  );
  const path = (t: ThreadView) => index.byId.get(t.thread.root.fileId)?.path;
  const attached = shown
    .filter((t) => t.range !== null)
    .sort((a, b) => {
      const pa = path(a) ?? "";
      const pb = path(b) ?? "";
      return pa < pb ? -1 : pa > pb ? 1 : byPosition(a, b);
    });
  const detached = shown
    .filter((t) => t.range === null)
    .sort((a, b) => a.thread.root.createdAt - b.thread.root.createdAt);
  return { attached, detached };
}
