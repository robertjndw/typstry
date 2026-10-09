// Names must stay in sync with crates/typstry-doc/src/lib.rs, which models
// the same containers in Rust. The server itself never reads them: it only
// stores the doc encrypted.
import {
  LoroText,
  type LoroDoc,
  type LoroList,
  type LoroMap,
  type LoroTree,
  type LoroTreeNode,
  type TreeID,
} from "loro-crdt";

/** Bumped whenever the document layout changes incompatibly. */
export const SCHEMA_VERSION = 1;

export const ROOT = {
  meta: "meta",
  peers: "peers",
  fs: "fs",
  /** List of named versions, see versions.ts. */
  versions: "versions",
} as const;

export const META = {
  schema: "schema",
  title: "title",
  mainFile: "mainFile",
} as const;

export const NODE = {
  kind: "kind",
  name: "name",
  content: "content",
  hash: "hash",
  size: "size",
  mime: "mime",
} as const;

export const FILE_KINDS = ["dir", "text", "asset"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export function isFileKind(value: unknown): value is FileKind {
  return (
    typeof value === "string" &&
    (FILE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Commit origin of `setPeer`. Undo managers exclude it, so Ctrl+Z in the
 * editor never reverts who you are.
 */
export const PEER_INFO_ORIGIN = "typstry:peer-info";

/**
 * Commit origin for bookkeeping that is not an edit of the project (named
 * versions). Starts with PEER_INFO_ORIGIN so the existing undo exclusion
 * prefix covers it too.
 */
export const META_ORIGIN = `${PEER_INFO_ORIGIN}:meta`;

/** Longest title the UI accepts for a project. */
export const MAX_TITLE_CHARS = 200;

/**
 * Loro merges consecutive local commits into one change while they are at
 * most this many seconds apart. Changes are the unit of history (each has one
 * timestamp), so this bounds how precisely edits can be placed in time. 30 s
 * is far below the 5 minute session gap of history.ts and still collapses a
 * typing burst (one commit per keystroke) into a handful of changes.
 * Commits with a different message never merge, so file operations always
 * stay separate.
 */
export const CHANGE_MERGE_INTERVAL_S = 30;

export interface PeerInfo {
  name: string;
  color: string;
}

export interface AssetInfo {
  hash: string;
  size: number;
  mime: string;
}

export const DEFAULT_MAIN_FILE = "main.typ";

export function starterContent(title: string): string {
  return `#set document(title: ${JSON.stringify(title)})\n#set page(paper: "a4")\n\n= ${title}\n\nHello, Typst!\n`;
}

/** Typed view over a project's LoroDoc. Holds no state besides the doc. */
export class ProjectDoc {
  readonly doc: LoroDoc;

  constructor(doc: LoroDoc) {
    this.doc = doc;
    // Sibling order is meaningless for a file tree (the UI sorts by name),
    // and fractional indexes only bloat every create/move op. This is a
    // local setting on the doc state, not synced, so every wrapper sets it.
    this.fs.disableFractionalIndex();
    // Also local settings. History needs wall-clock times on changes, and
    // every session doc is created through this wrapper before its first
    // commit, so this is the one place that covers all of them.
    doc.setRecordTimestamp(true);
    doc.setChangeMergeInterval(CHANGE_MERGE_INTERVAL_S);
  }

  get meta(): LoroMap {
    return this.doc.getMap(ROOT.meta);
  }

  get peers(): LoroMap {
    return this.doc.getMap(ROOT.peers);
  }

  get fs(): LoroTree {
    return this.doc.getTree(ROOT.fs);
  }

  get versions(): LoroList {
    return this.doc.getList(ROOT.versions);
  }

  get schemaVersion(): number | null {
    const value = this.meta.get(META.schema);
    return typeof value === "number" ? value : null;
  }

  get title(): string {
    const value = this.meta.get(META.title);
    return typeof value === "string" ? value : "";
  }

  /**
   * The main file, or null when unset or when it no longer resolves to a
   * live node (a remote peer may delete it without clearing the field).
   */
  get mainFile(): TreeID | null {
    const value = this.meta.get(META.mainFile);
    if (typeof value !== "string") return null;
    const id = value as TreeID;
    return this.liveNode(id) ? id : null;
  }

  /** The node, or null when it does not exist (yet) or was deleted. */
  liveNode(id: TreeID): LoroTreeNode | null {
    if (!this.fs.has(id) || this.fs.isNodeDeleted(id)) return null;
    return this.fs.getNodeByID(id) ?? null;
  }

  getPeer(peerId: string): PeerInfo | undefined {
    const value = this.peers.get(peerId) as Partial<PeerInfo> | undefined;
    if (typeof value?.name !== "string" || typeof value.color !== "string")
      return undefined;
    return { name: value.name, color: value.color };
  }

  setPeer(peerId: string, info: PeerInfo): void {
    this.peers.set(peerId, { name: info.name, color: info.color });
    this.doc.commit({ message: "set peer info", origin: PEER_INFO_ORIGIN });
  }
}

/**
 * Seeds an empty doc with the schema version, title and a main.typ. Does
 * nothing if the doc already carries a schema version.
 */
export function initProject(
  target: LoroDoc | ProjectDoc,
  opts: { title: string },
): ProjectDoc {
  const project =
    target instanceof ProjectDoc ? target : new ProjectDoc(target);
  if (project.schemaVersion !== null) return project;

  const node = project.fs.createNode();
  node.data.set(NODE.kind, "text");
  node.data.set(NODE.name, DEFAULT_MAIN_FILE);
  const content = node.data.setContainer(NODE.content, new LoroText());
  content.insert(0, starterContent(opts.title));

  project.meta.set(META.schema, SCHEMA_VERSION);
  project.meta.set(META.title, opts.title);
  project.meta.set(META.mainFile, node.id);
  project.doc.commit({ message: "init project" });
  return project;
}
