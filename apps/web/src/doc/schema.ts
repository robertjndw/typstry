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

/**
 * Bumped when an older client writing into the doc would corrupt it.
 * Additive data older clients can ignore (like deletedVersions) does not
 * count. Docs are never rewritten wholesale, so readers keep handling every
 * schema from 1 up. Must match SCHEMA_VERSION in crates/typstry-doc.
 */
export const SCHEMA_VERSION = 1;

export const ROOT = {
  meta: "meta",
  peers: "peers",
  fs: "fs",
  /** List of named versions, see versions.ts. */
  versions: "versions",
  /** Map of deleted named versions, see versions.ts. */
  deletedVersions: "deletedVersions",
  /**
   * Map of project packages, keyed `namespace/name/version` (packageKey in
   * packages/spec.ts). Values are plain PackageRecord objects, so replacing
   * a package is one atomic write and concurrent writers resolve last
   * writer wins per package. The archive itself is an asset blob.
   */
  packages: "packages",
  /** List of comments and replies, see comments.ts. */
  comments: "comments",
  /** Map of resolved comment threads, see comments.ts. */
  resolvedComments: "resolvedComments",
} as const;

export const META = {
  /** Which kind of doc this is, see DOC_KIND. */
  kind: "kind",
  schema: "schema",
  title: "title",
  mainFile: "mainFile",
  /**
   * Booleans enabling the built-in CJK and emoji font bundles. Two keys
   * rather than a list so two people toggling different bundles at once
   * don't overwrite each other.
   */
  cjkFonts: "cjkFonts",
  emojiFonts: "emojiFonts",
} as const;

/**
 * Values of META.kind. A project link must never open a directory, nor the
 * other way around. Absent on docs written before the marker existed, which
 * are projects.
 */
export const DOC_KIND = {
  project: "project",
  directory: "directory",
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

/**
 * Commit origin of every comment write. Under PEER_INFO_ORIGIN for the same
 * reason: Ctrl+Z in the editor must not take back a comment, nor bring
 * back one that was deleted.
 */
export const COMMENT_ORIGIN = `${PEER_INFO_ORIGIN}:comment`;

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

/** Field names of a PackageRecord as stored in ROOT.packages. */
export const PACKAGE = {
  namespace: "namespace",
  name: "name",
  version: "version",
  hash: "hash",
  size: "size",
  mime: "mime",
  entrypoint: "entrypoint",
  description: "description",
  authors: "authors",
  license: "license",
  compiler: "compiler",
  fileCount: "fileCount",
  unpackedSize: "unpackedSize",
  source: "source",
  addedAt: "addedAt",
} as const;

export const PACKAGE_SOURCES = ["upload", "universe"] as const;
export type PackageSource = (typeof PACKAGE_SOURCES)[number];

/**
 * A package stored in the project. `hash`/`size`/`mime` describe the
 * canonical .tar.gz blob in the project's assets; name and version always
 * match the archive's typst.toml, because Typst rejects a package whose
 * manifest disagrees with the import.
 */
export interface PackageRecord {
  namespace: string;
  name: string;
  version: string;
  hash: string;
  size: number;
  mime: string;
  entrypoint: string;
  description?: string;
  authors?: string[];
  license?: string;
  /** Minimum compiler version from the manifest, if any. */
  compiler?: string;
  fileCount: number;
  unpackedSize: number;
  source: PackageSource;
  /** Unix ms. */
  addedAt: number;
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

  get deletedVersions(): LoroMap {
    return this.doc.getMap(ROOT.deletedVersions);
  }

  get packages(): LoroMap {
    return this.doc.getMap(ROOT.packages);
  }

  get comments(): LoroList {
    return this.doc.getList(ROOT.comments);
  }

  get resolvedComments(): LoroMap {
    return this.doc.getMap(ROOT.resolvedComments);
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
 * Seeds an empty doc with the schema version, title and, unless `starter` is
 * false, a main.typ. Does nothing if the doc already carries a schema version.
 */
export function initProject(
  target: LoroDoc | ProjectDoc,
  opts: { title: string; starter?: boolean },
): ProjectDoc {
  const project =
    target instanceof ProjectDoc ? target : new ProjectDoc(target);
  if (project.schemaVersion !== null) return project;

  if (opts.starter !== false) {
    const node = project.fs.createNode();
    node.data.set(NODE.kind, "text");
    node.data.set(NODE.name, DEFAULT_MAIN_FILE);
    const content = node.data.setContainer(NODE.content, new LoroText());
    content.insert(0, starterContent(opts.title));
    project.meta.set(META.mainFile, node.id);
  }

  project.meta.set(META.kind, DOC_KIND.project);
  project.meta.set(META.schema, SCHEMA_VERSION);
  project.meta.set(META.title, opts.title);
  project.doc.commit({ message: "init project" });
  return project;
}

// What the editor shows when isForeignKind or isSchemaTooNew turns a doc
// away. They say "project" because a project is the only kind of space
// people see so far.
export const NOT_A_PROJECT = "This link does not open a project.";
export const TOO_NEW =
  "This project was saved by a newer version of typstry. Reload the page to update.";

/**
 * A doc this new must not be written to, since editing a layout we don't
 * know would corrupt it for everyone. Mirrors ensure_supported in Rust.
 */
export function isSchemaTooNew(schema: number | null): boolean {
  return schema !== null && schema > SCHEMA_VERSION;
}

/**
 * The doc is some other kind than a project, say a directory reached
 * through a link meant for a project. A doc without a kind yet (still
 * syncing, or from before the marker) passes. Mirrors ensure_supported in
 * Rust.
 */
export function isForeignKind(target: LoroDoc | ProjectDoc): boolean {
  const kind = docKind(target);
  return kind !== null && kind !== DOC_KIND.project;
}

/** The doc's `meta.kind`, or null while it has none. */
export function docKind(target: LoroDoc | ProjectDoc): string | null {
  const doc = target instanceof ProjectDoc ? target.doc : target;
  const kind = doc.getMap(ROOT.meta).get(META.kind);
  return typeof kind === "string" ? kind : null;
}

/** One migration step: MIGRATIONS[i] brings a doc from schema i+1 to i+2. */
type Migration = (project: ProjectDoc) => void;

/**
 * Steps must be deterministic and idempotent: two peers can migrate the same
 * doc at once and the CRDT keeps both sets of ops, so every peer has to write
 * the same thing, and rerunning a step on a (partly) migrated doc must change
 * nothing. No random ids, timestamps or anything from the peer. Must match
 * MIGRATIONS in crates/typstry-doc step by step.
 */
const MIGRATIONS: readonly Migration[] = [];

if (MIGRATIONS.length !== SCHEMA_VERSION - 1)
  throw new Error("every schema bump needs its migration step");

/**
 * Brings an older doc up to SCHEMA_VERSION; returns whether it changed
 * anything. Writers only, and only once the doc has caught up with the
 * server so the steps see the whole project. Docs without a schema (empty
 * or about to be seeded) and newer docs are left alone.
 */
export function migrate(project: ProjectDoc): boolean {
  const from = project.schemaVersion;
  if (from === null || from >= SCHEMA_VERSION) return false;
  // Schemas start at 1, so anything smaller is garbage. Run every step.
  const first = Math.max(0, Math.ceil(from) - 1);
  for (const step of MIGRATIONS.slice(first)) step(project);
  project.meta.set(META.schema, SCHEMA_VERSION);
  project.doc.commit({ message: "migrate schema", origin: META_ORIGIN });
  return true;
}
