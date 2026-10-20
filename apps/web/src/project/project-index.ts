import type { ContainerID, LoroDoc, LoroEventBatch, TreeID } from "loro-crdt";

import { getText } from "@/doc/fs-ops";
import { buildPathIndex, type PathIndex } from "@/doc/paths";
import { NODE, type PackageRecord, type ProjectDoc } from "@/doc/schema";
import { readFontBundles, readPackages } from "@/packages/records";
import type { FontAsset } from "@/typst/protocol";

export interface IndexedText {
  id: TreeID;
  path: string;
  container: ContainerID;
}

export interface IndexedAsset {
  id: TreeID;
  path: string;
  hash: string;
}

export interface ProjectIndexState {
  /** Kept as the same object while no path, kind or rename flag changes. */
  paths: PathIndex;
  /** Text files whose content container has arrived. */
  texts: ReadonlyMap<TreeID, IndexedText>;
  /** Asset files that carry a content hash, by path. */
  assets: ReadonlyMap<string, IndexedAsset>;
  mainFile: TreeID | null;
  /** Valid package records by key. Same object while none changed. */
  packages: ReadonlyMap<string, PackageRecord>;
  /** Built-in font bundles to load. Same array while equal. */
  fontAssets: readonly FontAsset[];
}

/** What one doc event batch changed, relative to the previous state. */
export interface ProjectIndexChange {
  state: ProjectIndexState;
  by: LoroEventBatch["by"];
  /** Commit origin of the batch, e.g. FOLDER_ORIGIN for the folder sync. */
  origin?: string;
  /** Text files whose content was edited, by their id before this batch. */
  edited: ReadonlySet<TreeID>;
  /**
   * The batch touched more than text content (tree, node metadata, meta,
   * peers, versions) and the index was rebuilt. The lists below are empty
   * when it is false.
   */
  structural: boolean;
  /** Previous entries of texts that went away or changed path or container. */
  textsRemoved: readonly IndexedText[];
  /** Texts that are new or changed path or container. */
  textsAdded: readonly IndexedText[];
  /** Previous entries of asset paths that went away or changed hash. */
  assetsRemoved: readonly IndexedAsset[];
  /** Asset paths that are new or changed hash. */
  assetsAdded: readonly IndexedAsset[];
  mainChanged: boolean;
  /** Packages that are new or changed their archive hash. */
  packagesAdded: PackageRecord[];
  /** Keys of packages that went away. */
  packagesRemoved: string[];
  fontAssetsChanged: boolean;
}

export type ProjectIndexListener = (change: ProjectIndexChange) => void;

const EMPTY_STATE: ProjectIndexState = {
  paths: { byPath: new Map(), byId: new Map() },
  texts: new Map(),
  assets: new Map(),
  mainFile: null,
  packages: new Map(),
  fontAssets: ["text"],
};

function samePackages(
  a: ReadonlyMap<string, PackageRecord>,
  b: ReadonlyMap<string, PackageRecord>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, record] of a) {
    const other = b.get(key);
    if (!other || JSON.stringify(other) !== JSON.stringify(record))
      return false;
  }
  return true;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function samePaths(a: PathIndex, b: PathIndex): boolean {
  if (a.byId.size !== b.byId.size || a.byPath.size !== b.byPath.size)
    return false;
  for (const [id, entry] of a.byId) {
    const other = b.byId.get(id);
    if (
      !other ||
      other.path !== entry.path ||
      other.kind !== entry.kind ||
      other.renamed !== entry.renamed
    )
      return false;
  }
  for (const [path, id] of a.byPath)
    if (b.byPath.get(path) !== id) return false;
  return true;
}

/**
 * Path index of one project, shared by everything that mirrors it (the
 * project store, the compiler and tinymist clients). Rebuilding it takes a
 * walk over every node, so it happens once per structural batch here instead
 * of once per consumer.
 */
export class ProjectIndex {
  private readonly project: ProjectDoc;
  private current: ProjectIndexState = EMPTY_STATE;
  private readonly idByContainer = new Map<ContainerID, TreeID>();
  private readonly listeners = new Set<ProjectIndexListener>();
  private unsubscribeDoc: (() => void) | null = null;

  constructor(project: ProjectDoc) {
    this.project = project;
  }

  /**
   * The current state. Without subscribers nothing tracks the doc, so this
   * rebuilds on every read until someone subscribes.
   */
  get state(): ProjectIndexState {
    if (!this.unsubscribeDoc) this.rebuild();
    return this.current;
  }

  /**
   * Calls `listener` after every doc event batch. A new subscriber starts
   * from `state`, read after subscribing.
   */
  subscribe(listener: ProjectIndexListener): () => void {
    if (!this.unsubscribeDoc) {
      // Whatever happened while nobody listened was not tracked.
      this.rebuild();
      this.unsubscribeDoc = this.project.doc.subscribe((batch) =>
        this.onDocEvent(batch),
      );
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribeDoc?.();
        this.unsubscribeDoc = null;
      }
    };
  }

  private onDocEvent(batch: LoroEventBatch): void {
    const edited = new Set<TreeID>();
    let structural = false;
    for (const event of batch.events) {
      const id =
        event.diff.type === "text"
          ? this.idByContainer.get(event.target)
          : undefined;
      // Tree moves, renames (node metadata maps), new content containers
      // and meta changes all count as structural. Rebuilding the path index
      // is cheap next to a compile, so there is no finer bookkeeping.
      if (id !== undefined) edited.add(id);
      else structural = true;
    }
    const prev = this.current;
    const change: ProjectIndexChange = structural
      ? {
          ...this.diff(prev, this.rebuild()),
          by: batch.by,
          origin: batch.origin,
          edited,
        }
      : {
          state: prev,
          by: batch.by,
          origin: batch.origin,
          edited,
          structural: false,
          textsRemoved: [],
          textsAdded: [],
          assetsRemoved: [],
          assetsAdded: [],
          mainChanged: false,
          packagesAdded: [],
          packagesRemoved: [],
          fontAssetsChanged: false,
        };
    for (const listener of [...this.listeners]) {
      // An earlier listener may have unsubscribed this one.
      if (!this.listeners.has(listener)) continue;
      try {
        listener(change);
      } catch (err) {
        console.error("project index listener failed", err);
      }
    }
  }

  private rebuild(): ProjectIndexState {
    const prev = this.current;
    const built = buildPathIndex(this.project);
    const paths = samePaths(prev.paths, built) ? prev.paths : built;
    const texts = new Map<TreeID, IndexedText>();
    const assets = new Map<string, IndexedAsset>();
    this.idByContainer.clear();
    for (const [id, entry] of paths.byId) {
      if (entry.kind === "text") {
        let container: ContainerID;
        try {
          container = getText(this.project, id).id;
        } catch {
          continue; // a text node whose content container has not arrived yet
        }
        const old = prev.texts.get(id);
        texts.set(
          id,
          old?.path === entry.path && old.container === container
            ? old
            : { id, path: entry.path, container },
        );
        this.idByContainer.set(container, id);
      } else if (entry.kind === "asset") {
        const hash: unknown = this.project.fs
          .getNodeByID(id)
          ?.data.get(NODE.hash);
        if (typeof hash !== "string") continue;
        const old = prev.assets.get(entry.path);
        assets.set(
          entry.path,
          old?.id === id && old.hash === hash
            ? old
            : { id, path: entry.path, hash },
        );
      }
    }
    const builtPackages = readPackages(this.project);
    const packages = samePackages(prev.packages, builtPackages)
      ? prev.packages
      : builtPackages;
    const bundles = readFontBundles(this.project);
    const wanted: FontAsset[] = ["text"];
    if (bundles.cjk) wanted.push("cjk");
    if (bundles.emoji) wanted.push("emoji");
    const fontAssets = sameList(prev.fontAssets, wanted)
      ? prev.fontAssets
      : wanted;
    this.current = {
      paths,
      texts,
      assets,
      mainFile: this.project.mainFile,
      packages,
      fontAssets,
    };
    return this.current;
  }

  private diff(
    prev: ProjectIndexState,
    next: ProjectIndexState,
  ): Omit<ProjectIndexChange, "by" | "edited"> {
    const textsRemoved: IndexedText[] = [];
    const textsAdded: IndexedText[] = [];
    for (const [id, file] of next.texts) {
      const old = prev.texts.get(id);
      if (old?.path === file.path && old.container === file.container) continue;
      if (old) textsRemoved.push(old);
      textsAdded.push(file);
    }
    for (const [id, old] of prev.texts)
      if (!next.texts.has(id)) textsRemoved.push(old);

    const assetsRemoved: IndexedAsset[] = [];
    const assetsAdded: IndexedAsset[] = [];
    for (const [path, asset] of next.assets) {
      const old = prev.assets.get(path);
      if (old?.hash === asset.hash) continue;
      if (old) assetsRemoved.push(old);
      assetsAdded.push(asset);
    }
    for (const [path, old] of prev.assets)
      if (!next.assets.has(path)) assetsRemoved.push(old);

    const packagesAdded: PackageRecord[] = [];
    const packagesRemoved: string[] = [];
    if (prev.packages !== next.packages) {
      for (const [key, record] of next.packages)
        if (prev.packages.get(key)?.hash !== record.hash)
          packagesAdded.push(record);
      for (const key of prev.packages.keys())
        if (!next.packages.has(key)) packagesRemoved.push(key);
    }

    return {
      state: next,
      structural: true,
      textsRemoved,
      textsAdded,
      assetsRemoved,
      assetsAdded,
      mainChanged: prev.mainFile !== next.mainFile,
      packagesAdded,
      packagesRemoved,
      fontAssetsChanged: prev.fontAssets !== next.fontAssets,
    };
  }
}

// Keyed by the LoroDoc: ProjectDoc is a stateless wrapper, and two wrappers
// around one doc must share the index.
const indexes = new WeakMap<LoroDoc, ProjectIndex>();

/** The shared index of `project`. */
export function projectIndex(project: ProjectDoc): ProjectIndex {
  let index = indexes.get(project.doc);
  if (!index) indexes.set(project.doc, (index = new ProjectIndex(project)));
  return index;
}
