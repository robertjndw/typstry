import type { TreeID, UndoManager } from "loro-crdt";

import { FsError, getText } from "@/doc/fs-ops";
import type { ProjectDoc } from "@/doc/schema";
import { UNDO_MERGE_INTERVAL_MS } from "@/project/store";

import { compileQuery, type SearchMatch, type SearchQuery } from "./search";

export interface ReplaceTarget {
  fileId: TreeID;
  matches: SearchMatch[];
}

/**
 * Replaces `targets` in one commit, so a single undo reverts every file.
 * A match whose text no longer sits at its offsets (a collaborator edited
 * there since the search) is skipped, never replaced at a shifted position.
 */
export function replaceMatches(
  project: ProjectDoc,
  targets: readonly ReplaceTarget[],
  replacement: string,
  query: SearchQuery,
  { undoManager }: { undoManager?: UndoManager } = {},
): { replaced: number; skipped: number } {
  let replaced = 0;
  let skipped = 0;
  const re = query.regex ? compileQuery(query, true) : null;

  for (const { fileId, matches } of targets) {
    let text;
    try {
      text = getText(project, fileId);
    } catch (err) {
      // Deleted or turned into something else since the search.
      if (!(err instanceof FsError)) throw err;
      skipped += matches.length;
      continue;
    }
    // Replacements are computed against this snapshot: going back to front,
    // everything before the edit point is unchanged, but lookbehinds and
    // captures should still see the text the search saw.
    const before = text.toString();
    const ordered = [...matches].sort((a, b) => b.from - a.from);
    let lastFrom = Infinity;
    for (const match of ordered) {
      // Overlapping matches (a stale list) cannot both apply.
      if (
        match.to > lastFrom ||
        before.slice(match.from, match.to) !== match.text
      ) {
        skipped++;
        continue;
      }
      const next = re ? expand(re, before, match, replacement) : replacement;
      if (next === null) {
        skipped++;
        continue;
      }
      text.delete(match.from, match.to - match.from);
      text.insert(match.from, next);
      lastFrom = match.from;
      replaced++;
    }
  }
  if (replaced > 0) {
    // A commit within the merge interval of the user's last edit would fold
    // into that undo step, and undoing the replace would eat the typing too.
    undoManager?.setMergeInterval(0);
    try {
      project.doc.commit({ message: "replace" });
    } finally {
      undoManager?.setMergeInterval(UNDO_MERGE_INTERVAL_MS);
    }
  }
  return { replaced, skipped };
}

/**
 * Expands $1, $<name>, $& and friends the way String.replace does. Matching
 * in place on the whole text, not on the matched substring alone, keeps
 * anchors, lookarounds and captures working.
 */
function expand(
  re: RegExp,
  text: string,
  match: SearchMatch,
  replacement: string,
): string | null {
  re.lastIndex = match.from;
  const m = re.exec(text);
  if (!m || m.index !== match.from || m[0] !== match.text) return null;
  re.lastIndex = match.from;
  const out = text.replace(re, replacement);
  return out.slice(match.from, out.length - (text.length - match.to));
}
