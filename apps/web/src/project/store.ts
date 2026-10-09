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
}

export interface ProjectStoreOptions {
  /** Called when a remote change removes the file that is open here. */
  onOpenFileRemoved?: (path: string) => void;
}

/**
 * External store behind ProjectProvider. Keeping the open file in here
 * rather than in React state means a deletion can close it in the same
 * snapshot that removes it from the tree, so the editor never renders a
 * dead text container.
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
    this.snapshot = this.compute(project.mainFile);
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

  /** Opens a file (text or asset), or closes the editor with null. */
  open(id: TreeID | null): void {
    if (id !== null && !isOpenable(this.snapshot.index.byId.get(id)?.kind)) {
      return;
    }
    if (id === this.snapshot.openFileId) return;
    // Undo history is per session of one file: undoing in a file you just
    // switched to must not revert edits in one you can no longer see.
    this.undoManager.clear();
    this.snapshot = { ...this.snapshot, openFileId: id };
    this.emit();
  }

  private onDocEvent(batch: LoroEventBatch): void {
    if (batch.events.every((e) => e.diff.type === "text")) return;
    this.refresh(batch.by);
  }

  private refresh(by: LoroEventBatch["by"]): void {
    const prev = this.snapshot;
    const next = this.compute(prev.openFileId);
    if (prev.openFileId !== null && next.openFileId === null) {
      const path = prev.index.byId.get(prev.openFileId)?.path;
      if (by === "import" && path) this.options.onOpenFileRemoved?.(path);
    }
    this.snapshot = next;
    this.emit();
  }

  private compute(openFileId: TreeID | null): ProjectSnapshot {
    const index = buildPathIndex(this.project);
    return {
      index,
      mainFile: this.project.mainFile,
      title: this.project.title,
      openFileId:
        openFileId !== null && isOpenable(index.byId.get(openFileId)?.kind)
          ? openFileId
          : null,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
