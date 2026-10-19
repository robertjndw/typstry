/**
 * Paths that a case-insensitive file system stores as one file, because
 * they, or one of the folders on their way, differ only in case. With
 * `Fig/a.png` and `fig/b.png` both end up in one folder, so only one
 * spelling of each name is kept: the first one `prefer` accepts, else the
 * first in sorted order. Returns `[kept, dropped]` pairs, where `kept` is
 * the kept file, or the kept folder with a trailing `/` when the clash is
 * in a folder name. Same as the CLI's `case_clashes`.
 */
export function caseClashes(
  paths: Iterable<string>,
  prefer: (name: string) => boolean = () => false,
): [kept: string, dropped: string][] {
  const alive = new Set([...paths].sort());
  const depth = Math.max(0, ...[...alive].map((p) => p.split("/").length));
  const clashes: [string, string][] = [];
  // Shallowest first, so a path under a dropped folder spelling is
  // reported once, for the folder.
  for (let level = 1; level <= depth; level++) {
    const groups = new Map<string, Set<string>>();
    for (const path of alive) {
      const head = prefix(path, level);
      if (head === null) continue;
      const key = head.toLowerCase();
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add(head);
    }
    const dropped: string[] = [];
    for (const key of [...groups.keys()].sort()) {
      const names = [...groups.get(key)!].sort();
      if (names.length < 2) continue;
      const kept = names.find(prefer) ?? names[0]!;
      const shown = alive.has(kept) ? kept : `${kept}/`;
      for (const path of alive) {
        const head = prefix(path, level);
        if (head !== null && head !== kept && names.includes(head)) {
          clashes.push([shown, path]);
          dropped.push(path);
        }
      }
    }
    for (const path of dropped) alive.delete(path);
  }
  return clashes;
}

/** The first `level` segments of `path`, or null when it has fewer. */
function prefix(path: string, level: number): string | null {
  const segments = path.split("/");
  return segments.length < level ? null : segments.slice(0, level).join("/");
}
