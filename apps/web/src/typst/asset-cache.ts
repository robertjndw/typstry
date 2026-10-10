import { ownBuffer } from "@/crypto/project-key";
import { ApiError, blobUrl } from "@/sync/api";

export const BLOB_CACHE = "typstry-blobs-v1";

/** `sha256:<hex>`, the server's name for a blob. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownBuffer(bytes)),
  );
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

export interface AssetCacheOptions {
  /** Origin of the API; empty means same origin. */
  baseUrl?: string;
  /** How many recent blobs stay in memory. */
  capacity?: number;
  /** Injection points for tests. `null` disables Cache Storage. */
  fetch?: typeof fetch;
  caches?: CacheStorage | null;
}

/**
 * Blob bytes by content hash, as stored on the server (encrypted). Blobs
 * are immutable, so anything fetched once is kept in Cache Storage and
 * survives reloads; concurrent requests for the same hash share one fetch.
 */
export class AssetCache {
  private readonly baseUrl: string;
  private readonly capacity: number;
  private readonly fetchFn: typeof fetch;
  private readonly storage: CacheStorage | null;
  private store: Promise<Cache | null> | null = null;
  // Map iteration order is insertion order, so re-inserting on every hit
  // makes the first key the least recently used one.
  private readonly recent = new Map<string, Promise<Uint8Array>>();

  constructor(opts: AssetCacheOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.capacity = opts.capacity ?? 32;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.storage =
      opts.caches !== undefined
        ? opts.caches
        : typeof caches === "undefined"
          ? null
          : caches;
  }

  get(token: string, hash: string): Promise<Uint8Array> {
    const hit = this.recent.get(hash);
    if (hit) {
      this.recent.delete(hash);
      this.recent.set(hash, hit);
      return hit;
    }
    const pending = this.load(token, hash);
    this.recent.set(hash, pending);
    // A failed load must not stick, or the asset could never be retried.
    pending.catch(() => {
      if (this.recent.get(hash) === pending) this.recent.delete(hash);
    });
    while (this.recent.size > this.capacity) {
      const oldest = this.recent.keys().next().value!;
      this.recent.delete(oldest);
    }
    return pending;
  }

  private openStore(): Promise<Cache | null> {
    // Cache Storage throws in insecure contexts (plain http on a LAN IP) and
    // in some private modes; plain fetches still work there.
    this.store ??= this.storage
      ? this.storage.open(BLOB_CACHE).catch(() => null)
      : Promise.resolve(null);
    return this.store;
  }

  private async load(token: string, hash: string): Promise<Uint8Array> {
    // Keyed by hash alone: the bytes are the same whichever share link
    // fetched them, and links of one project should share entries.
    const key = new URL(
      `/__typstry-blob/${encodeURIComponent(hash)}`,
      "https://typstry.invalid",
    ).href;
    const store = await this.openStore();
    const cached = await store?.match(key).catch(() => undefined);
    if (cached) return new Uint8Array(await cached.arrayBuffer());

    const res = await this.fetchFn(
      blobUrl(token, hash, { baseUrl: this.baseUrl }),
    );
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `loading blob ${hash} failed: ${res.status}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The hash comes from the signed doc while blobs are not signed
    // themselves, so this is what stops a server (or a viewer working with
    // it) from swapping in other content sealed with the read key.
    if ((await contentHash(bytes)) !== hash) {
      throw new ApiError(
        res.status,
        `loading blob ${hash} failed: the server sent different content`,
      );
    }
    if (store) {
      // Response copies the bytes, and nobody needs to wait for the write.
      const entry = new Response(bytes, {
        headers: {
          "content-type":
            res.headers.get("content-type") ?? "application/octet-stream",
        },
      });
      void store.put(key, entry).catch(() => undefined);
    }
    return bytes;
  }
}
