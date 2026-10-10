export interface FuzzyMatch {
  score: number;
  /** Indices into the path of the matched characters, ascending. */
  positions: number[];
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  if ("/._- ".includes(prev)) return true;
  // camelCase humps
  const ch = text[i]!;
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

function matchFrom(
  path: string,
  lower: string,
  query: string,
  start: number,
): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let at = start;
  for (const ch of query) {
    const found = lower.indexOf(ch, at);
    if (found === -1) return null;
    score += 1;
    if (positions.length > 0 && found === positions.at(-1)! + 1) score += 5;
    if (isBoundary(path, found)) score += 3;
    positions.push(found);
    at = found + 1;
  }
  return { score, positions };
}

/**
 * Subsequence match of `query` in `path`, case-insensitive. Matches inside
 * the file name rank above ones spread over folders, and runs of adjacent
 * characters or word starts rank higher, roughly like editors' quick open.
 * Spaces in the query are ignored. Returns null when it does not match.
 */
export function fuzzyMatch(path: string, query: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return { score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const inName = nameStart > 0 ? matchFrom(path, lower, q, nameStart) : null;
  if (inName) return { ...inName, score: inName.score + 10 };
  const anywhere = matchFrom(path, lower, q, 0);
  if (!anywhere) return null;
  return nameStart === 0
    ? { ...anywhere, score: anywhere.score + 10 }
    : anywhere;
}

/** Items matching `query`, best first; all of them by path when it is empty. */
export function fuzzyFilter<T extends { path: string }>(
  items: readonly T[],
  query: string,
): (T & FuzzyMatch)[] {
  const matched: (T & FuzzyMatch)[] = [];
  for (const item of items) {
    const match = fuzzyMatch(item.path, query);
    if (match) matched.push({ ...item, ...match });
  }
  return matched.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  );
}
