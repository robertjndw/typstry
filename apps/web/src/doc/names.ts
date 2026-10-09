/**
 * Where a file name's extension starts, or its length when it has none. A
 * leading dot does not start an extension: ".gitignore" is all stem.
 */
export function stemLength(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** Lowercase extension without the dot, or "" when there is none. */
export function extensionOf(name: string): string {
  return name.slice(stemLength(name) + 1).toLowerCase();
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Parent folder path, or "" at the root. */
export function dirname(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

/**
 * Trimmed `raw` when it is 1 to `max` characters long, else null. Counts
 * code points, so an emoji is one character, as a user would expect.
 */
export function normalizeBounded(raw: string, max: number): string | null {
  const value = raw.trim();
  const length = [...value].length;
  return length >= 1 && length <= max ? value : null;
}
