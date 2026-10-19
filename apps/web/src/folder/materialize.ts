// The doc's files as a flat map, a port of materialize in
// crates/typstry-doc/src/materialize.rs. The folder sync compares this with
// what is on disk, so it must list exactly the files the CLI would.
import { LoroText, type LoroDoc, type TreeID } from "loro-crdt";

import { isSafePath } from "@/doc/fs-ops";
import { buildPathIndex, type PathIndex } from "@/doc/paths";
import { NODE, ProjectDoc, type FileKind } from "@/doc/schema";

export type MaterializedFile =
  | { kind: "text"; id: TreeID; text: string }
  | {
      kind: "asset";
      id: TreeID;
      hash: string;
      size: number;
      mime: string;
    };

type Source = LoroDoc | ProjectDoc;

function projectOf(source: Source): ProjectDoc {
  return source instanceof ProjectDoc ? source : new ProjectDoc(source);
}

/**
 * What materialize lists for a node, ignoring its path. Null for folders and
 * for assets without a hash (an upload that has not finished).
 */
export function fileOf(
  source: Source,
  id: TreeID,
  kind: FileKind,
): MaterializedFile | null {
  if (kind === "dir") return null;
  const node = projectOf(source).liveNode(id);
  if (!node) return null;
  if (kind === "text") {
    const content: unknown = node.data.get(NODE.content);
    return {
      kind: "text",
      id,
      text: content instanceof LoroText ? content.toString() : "",
    };
  }
  const hash: unknown = node.data.get(NODE.hash);
  if (typeof hash !== "string" || hash === "") return null;
  const size: unknown = node.data.get(NODE.size);
  const mime: unknown = node.data.get(NODE.mime);
  return {
    kind: "asset",
    id,
    hash,
    size: typeof size === "number" ? size : 0,
    mime: typeof mime === "string" ? mime : "application/octet-stream",
  };
}

function sortedPaths(index: PathIndex): string[] {
  return [...index.byPath.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every text file and asset in the current state, sorted by path. Folders are
 * implied by the paths (see materializeDirs); assets without a hash and files
 * with an unsafe path are left out. Works on a forked doc too, which is how
 * the merge base is read.
 */
export function materialize(
  source: Source,
  index: PathIndex = buildPathIndex(source),
): Map<string, MaterializedFile> {
  const out = new Map<string, MaterializedFile>();
  for (const path of sortedPaths(index)) {
    const id = index.byPath.get(path)!;
    const entry = index.byId.get(id);
    if (!entry || !isSafePath(path)) continue;
    const file = fileOf(source, id, entry.kind);
    if (file) out.set(path, file);
  }
  return out;
}

export function materializeDirs(
  source: Source,
  index: PathIndex = buildPathIndex(source),
): Set<string> {
  const dirs = new Set<string>();
  for (const path of sortedPaths(index)) {
    const entry = index.byId.get(index.byPath.get(path)!);
    if (entry?.kind === "dir" && isSafePath(path)) dirs.add(path);
  }
  return dirs;
}
