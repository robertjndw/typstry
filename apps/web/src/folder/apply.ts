// Writes a set of file changes into the doc, a port of apply_changes in
// crates/typstry-doc/src/apply.rs. This is how edits from the linked folder
// land in the project. Like restoreVersion (doc/restore.ts) it writes raw
// tree ops so everything ends up in one commit, but the target is a list of
// paths instead of another doc, so nodes are matched by path.
import { LoroText, type LoroTreeNode, type TreeID } from "loro-crdt";

import { FsError, isSafePath, validateName } from "@/doc/fs-ops";
import { basename, dirname } from "@/doc/names";
import {
  buildPathIndex,
  compareTreeIds,
  disambiguatedName,
  type PathIndex,
} from "@/doc/paths";
import { META, NODE, type FileKind, type ProjectDoc } from "@/doc/schema";

import { fileOf, type MaterializedFile } from "./materialize";

export type Change =
  | { kind: "text"; text: string }
  | { kind: "asset"; hash: string; size: number; mime: string }
  | { kind: "delete" };

type Put = Exclude<Change, { kind: "delete" }>;

export type SkipReason =
  /** A path segment breaks the name rules. */
  | { kind: "invalid-name"; segment: string; message: string }
  /** Another file sits at one of this path's parent folders. */
  | { kind: "inside-file"; file: string };

export interface ApplyReport {
  /** Files that did not exist (or were not visible to materialize). */
  created: string[];
  /** Files whose content changed, including text/asset switches. */
  modified: string[];
  /** Files that are gone. Folders are not listed. */
  deleted: string[];
  /** Files that moved and kept their node, so history follows them. */
  renamed: { from: string; to: string }[];
  /** Input entries that were ignored. */
  skipped: { path: string; reason: SkipReason }[];
  /** Whether anything was written (and committed). */
  changed: boolean;
}

export interface ApplyOptions {
  message?: string;
  origin?: string;
}

/** Above this, a character diff gets slow enough to freeze the tab. */
const LINE_DIFF_CHARS = 50_000;

/**
 * Makes `t` read `want` with the smallest edit Loro finds, so concurrent
 * typing in the same file still merges instead of being overwritten.
 */
export function replaceText(t: LoroText, want: string): void {
  if (t.toString() === want) return;
  if (want.length > LINE_DIFF_CHARS || t.length > LINE_DIFF_CHARS) {
    t.updateByLine(want);
  } else {
    t.update(want);
  }
}

type Content = Put | MaterializedFile;

function contentKey(content: Content): string {
  return content.kind === "text"
    ? `t${content.text}`
    : `a${content.hash}\0${content.size}\0${content.mime}`;
}

function depth(path: string): number {
  let n = 0;
  for (const ch of path) if (ch === "/") n++;
  return n;
}

/** Proper ancestor folders of `path`, outermost first. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1))
    out.push(path.slice(0, i));
  return out;
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read access to the doc's files by path, through an index built once. */
class Current {
  private readonly files = new Map<string, MaterializedFile | null>();
  private under: Map<string, string[]> | null = null;

  readonly project: ProjectDoc;
  readonly index: PathIndex;

  constructor(project: ProjectDoc, index: PathIndex) {
    this.project = project;
    this.index = index;
  }

  /** The node at `path`, unless materialize hides everything there. */
  node(path: string): { id: TreeID; kind: FileKind } | null {
    if (!isSafePath(path)) return null;
    const id = this.index.byPath.get(path);
    const kind = id === undefined ? undefined : this.index.byId.get(id)?.kind;
    return id !== undefined && kind !== undefined ? { id, kind } : null;
  }

  /** The file materialize lists at `path`. */
  file(path: string): MaterializedFile | null {
    let file = this.files.get(path);
    if (file === undefined) {
      const node = this.node(path);
      file = node ? fileOf(this.project, node.id, node.kind) : null;
      this.files.set(path, file);
    }
    return file;
  }

  /** Whether materialize lists a file at `path`. */
  shows(path: string): boolean {
    return this.file(path) !== null;
  }

  /** Paths of every node anywhere below `dir`. */
  nodesUnder(dir: string): string[] {
    if (!this.under) {
      this.under = new Map();
      for (const path of this.index.byPath.keys()) {
        for (const parent of ancestors(path)) {
          const list = this.under.get(parent);
          if (list) list.push(path);
          else this.under.set(parent, [path]);
        }
      }
    }
    return this.under.get(dir) ?? [];
  }

  /** Paths of the visible files anywhere below `dir`. */
  filesUnder(dir: string): string[] {
    return this.nodesUnder(dir).filter((path) => this.shows(path));
  }

  /** Files below `dir` including the ones materialize hides. */
  nonDirsUnder(dir: string): string[] {
    return this.nodesUnder(dir).filter((path) => {
      const id = this.index.byPath.get(path);
      return id !== undefined && this.index.byId.get(id)?.kind !== "dir";
    });
  }
}

/**
 * Sibling groups whose members came or went. A node that lost a same-name
 * clash shows a derived name; when the winner leaves, or a new node joins
 * the group, the shown names can shift. Pinning the names the caller saw
 * keeps every path stable, including those of files nobody touched.
 */
class Names {
  private readonly touched = new Map<TreeID | null, Set<string>>();
  /** Names for nodes this apply placed. Others keep their indexed name. */
  private readonly wanted = new Map<TreeID, string>();

  private readonly project: ProjectDoc;
  private readonly before: PathIndex;

  constructor(project: ProjectDoc, before: PathIndex) {
    this.project = project;
    this.before = before;
  }

  private touch(parent: TreeID | null, name: string): void {
    let names = this.touched.get(parent);
    if (!names) this.touched.set(parent, (names = new Set()));
    names.add(name);
  }

  joined(parent: TreeID | null, id: TreeID, name: string): void {
    this.touch(parent, name);
    this.wanted.set(id, name);
  }

  /** Call before moving or deleting the node. */
  left(id: TreeID): void {
    const node = this.project.fs.getNodeByID(id);
    const name: unknown = node?.data.get(NODE.name);
    if (node && typeof name === "string")
      this.touch(node.parent()?.id ?? null, name);
  }

  pin(): void {
    const { fs } = this.project;
    const pins: [LoroTreeNode, string][] = [];
    for (const [parent, names] of this.touched) {
      if (parent !== null && fs.isNodeDeleted(parent)) continue;
      const siblings =
        (parent === null ? fs.roots() : fs.getNodeByID(parent)?.children()) ??
        [];
      const groups = new Map<string, LoroTreeNode[]>();
      for (const node of siblings) {
        const name: unknown = node.data.get(NODE.name);
        if (typeof name !== "string" || !names.has(name)) continue;
        const group = groups.get(name);
        if (group) group.push(node);
        else groups.set(name, [node]);
      }
      for (const [name, group] of groups) {
        group.sort((a, b) => compareTreeIds(a.id, b.id));
        group.forEach((node, i) => {
          const shown = i === 0 ? name : disambiguatedName(name, node.id);
          const indexed = this.before.byId.get(node.id);
          const wanted =
            this.wanted.get(node.id) ??
            (indexed ? basename(indexed.path) : undefined);
          if (wanted !== undefined && shown !== wanted)
            pins.push([node, wanted]);
        });
      }
    }
    for (const [node, name] of pins) node.data.set(NODE.name, name);
  }
}

function invalidSegment(path: string): SkipReason | null {
  for (const segment of path.split("/")) {
    try {
      validateName(segment);
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      return { kind: "invalid-name", segment, message: err.message };
    }
  }
  return null;
}

/**
 * Writes `changes` on top of the doc's files: a text or asset entry creates
 * or replaces the file at that path, "delete" removes it. Paths that are
 * not mentioned stay as they are.
 *
 * - Existing paths resolve through the path index, so a clash path like
 *   `main~3@42.typ` updates the node shown under that name. Nodes that stay
 *   keep their TreeID and text changes go through `replaceText`, so they
 *   merge with concurrent edits like typing would.
 * - A deleted file and a new file with identical content are treated as a
 *   rename when that content is unique among both, which keeps the node.
 * - A file that changes between text and asset is deleted and recreated.
 * - A folder is deleted when it had visible files and none are left. Folders
 *   that were empty to begin with are left alone, since a folder on disk
 *   cannot tell them apart from not existing.
 * - Nodes materialize hides (assets without a hash, unsafe names) are left
 *   alone unless a new file needs their path.
 * - `meta.mainFile` is cleared when its node is deleted.
 *
 * Everything lands in one commit, and nothing is written when the doc
 * already matches. Invalid paths are skipped and reported instead of failing
 * the whole batch.
 */
export function applyChanges(
  project: ProjectDoc,
  changes: Map<string, Change>,
  opts: ApplyOptions = {},
): ApplyReport {
  const { doc } = project;
  // Keep unrelated pending edits out of this commit.
  doc.commit();
  const report: ApplyReport = {
    created: [],
    modified: [],
    deleted: [],
    renamed: [],
    skipped: [],
    changed: false,
  };
  const index = buildPathIndex(project);
  const current = new Current(project, index);

  const puts = new Map<string, Put>();
  const deletes = new Set<string>();
  for (const [path, change] of changes) {
    if (change.kind === "delete") {
      deletes.add(path);
      continue;
    }
    const reason = invalidSegment(path);
    if (reason) report.skipped.push({ path, reason });
    else puts.set(path, change);
  }

  // A file the change leaves alone still blocks a folder at its path.
  const nested: [string, string][] = [];
  for (const path of puts.keys()) {
    const file = ancestors(path).find(
      (a) => puts.has(a) || (!changes.has(a) && current.shows(a)),
    );
    if (file !== undefined) nested.push([path, file]);
  }
  for (const [path, file] of nested) {
    puts.delete(path);
    report.skipped.push({ path, reason: { kind: "inside-file", file } });
  }

  applyValid(project, current, puts, deletes, report);

  report.created.sort(byPath);
  report.modified.sort(byPath);
  report.deleted.sort(byPath);
  if (doc.getPendingTxnLength() > 0) {
    doc.commit({
      message: opts.message ?? "Sync with local folder",
      origin: opts.origin,
    });
    report.changed = true;
  }
  return report;
}

function applyValid(
  project: ProjectDoc,
  current: Current,
  puts: Map<string, Put>,
  deletes: Set<string>,
  report: ApplyReport,
): void {
  const { fs } = project;
  const mainBefore = project.mainFile;
  const putPaths = [...puts.keys()].sort(byPath);
  const desiredDirs = [
    ...new Set(putPaths.flatMap((path) => ancestors(path))),
  ].sort(byPath);
  const desiredDirSet = new Set(desiredDirs);

  // Visible files that go away, unless a rename keeps them.
  const removed = new Map<string, MaterializedFile>();
  for (const path of [...deletes].sort(byPath)) {
    const file = current.file(path);
    if (file) removed.set(path, file);
  }
  const doomed: { depth: number; id: TreeID }[] = [];
  const reused: [string, TreeID][] = [];
  const before = new Map<string, MaterializedFile>();
  for (const path of putPaths) {
    const node = current.node(path);
    if (!node) continue;
    if (node.kind === "dir") {
      // The folder goes, and with it everything inside.
      doomed.push({ depth: depth(path), id: node.id });
      for (const inner of current.filesUnder(path)) {
        const file = current.file(inner);
        if (file) removed.set(inner, file);
      }
    } else if (node.kind === puts.get(path)!.kind) {
      reused.push([path, node.id]);
    } else {
      doomed.push({ depth: depth(path), id: node.id });
    }
    const file = current.file(path);
    if (file) before.set(path, file);
  }

  const dirs = new Map<string, TreeID>();
  for (const dir of desiredDirs) {
    const node = current.node(dir);
    if (!node) continue;
    if (node.kind === "dir") {
      dirs.set(dir, node.id);
    } else {
      doomed.push({ depth: depth(dir), id: node.id });
      if (current.shows(dir)) report.deleted.push(dir);
      removed.delete(dir);
    }
  }

  // A folder goes with its last visible file. Folders that were empty to
  // begin with never get here, and neither do ones that still hold a node
  // materialize hides, such as an upload still in progress, which deleting
  // the folder would take with it.
  const emptied = new Set<string>();
  for (const path of removed.keys())
    for (const dir of ancestors(path))
      if (!desiredDirSet.has(dir)) emptied.add(dir);
  for (const dir of emptied) {
    const node = current.node(dir);
    if (
      node?.kind === "dir" &&
      current.nonDirsUnder(dir).every((path) => removed.has(path))
    )
      doomed.push({ depth: depth(dir), id: node.id });
  }

  const taken = new Set(reused.map(([path]) => path));
  const added = putPaths.filter((path) => !taken.has(path));
  // A path that only changes kind is an edit in place, not a rename target.
  const fresh = added.filter((path) => !before.has(path));
  const renames = pairRenames(removed, fresh, puts);

  const parentOf = (path: string): TreeID | undefined => {
    const parent = dirname(path);
    return parent === "" ? undefined : dirs.get(parent);
  };
  const names = new Names(project, current.index);

  // Sorted order puts every folder after its parent.
  for (const dir of desiredDirs) {
    if (dirs.has(dir)) continue;
    const parent = parentOf(dir);
    const node = fs.createNode(parent);
    node.data.set(NODE.kind, "dir");
    node.data.set(NODE.name, basename(dir));
    names.joined(parent ?? null, node.id, basename(dir));
    dirs.set(dir, node.id);
  }

  const renamedAway = new Set<TreeID>();
  for (const { from, to, id } of renames) {
    names.left(id);
    // Targets are folders that stay or were just created, never one about
    // to be deleted, which would take the moved file with it.
    const parent = parentOf(to);
    const node = fs.getNodeByID(id)!;
    if ((node.parent()?.id ?? undefined) !== parent) fs.move(id, parent);
    if (node.data.get(NODE.name) !== basename(to))
      node.data.set(NODE.name, basename(to));
    names.joined(parent ?? null, id, basename(to));
    renamedAway.add(id);
    report.renamed.push({ from, to });
  }
  const renamedTo = new Set(renames.map((r) => r.to));

  for (const [path, id] of reused) {
    const put = puts.get(path)!;
    const old = before.get(path);
    if (old && contentKey(old) === contentKey(put)) continue;
    writeContent(fs.getNodeByID(id)!, put);
    (old ? report.modified : report.created).push(path);
  }

  for (const path of added) {
    if (renamedTo.has(path)) continue;
    const put = puts.get(path)!;
    const parent = parentOf(path);
    const node = fs.createNode(parent);
    node.data.set(NODE.kind, put.kind);
    node.data.set(NODE.name, basename(path));
    writeContent(node, put);
    names.joined(parent ?? null, node.id, basename(path));
    // A file that only changed kind is still the same file to the user.
    (before.has(path) ? report.modified : report.created).push(path);
  }

  for (const [path, file] of removed) {
    if (renamedAway.has(file.id)) continue;
    doomed.push({ depth: depth(path), id: file.id });
    report.deleted.push(path);
  }
  // Parents first, so their subtrees are already gone when we get there
  // and do not cost an op each.
  doomed.sort((a, b) => a.depth - b.depth);
  for (const { id } of doomed) {
    if (fs.isNodeDeleted(id)) continue;
    names.left(id);
    fs.delete(id);
  }
  if (mainBefore !== null && fs.isNodeDeleted(mainBefore))
    project.meta.set(META.mainFile, null);
  names.pin();

  report.renamed.sort((a, b) => byPath(a.from, b.from) || byPath(a.to, b.to));
}

/** Content of a node that is fresh or known to differ from `put`. */
function writeContent(node: LoroTreeNode, put: Put): void {
  if (put.kind === "text") {
    const content: unknown = node.data.get(NODE.content);
    const text =
      content instanceof LoroText
        ? content
        : node.data.setContainer(NODE.content, new LoroText());
    replaceText(text, put.text);
    return;
  }
  if (node.data.get(NODE.hash) !== put.hash) node.data.set(NODE.hash, put.hash);
  if (node.data.get(NODE.size) !== put.size) node.data.set(NODE.size, put.size);
  if (node.data.get(NODE.mime) !== put.mime) node.data.set(NODE.mime, put.mime);
}

/**
 * Pairs each vanished file with the new file holding the same content, when
 * that content occurs exactly once on both sides. Anything less certain
 * stays a delete plus a create.
 */
function pairRenames(
  gone: Map<string, MaterializedFile>,
  added: string[],
  desired: Map<string, Put>,
): { from: string; to: string; id: TreeID }[] {
  const byContent = new Map<
    string,
    { from: { path: string; id: TreeID }[]; to: string[] }
  >();
  for (const [path, file] of gone) {
    const key = contentKey(file);
    const entry = byContent.get(key) ?? { from: [], to: [] };
    entry.from.push({ path, id: file.id });
    byContent.set(key, entry);
  }
  for (const path of added)
    byContent.get(contentKey(desired.get(path)!))?.to.push(path);
  const out: { from: string; to: string; id: TreeID }[] = [];
  for (const { from, to } of byContent.values()) {
    const [source] = from;
    const [target] = to;
    if (from.length === 1 && to.length === 1 && source && target)
      out.push({ from: source.path, to: target, id: source.id });
  }
  return out.sort((a, b) => byPath(a.from, b.from) || byPath(a.to, b.to));
}
