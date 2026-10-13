import { ownBuffer, toHex } from "@/crypto/bytes";
import { apiFetch, ApiError, blobUrl } from "@/sync/api";

import { BLOB_CACHE } from "./cache-names";

/** `sha256:<hex>`, the server's name for a blob. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownBuffer(bytes)),
  );
  return `sha256:${toHex(digest)}`;
}

// Assets go up to 25 MB each, so a count bound alone could pin hundreds of
// megabytes. Most projects fit their working set well under this.
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

// Cache Storage outlives the page, so without a bound it keeps every blob
// of every project ever opened. Entries carry their last access time and
// size in headers, so a prune can rank them without reading any bodies.
const DEFAULT_MAX_STORED_BYTES = 512 * 1024 * 1024;
const MAX_STORED_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Rewriting an entry costs a copy of the blob, so access times are coarse. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const ACCESSED_HEADER = "x-typstry-accessed";
const SIZE_HEADER = "x-typstry-size";

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
  /** How many bytes of blobs Cache Storage keeps across reloads. */
  maxStoredBytes?: number;
  /** Injection points for tests. `null` disables Cache Storage. */
  fetch?: typeof fetch;
  caches?: CacheStorage | null;
  now?: () => number;
}

/**
 * Blob bytes by content hash, as stored on the server (encrypted). Blobs
 * are immutable, so anything fetched once is kept in Cache Storage and
 * survives reloads, until it goes unused for long or the stored total
 * outgrows its budget; concurrent requests for the same hash share one
 * fetch.
 */
export class AssetCache {
  private readonly baseUrl: string;
  private readonly maxBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly storage: CacheStorage | null;
  private readonly maxStoredBytes: number;
  private readonly now: () => number;
  private lastPrune = -Infinity;
  private pruning = false;
  private store: Promise<Cache | null> | null = null;
  // Map iteration order is insertion order, so re-inserting on every hit
  // makes the first key the least recently used one.
  private readonly recent = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(opts: AssetCacheOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.maxStoredBytes = opts.maxStoredBytes ?? DEFAULT_MAX_STORED_BYTES;
    this.now = opts.now ?? Date.now;
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
    if (!this.store) {
      this.store = this.storage
        ? this.storage.open(BLOB_CACHE).catch(() => null)
        : Promise.resolve(null);
      // Also once per page: a session that only reads from the cache would
      // otherwise never drop what has gone stale.
      void this.store.then((store) => store && this.schedulePrune(store));
    }
    return this.store;
  }

  private persist(
    store: Cache,
    key: string,
    bytes: Uint8Array,
    contentType: string | null,
  ): void {
    // Response copies the bytes, and nobody needs to wait for the write.
    const entry = new Response(ownBuffer(bytes), {
      headers: {
        "content-type": contentType ?? "application/octet-stream",
        [ACCESSED_HEADER]: String(this.now()),
        [SIZE_HEADER]: String(bytes.byteLength),
      },
    });
    void store
      .put(key, entry)
      .then(() => this.schedulePrune(store))
      .catch(() => undefined);
  }

  private schedulePrune(store: Cache): void {
    const now = this.now();
    if (this.pruning || now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.pruning = true;
    this.lastPrune = now;
    void this.prune(store)
      .catch(() => undefined)
      .finally(() => (this.pruning = false));
  }

  /**
   * Drops entries unused for longer than the maximum age, then the least
   * recently used ones until the rest fit the budget.
   */
  private async prune(store: Cache): Promise<void> {
    const now = this.now();
    const entries: { key: Request; accessed: number; size: number }[] = [];
    for (const key of await store.keys()) {
      const res = await store.match(key);
      if (!res) continue;
      entries.push({
        key,
        // Entries without the headers rank as oldest and go first.
        accessed: Number(res.headers.get(ACCESSED_HEADER)) || 0,
        size: Number(res.headers.get(SIZE_HEADER)) || 0,
      });
    }
    entries.sort((a, b) => a.accessed - b.accessed);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const { key, accessed, size } of entries) {
      if (now - accessed <= MAX_STORED_AGE_MS && total <= this.maxStoredBytes)
        break;
      await store.delete(key);
      total -= size;
    }
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
    if (store && cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      const accessed = Number(cached.headers.get(ACCESSED_HEADER)) || 0;
      if (this.now() - accessed > TOUCH_AFTER_MS)
        this.persist(store, key, bytes, cached.headers.get("content-type"));
      return bytes;
    }

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
    if (store) this.persist(store, key, bytes, res.headers.get("content-type"));
    return bytes;
  }
}
