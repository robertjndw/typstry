/**
 * For each item of `next`, the index of the item of `old` it matches in a
 * longest common subsequence of equal keys, or null. Matches keep their
 * order, so repeated letters pair up with their neighbours rather than with
 * an equal letter on the other side of the paragraph.
 */
export function lcsMatch(
  old: readonly string[],
  next: readonly string[],
): (number | null)[] {
  const n = old.length;
  const m = next.length;
  const width = m + 1;
  // table[i * width + j]: LCS length of old[i..] and next[j..].
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        old[i] === next[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const matches: (number | null)[] = new Array<number | null>(m).fill(null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (old[i] === next[j]) {
      matches[j++] = i++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}
