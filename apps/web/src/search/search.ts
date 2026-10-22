import type { TreeID } from "loro-crdt";

export interface SearchQuery {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  /** UTF-16 offsets into the file, the same units as Loro and CodeMirror. */
  from: number;
  to: number;
  /** 0-based. */
  line: number;
  /** The matched line, trimmed to a window around the match. */
  preview: string;
  /** The match inside `preview`. */
  previewFrom: number;
  previewTo: number;
  /** What matched, so a replace can tell the file changed since. */
  text: string;
}

export interface FileMatches {
  fileId: TreeID;
  path: string;
  matches: SearchMatch[];
}

export interface SearchInput {
  fileId: TreeID;
  path: string;
  text: string;
}

export type SearchResult =
  | { files: FileMatches[]; total: number; truncated: boolean }
  | { error: string };

export const DEFAULT_LIMIT = 2000;
// Enough for a result row to show the hit, not a whole minified line.
const PREVIEW_MAX = 120;
const PREVIEW_LEAD = 30;

// \b only knows ASCII word characters, so "café" would match inside "cafés".
const WORD = String.raw`[\p{L}\p{N}_]`;

/**
 * The one RegExp both searching and replacing use, so a replacement sees
 * exactly what the search did. Throws a SyntaxError for a bad pattern.
 * `sticky` matches only at `lastIndex`, which replace uses to re-run a single
 * match in context.
 */
export function compileQuery(query: SearchQuery, sticky = false): RegExp {
  let source = query.regex
    ? query.pattern
    : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (query.wholeWord) source = `(?<!${WORD})(?:${source})(?!${WORD})`;
  // Always "u": astral characters are then one unit for "." and classes, and
  // \p{...} works. Patterns invalid under "u" are reported as errors.
  return new RegExp(
    source,
    (sticky ? "y" : "g") + (query.caseSensitive ? "" : "i") + "u",
  );
}

function previewOf(
  text: string,
  lineStart: number,
  from: number,
  to: number,
): Pick<SearchMatch, "preview" | "previewFrom" | "previewTo"> {
  let lineEnd = text.indexOf("\n", from);
  if (lineEnd < 0) lineEnd = text.length;
  if (text[lineEnd - 1] === "\r") lineEnd--;
  // A match spanning lines is previewed on its first line only.
  const matchEnd = Math.min(to, lineEnd);
  let start = Math.max(lineStart, from - PREVIEW_LEAD);
  let end = Math.min(lineEnd, start + PREVIEW_MAX);
  if (matchEnd > end) end = matchEnd;
  // Never cut a surrogate pair in half.
  if (start > lineStart && isLowSurrogate(text.charCodeAt(start))) start--;
  if (end < lineEnd && isLowSurrogate(text.charCodeAt(end))) end++;
  return {
    preview: text.slice(start, end),
    previewFrom: from - start,
    previewTo: matchEnd - start,
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function searchProject(
  files: readonly SearchInput[],
  query: SearchQuery,
  { limit = DEFAULT_LIMIT }: { limit?: number } = {},
): SearchResult {
  if (query.pattern === "") return { files: [], total: 0, truncated: false };
  let re: RegExp;
  try {
    re = compileQuery(query);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const found: FileMatches[] = [];
  let total = 0;
  let truncated = false;
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const file of sorted) {
    const matches: SearchMatch[] = [];
    // Matches arrive in order, so line numbers advance incrementally instead
    // of rescanning from the top for each one.
    let line = 0;
    let lineStart = 0;
    re.lastIndex = 0;
    for (let m = re.exec(file.text); m; m = re.exec(file.text)) {
      const from = m.index;
      const to = from + m[0].length;
      if (to === from) {
        // An empty match never advances lastIndex on its own. Step by a code
        // point so the "u" regex does not restart inside a surrogate pair.
        re.lastIndex = from + (file.text.codePointAt(from)! > 0xffff ? 2 : 1);
        if (from >= file.text.length) break;
        continue;
      }
      if (total >= limit) {
        truncated = true;
        break;
      }
      for (
        let nl = file.text.indexOf("\n", lineStart);
        nl >= 0 && nl < from;
        nl = file.text.indexOf("\n", lineStart)
      ) {
        line++;
        lineStart = nl + 1;
      }
      matches.push({
        from,
        to,
        line,
        ...previewOf(file.text, lineStart, from, to),
        text: m[0],
      });
      total++;
    }
    if (matches.length > 0)
      found.push({ fileId: file.fileId, path: file.path, matches });
    if (truncated) break;
  }
  return { files: found, total, truncated };
}
