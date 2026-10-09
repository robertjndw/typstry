import { UndoManager, type LoroEventBatch, type TreeID } from "loro-crdt";

import { buildPathIndex, type PathIndex } from "@/doc/paths";
import { PEER_INFO_ORIGIN, type FileKind, type ProjectDoc } from "@/doc/schema";

function isOpenable(kind: FileKind | undefined): boolean {
  return kind === "text" || kind === "asset";
}

export interface ProjectSnapshot {
  index: PathIndex;
  mainFile: TreeID | null;
  title: string;
  openFileId: TreeID | null;
  /** Files open as editor tabs, in tab order. Includes `openFileId`. */
  tabs: readonly TreeID[];
}

export interface ProjectStoreOptions {
  /** Called when a remote change removes the file that is open here. */
  onOpenFileRemoved?: (path: string) => void;
}

/**
 * External store behind ProjectProvider. Keeping the open file and tabs in
 * here rather than in React state means a deletion can close them in the
 * same snapshot that removes the file from the tree, so the editor never
 * renders a dead text container.
 */
export class ProjectStore {
  readonly project: ProjectDoc;
  readonly undoManager: UndoManager;
  private snapshot: ProjectSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeDoc: (() => void) | null = null;
  private readonly options: ProjectStoreOptions;

  constructor(project: ProjectDoc, options: ProjectStoreOptions = {}) {
    this.project = project;
    this.options = options;
    this.undoManager = new UndoManager(project.doc, {
      excludeOriginPrefixes: [PEER_INFO_ORIGIN],
    });
    const main = project.mainFile;
    this.snapshot = this.compute(main, main ? [main] : []);
  }

  getSnapshot = (): ProjectSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.unsubscribeDoc) {
      this.unsubscribeDoc = this.project.doc.subscribe((batch) =>
        this.onDocEvent(batch),
      );
      // Changes made while nobody was listening were not tracked.
      this.refresh("local");
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribeDoc?.();
        this.unsubscribeDoc = null;
      }
    };
  };

  /** Opens a file (text or asset), adding a tab next to the active one. */
  open(id: TreeID): void {
    if (!isOpenable(this.snapshot.index.byId.get(id)?.kind)) return;
    const { tabs, openFileId } = this.snapshot;
    if (id === openFileId) return;
    const at = openFileId === null ? -1 : tabs.indexOf(openFileId);
    this.activate(
      id,
      tabs.includes(id)
        ? tabs
        : tabs.toSpliced(at === -1 ? tabs.length : at + 1, 0, id),
    );
  }

  /** Closes a tab; closing the active one moves to its neighbor. */
  close(id: TreeID): void {
    const { tabs, openFileId } = this.snapshot;
    if (!tabs.includes(id)) return;
    const nextTabs = tabs.filter((t) => t !== id);
    this.activate(
      id === openFileId ? neighbor(tabs, nextTabs, id) : openFileId,
      nextTabs,
    );
  }

  private activate(id: TreeID | null, tabs: readonly TreeID[]): void {
    // Undo history is per session of one file: undoing in a file you just
    // switched to must not revert edits in one you can no longer see.
    if (id !== this.snapshot.openFileId) this.undoManager.clear();
    this.snapshot = { ...this.snapshot, openFileId: id, tabs };
    this.emit();
  }

  private onDocEvent(batch: LoroEventBatch): void {
    if (batch.events.every((e) => e.diff.type === "text")) return;
    this.refresh(batch.by);
  }

  private refresh(by: LoroEventBatch["by"]): void {
    const prev = this.snapshot;
    this.snapshot = this.compute(prev.openFileId, prev.tabs);
    const removed = prev.openFileId;
    if (removed === null || this.snapshot.openFileId !== null) {
      this.emit();
      return;
    }
    const path = prev.index.byId.get(removed)?.path;
    if (by === "import" && path) this.options.onOpenFileRemoved?.(path);
    // Same fallback as closing the tab by hand.
    const tabs = this.snapshot.tabs;
    this.activate(neighbor(prev.tabs, tabs, removed), tabs);
  }

  private compute(
    openFileId: TreeID | null,
    tabs: readonly TreeID[],
  ): ProjectSnapshot {
    const index = buildPathIndex(this.project);
    const live = tabs.filter((id) => isOpenable(index.byId.get(id)?.kind));
    return {
      index,
      mainFile: this.project.mainFile,
      title: this.project.title,
      openFileId:
        openFileId !== null && live.includes(openFileId) ? openFileId : null,
      tabs: live,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The tab after `closed` that's still open, else the one before it. */
function neighbor(
  before: readonly TreeID[],
  after: readonly TreeID[],
  closed: TreeID,
): TreeID | null {
  const kept = before
    .slice(0, before.indexOf(closed))
    .filter((t) => after.includes(t)).length;
  return after[kept] ?? after[kept - 1] ?? null;
}
