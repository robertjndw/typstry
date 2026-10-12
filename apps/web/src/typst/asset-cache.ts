import { ownBuffer } from "@/crypto/project-key";
import { apiFetch, ApiError, blobUrl } from "@/sync/api";

import { BLOB_CACHE } from "./cache-names";

/** `sha256:<hex>`, the server's name for a blob. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownBuffer(bytes)),
  );
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

// Assets go up to 25 MB each, so a count bound alone could pin hundreds of
// megabytes. Most projects fit their working set well under this.
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

interface Entry {
  bytes: Promise<Uint8Array>;
  /** Null while loading; pending entries are never evicted. */
  size: number | null;
}

export interface AssetCacheOptions {
  /** Origin of the API; empty means same origin. */
  baseUrl?: string;
  /** How many bytes of recent blobs stay in memory. */
  maxBytes?: number;
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
  private readonly maxBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly storage: CacheStorage | null;
  private store: Promise<Cache | null> | null = null;
  // Map iteration order is insertion order, so re-inserting on every hit
  // makes the first key the least recently used one.
  private readonly recent = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(opts: AssetCacheOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
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
      return hit.bytes;
    }
    const pending = this.load(token, hash);
    const entry: Entry = { bytes: pending, size: null };
    this.recent.set(hash, entry);
    pending.then(
      (bytes) => {
        if (this.recent.get(hash) !== entry) return;
        entry.size = bytes.byteLength;
        this.totalBytes += entry.size;
        this.evict();
      },
      // A failed load must not stick, or the asset could never be retried.
      () => {
        if (this.recent.get(hash) === entry) this.recent.delete(hash);
      },
    );
    return pending;
  }

  /** Drops least recently used blobs until the loaded ones fit the budget. */
  private evict(): void {
    for (const [hash, entry] of this.recent) {
      if (this.totalBytes <= this.maxBytes) return;
      if (entry.size === null) continue;
      this.recent.delete(hash);
      this.totalBytes -= entry.size;
    }
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

    const res = await apiFetch(
      blobUrl(token, hash, { baseUrl: this.baseUrl }),
      {},
      this.fetchFn,
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
