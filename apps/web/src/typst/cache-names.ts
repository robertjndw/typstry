// Bump a suffix when the cached payload format changes. pruneStaleCaches
// deletes the old one on the next boot.
export const BLOB_CACHE = "typstry-blobs-v1";
export const FONT_CACHE = "typstry-fonts-v1";

const CURRENT_CACHES: ReadonlySet<string> = new Set([BLOB_CACHE, FONT_CACHE]);

/**
 * Nothing else ever evicts our old caches. Best effort, since storage can
 * be missing or refuse (private modes).
 */
export async function pruneStaleCaches(
  storage: CacheStorage | undefined = globalThis.caches,
): Promise<void> {
  if (!storage) return;
  try {
    const names = await storage.keys();
    await Promise.all(
      names
        .filter(
          (name) => name.startsWith("typstry-") && !CURRENT_CACHES.has(name),
        )
        .map((name) => storage.delete(name).catch(() => false)),
    );
  } catch {
    // Stale entries only waste disk; not worth surfacing.
  }
}
