/**
 * Maps `items` through `fn` with at most `limit` calls in flight, keeping
 * the results in input order. Rejects with the first error, like
 * `Promise.all`; callers that want to go on past a failed item catch inside
 * `fn`.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  // At least one worker, or a limit of 0 would resolve with nothing mapped.
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
}
