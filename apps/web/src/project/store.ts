import { UndoManager, type LoroEventBatch, type TreeID } from "loro-crdt";

import type { PathIndex } from "@/doc/paths";
import { PEER_INFO_ORIGIN, type FileKind, type ProjectDoc } from "@/doc/schema";
import { FOLDER_ORIGIN } from "@/folder/origin";

import { loadOpenTabs, saveOpenTabs, type OpenTabs } from "./open-tabs";
import {
  projectIndex,
  type ProjectIndex,
  type ProjectIndexChange,
  type ProjectIndexState,
} from "./project-index";

/**
 * Commits closer together than this merge into one undo step. Loro has no
 * getter, so whoever temporarily changes it needs this to put it back.
 */
export const UNDO_MERGE_INTERVAL_MS = 1000;

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
  /**
   * Remembers the tabs under this id in the browser and reopens them the
   * next time. Without it every store starts with just the main file.
   */
  projectId?: string;
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
  private readonly index: ProjectIndex;
  private snapshot: ProjectSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeIndex: (() => void) | null = null;
  private readonly options: ProjectStoreOptions;
  /** What was last written to storage, to skip writes that change nothing. */
  private saved: Pick<ProjectSnapshot, "tabs" | "openFileId">;
  /**
   * Saved tabs not all restored yet. Nothing is saved meanwhile, or the
   * partial set would overwrite them.
   */
  private pending: OpenTabs | null = null;

  constructor(project: ProjectDoc, options: ProjectStoreOptions = {}) {
    this.project = project;
    this.options = options;
    this.undoManager = new UndoManager(project.doc, {
      mergeInterval: UNDO_MERGE_INTERVAL_MS,
      excludeOriginPrefixes: [PEER_INFO_ORIGIN, FOLDER_ORIGIN],
    });
    this.index = projectIndex(project);
    this.snapshot = this.initial();
    this.saved = this.pending
      ? { tabs: this.pending.tabs, openFileId: this.pending.open }
      : this.snapshot;
  }

  private initial(): ProjectSnapshot {
    const state = this.index.state;
    const main = this.project.mainFile;
    const fallback = this.compute(state, main, main ? [main] : []);
    const saved =
      this.options.projectId !== undefined
        ? loadOpenTabs(this.options.projectId)
        : null;
    if (!saved) return fallback;
    const restored = this.restore(state, saved);
    // The doc this browser kept can lag behind the server, so a saved tab
    // may only be missing until the first sync. Deleted is decided then.
    if (restored?.tabs.length !== saved.tabs.length) this.pending = saved;
    return restored ? { ...fallback, ...restored } : fallback;
  }

  /**
   * The saved tabs that exist in `state`, or null when none of them do: an
   * empty editor would look like the project lost its files.
   */
  private restore(
    state: ProjectIndexState,
    saved: OpenTabs,
  ): Pick<ProjectSnapshot, "tabs" | "openFileId"> | null {
    const { tabs, openFileId } = this.compute(state, saved.open, saved.tabs);
    if (tabs.length === 0 && saved.tabs.length > 0) return null;
    return { tabs, openFileId: openFileId ?? tabs[0] ?? null };
  }

  /**
   * Call once the project has caught up with the server. Saved tabs still
   * missing by then were deleted, and the tabs start being saved again.
   */
  settle(): void {
    if (!this.pending) return;
    this.pending = null;
    this.save();
  }

  getSnapshot = (): ProjectSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.unsubscribeIndex) {
      this.unsubscribeIndex = this.index.subscribe((change) =>
        this.onIndexChange(change),
      );
      // Changes made while nobody was listening were not tracked.
      this.refresh("local", this.index.state);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribeIndex?.();
        this.unsubscribeIndex = null;
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
    // Picking tabs by hand settles what the saved ones were for.
    this.pending = null;
    // Undo history is per session of one file: undoing in a file you just
    // switched to must not revert edits in one you can no longer see.
    if (id !== this.snapshot.openFileId) this.undoManager.clear();
    this.snapshot = { ...this.snapshot, openFileId: id, tabs };
    this.emit();
  }

  private onIndexChange(change: ProjectIndexChange): void {
    if (change.structural) this.refresh(change.by, change.state);
  }

  private refresh(by: LoroEventBatch["by"], state: ProjectIndexState): void {
    const prev = this.snapshot;
    // Peers, versions and most meta writes leave the snapshot as it was. A
    // new object would still re-render everything under ProjectProvider.
    // With the same index the tabs and open file cannot have changed either.
    if (
      state.paths === prev.index &&
      state.mainFile === prev.mainFile &&
      this.project.title === prev.title
    )
      return;
    this.snapshot = this.compute(state, prev.openFileId, prev.tabs);
    if (this.pending) {
      const restored = this.restore(state, this.pending);
      if (restored?.tabs.length === this.pending.tabs.length)
        this.pending = null;
      if (restored) {
        if (restored.openFileId !== prev.openFileId) this.undoManager.clear();
        this.snapshot = { ...this.snapshot, ...restored };
        this.emit();
        return;
      }
    }
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
    state: ProjectIndexState,
    openFileId: TreeID | null,
    tabs: readonly TreeID[],
  ): ProjectSnapshot {
    const index = state.paths;
    const live = tabs.filter((id) => isOpenable(index.byId.get(id)?.kind));
    return {
      index,
      mainFile: state.mainFile,
      title: this.project.title,
      openFileId:
        openFileId !== null && live.includes(openFileId) ? openFileId : null,
      tabs: live,
    };
  }

  private emit(): void {
    this.save();
    for (const listener of this.listeners) listener();
  }

  private save(): void {
    const { projectId } = this.options;
    const { tabs, openFileId } = this.snapshot;
    if (projectId === undefined || this.pending) return;
    if (tabs === this.saved.tabs && openFileId === this.saved.openFileId)
      return;
    this.saved = { tabs, openFileId };
    saveOpenTabs(projectId, { tabs, open: openFileId });
  }

  /** Lets go of the doc. The store is unusable afterwards. */
  dispose(): void {
    this.listeners.clear();
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    this.undoManager.free();
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
