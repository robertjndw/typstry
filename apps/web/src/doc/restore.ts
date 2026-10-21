// Restoring an old version by writing new operations on top of the live
// doc. History is never rewritten: collaborators simply receive one more
// change, and the restore itself can be undone or restored away again.
//
// Loro's revertTo/applyDiff could do most of this, but they revert every
// container, including the peers map and the list of named versions, and
// they leave meta.mainFile pointing at TreeIDs that do not come back (a
// deleted tree node cannot be revived, only recreated under a new id).
import { LoroText, type LoroTreeNode, type OpId, type TreeID } from "loro-crdt";

import { basename } from "./names";
import { buildPathIndex, type PathIndex } from "./paths";
import { META, NODE, ProjectDoc, type FileKind } from "./schema";

/**
 * Commit origin of a restore. Deliberately not excluded from the undo
 * manager: the whole restore is one commit and therefore one undo step.
 */
export const RESTORE_ORIGIN = "typstry:restore";

/** A read-only copy of `project` at `frontiers`; the live doc is untouched. */
export function versionAt(project: ProjectDoc, frontiers: OpId[]): ProjectDoc {
  return new ProjectDoc(project.doc.forkAt(frontiers));
}

function textOf(node: LoroTreeNode): string {
  const content: unknown = node.data.get(NODE.content);
  return content instanceof LoroText ? content.toString() : "";
}

function depth(path: string): number {
  let n = 0;
  for (const ch of path) if (ch === "/") n++;
  return n;
}

const ASSET_KEYS = [NODE.hash, NODE.size, NODE.mime] as const;

/**
 * Makes `project` match `version` (typically from versionAt): the same
 * paths, kinds, text contents and asset references, the same title and the
 * same main file. Nodes that still exist keep their TreeID, so open editors
 * and presence stay attached; deleted ones are recreated.
 *
 * Every file gets its displayed name from the version as its stored name, so
 * a same-name clash in the old version comes back as two distinct names
 * ("x.typ" and "x~3@42.typ") rather than as a clash that might resolve
 * differently with the new ids.
 */
export function restoreVersion(
  project: ProjectDoc,
  version: ProjectDoc,
  label: string,
): void {
  const { doc } = project;
  // Keep unrelated pending edits out of the restore commit.
  doc.commit();

  const target: PathIndex = buildPathIndex(version);
  // Parents strictly before children; ties by path for determinism.
  const entries = [...target.byId].sort(
    ([, a], [, b]) =>
      depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1),
  );
  const mapping = new Map<TreeID, TreeID>();

  for (const [srcId, entry] of entries) {
    const src = version.fs.getNodeByID(srcId)!;
    const srcParent = src.parent()?.id;
    // The index only contains nodes whose ancestors are in it, so a mapped
    // parent always exists by now.
    const parent =
      srcParent === undefined ? undefined : mapping.get(srcParent)!;
    const name = basename(entry.path);

    let node = reusable(project, srcId, entry.kind);
    if (node) {
      if ((node.parent()?.id ?? undefined) !== parent) {
        // Parents are placed before their children, so the live ancestor
        // chain of `parent` is already final and cannot contain this node.
        project.fs.move(node.id, parent);
      }
    } else {
      node = project.fs.createNode(parent);
      node.data.set(NODE.kind, entry.kind);
      if (entry.kind === "text") {
        node.data.setContainer(NODE.content, new LoroText());
      }
    }
    mapping.set(srcId, node.id);
    if (node.data.get(NODE.name) !== name) node.data.set(NODE.name, name);

    if (entry.kind === "text") {
      const want = textOf(src);
      const content: unknown = node.data.get(NODE.content);
      const text =
        content instanceof LoroText
          ? content
          : node.data.setContainer(NODE.content, new LoroText());
      if (text.toString() !== want) text.update(want);
    } else if (entry.kind === "asset") {
      for (const key of ASSET_KEYS) {
        const value: unknown = src.data.get(key);
        if (value === undefined) {
          if (node.data.get(key) !== undefined) node.data.delete(key);
        } else if (node.data.get(key) !== value) {
          node.data.set(key, value as string | number);
        }
      }
    }
  }

  // Everything that survived is now attached only to mapped parents, so
  // deleting the unmapped roots of the remaining subtrees is enough.
  const kept = new Set(mapping.values());
  const remove = (nodes: LoroTreeNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (kept.has(node.id)) remove(node.children());
      else project.fs.delete(node.id);
    }
  };
  remove(project.fs.roots());

  // Packages are plain records, so matching them is a per-key comparison.
  const wanted = new Set(version.packages.keys());
  for (const key of project.packages.keys())
    if (!wanted.has(key)) project.packages.delete(key);
  for (const key of wanted) {
    const value: unknown = version.packages.get(key);
    if (JSON.stringify(project.packages.get(key)) !== JSON.stringify(value))
      project.packages.set(key, value as Record<string, unknown>);
  }
  for (const key of [META.cjkFonts, META.emojiFonts]) {
    const value: unknown = version.meta.get(key);
    if (project.meta.get(key) !== value) {
      if (value === undefined) project.meta.delete(key);
      else project.meta.set(key, value as boolean);
    }
  }

  const title = version.title;
  if (title && project.title !== title) project.meta.set(META.title, title);
  const main = version.mainFile;
  const mainFile = main !== null ? (mapping.get(main) ?? null) : null;
  if (project.meta.get(META.mainFile) !== mainFile)
    project.meta.set(META.mainFile, mainFile);

  doc.commit({ message: `Restore version ${label}`, origin: RESTORE_ORIGIN });
}

function reusable(
  project: ProjectDoc,
  id: TreeID,
  kind: FileKind,
): LoroTreeNode | undefined {
  const node = project.liveNode(id);
  return node && node.data.get(NODE.kind) === kind ? node : undefined;
}

export type FileChangeKind = "added" | "deleted" | "modified" | "renamed";

export interface FileChange {
  id: TreeID;
  kind: FileKind;
  /** Path in the newer version, or the old path for deletions. */
  path: string;
  oldPath: string | null;
  changes: FileChangeKind[];
}

/**
 * What happened to each file between two versions, matched by TreeID.
 * "renamed" covers moves too. Directories only show up when added, deleted
 * or renamed themselves. Sorted by path.
 */
export function compareVersions(
  before: ProjectDoc,
  after: ProjectDoc,
): FileChange[] {
  const a = buildPathIndex(before);
  const b = buildPathIndex(after);
  const out: FileChange[] = [];
  for (const [id, entry] of b.byId) {
    const old = a.byId.get(id);
    if (!old || old.kind !== entry.kind) {
      out.push({
        id,
        kind: entry.kind,
        path: entry.path,
        oldPath: null,
        changes: ["added"],
      });
      continue;
    }
    const changes: FileChangeKind[] = [];
    if (old.path !== entry.path) changes.push("renamed");
    if (
      entry.kind !== "dir" &&
      contentKey(before, id) !== contentKey(after, id)
    )
      changes.push("modified");
    if (changes.length > 0)
      out.push({
        id,
        kind: entry.kind,
        path: entry.path,
        oldPath: old.path,
        changes,
      });
  }
  for (const [id, entry] of a.byId) {
    const now = b.byId.get(id);
    if (now && now.kind === entry.kind) continue;
    // A deleted directory implies its contents; listing them all is noise.
    const parent = before.fs.getNodeByID(id)?.parent()?.id;
    if (parent !== undefined && a.byId.has(parent) && !b.byId.has(parent))
      continue;
    out.push({
      id,
      kind: entry.kind,
      path: entry.path,
      oldPath: entry.path,
      changes: ["deleted"],
    });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function contentKey(project: ProjectDoc, id: TreeID): string {
  const node = project.fs.getNodeByID(id);
  if (!node) return "";
  if (node.data.get(NODE.kind) === "asset") {
    return `asset:${String(node.data.get(NODE.hash))}`;
  }
  return `text:${textOf(node)}`;
}

/** Text of a file in a version, or null when it is not a live text file. */
export function fileText(project: ProjectDoc, id: TreeID): string | null {
  const node = project.liveNode(id);
  if (!node || node.data.get(NODE.kind) !== "text") return null;
  return textOf(node);
}
