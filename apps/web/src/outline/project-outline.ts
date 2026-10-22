import type { TreeID } from "loro-crdt";

import { dirname } from "@/doc/names";

import { extractOutline, type OutlineItem } from "./extract";

export type OutlineEntryKind = Exclude<OutlineItem["kind"], "include">;

/**
 * One heading or figure of the whole document. Includes are expanded in
 * place and never appear themselves, so the list reads like the compiled
 * document.
 */
export interface ProjectOutlineItem extends Omit<OutlineItem, "kind"> {
  kind: OutlineEntryKind;
  fileId: TreeID;
  path: string;
  /**
   * Nesting in the tree: a heading sits one deeper than the closest earlier
   * heading with a lower level, a figure one deeper than the heading it
   * follows. Counted across files, so an included chapter nests under the
   * heading that precedes the include.
   */
  depth: number;
}

export interface ProjectOutline {
  items: ProjectOutlineItem[];
  /** Every file the walk read, including ones whose items are all filtered. */
  files: ReadonlySet<TreeID>;
}

export interface OutlineSource {
  fileId: TreeID;
  text: string;
}

/** A pathological include fan-out must not freeze the tab. */
const MAX_FILES_READ = 500;

/**
 * Resolves an include path the way Typst does: relative to the including
 * file's folder, or to the project root when it starts with a slash. Null
 * when it climbs out of the root.
 */
export function resolveIncludePath(
  from: string,
  target: string,
): string | null {
  const parts = target.startsWith("/")
    ? []
    : dirname(from).split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * Walks the include graph from `mainPath` in document order. `read` returns
 * a file's text, or null when the path is not a readable text file (missing
 * includes then just drop out). `extract` can be swapped for a caching one.
 */
export function buildProjectOutline(
  mainPath: string,
  read: (path: string) => OutlineSource | null,
  extract: (path: string, text: string) => OutlineItem[] = (_, text) =>
    extractOutline(text),
): ProjectOutline {
  const items: ProjectOutlineItem[] = [];
  const files = new Set<TreeID>();
  // Levels of the headings that are still open, innermost last.
  const open: number[] = [];
  let reads = 0;

  // `ancestors` holds the files being expanded right now. Only those are a
  // cycle: a file included from two places is legitimately listed twice.
  const walk = (path: string, ancestors: Set<string>) => {
    if (ancestors.has(path) || reads >= MAX_FILES_READ) return;
    const file = read(path);
    if (!file) return;
    reads++;
    files.add(file.fileId);
    ancestors.add(path);
    for (const item of extract(path, file.text)) {
      if (item.kind === "include") {
        const target = resolveIncludePath(path, item.title);
        if (target) walk(target, ancestors);
        continue;
      }
      let depth: number;
      if (item.kind === "heading") {
        while (open.length && open[open.length - 1]! >= item.level) open.pop();
        depth = open.length;
        open.push(item.level);
      } else depth = open.length;
      items.push({
        ...item,
        kind: item.kind,
        fileId: file.fileId,
        path,
        depth,
      });
    }
    ancestors.delete(path);
  };
  walk(mainPath, new Set());
  return { items, files };
}

/**
 * Index of the heading whose section holds `offset` in `fileId`: the last
 * heading of that file starting at or before it. -1 above the first heading
 * or when the file has none in the outline.
 */
export function activeItemIndex(
  items: readonly ProjectOutlineItem[],
  fileId: TreeID,
  offset: number,
): number {
  let best = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "heading" || item.fileId !== fileId) continue;
    // Strictly greater, so a file included twice resolves to its first spot.
    if (item.from <= offset && (best < 0 || item.from > items[best]!.from))
      best = i;
  }
  return best;
}
