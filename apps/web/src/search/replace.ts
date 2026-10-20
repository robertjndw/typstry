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
  // Literal mode re-runs the match too: a collaborator typing right after
  // "foo" leaves the text at the offsets intact but breaks a whole-word match.
  const re = compileQuery(query, true);

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
      const m = rematch(re, before, match);
      if (!m) {
        skipped++;
        continue;
      }
      const next = query.regex
        ? substitute(m, before, replacement)
        : replacement;
      text.delete(match.from, match.to - match.from);
      text.insert(match.from, next);
      lastFrom = match.from;
      replaced++;
    }
  }
  if (replaced > 0) {
    // Merging works both ways: the replace would fold into the typing just
    // before it, and the next keystroke into the replace, so one undo would
    // take both. The interval stays at 0 until that next commit is recorded.
    undoManager?.setMergeInterval(0);
    project.doc.commit({ message: "replace" });
    if (undoManager) {
      const unsubscribe = project.doc.subscribeLocalUpdates(() => {
        unsubscribe();
        undoManager.setMergeInterval(UNDO_MERGE_INTERVAL_MS);
      });
    }
  }
  return { replaced, skipped };
}

/**
 * Re-runs the match in place on the whole text, not on the matched substring
 * alone, so anchors, lookarounds and whole-word checks still apply.
 */
function rematch(
  re: RegExp,
  text: string,
  match: SearchMatch,
): RegExpExecArray | null {
  re.lastIndex = match.from;
  const m = re.exec(text);
  return m && m.index === match.from && m[0] === match.text ? m : null;
}

/**
 * Expands $1, $<name>, $& and friends the way String.replace does. Done by
 * hand because text.replace() would copy the whole file for every match.
 */
function substitute(
  m: RegExpExecArray,
  text: string,
  replacement: string,
): string {
  const captures = m.length - 1;
  let out = "";
  let i = 0;
  while (i < replacement.length) {
    const dollar = replacement.indexOf("$", i);
    if (dollar < 0 || dollar === replacement.length - 1) break;
    out += replacement.slice(i, dollar);
    const c = replacement[dollar + 1]!;
    i = dollar + 2;
    if (c === "$") out += "$";
    else if (c === "&") out += m[0];
    else if (c === "`") out += text.slice(0, m.index);
    else if (c === "'") out += text.slice(m.index + m[0].length);
    else if (c >= "0" && c <= "9") {
      const two = Number(c + (replacement[i] ?? ""));
      if (/\d/.test(replacement[i] ?? "") && two >= 1 && two <= captures) {
        out += m[two] ?? "";
        i++;
      } else if (Number(c) >= 1 && Number(c) <= captures) {
        out += m[Number(c)] ?? "";
      } else {
        out += "$" + c;
      }
    } else if (c === "<" && m.groups) {
      const close = replacement.indexOf(">", i);
      if (close < 0) out += "$<";
      else {
        out += m.groups[replacement.slice(i, close)] ?? "";
        i = close + 1;
      }
    } else {
      out += "$" + c;
    }
  }
  return out + replacement.slice(i);
}
