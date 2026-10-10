// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { AssetCache, BLOB_CACHE, contentHash } from "./asset-cache";

const BYTES = new Uint8Array([1, 2, 3]);
const OTHER_BYTES = new Uint8Array([4, 5]);
const HASH = await contentHash(BYTES);
const OTHER = await contentHash(OTHER_BYTES);

/** Serves each blob's bytes under its own hash, like the server. */
function fakeFetch(status = 200) {
  return vi.fn<typeof fetch>(async (url) => {
    const other = String(url).includes(encodeURIComponent(OTHER));
    return new Response(other ? OTHER_BYTES : BYTES, { status });
  });
}

/** Minimal in-memory Cache Storage. */
function fakeCaches() {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(async (key: string, res: Response) => {
      entries.set(key, res);
    }),
  };
  const storage = {
    open: vi.fn(async () => cache),
  } as unknown as CacheStorage;
  return { storage, cache, entries };
}

describe("AssetCache", () => {
  it("shares one fetch between concurrent requests for a hash", async () => {
    const fetch = fakeFetch();
    const cache = new AssetCache({ fetch, caches: null });
    const [a, b] = await Promise.all([
      cache.get("tok", HASH),
      cache.get("tok", HASH),
    ]);
    expect(a).toEqual(new Uint8Array([1, 2, 3]));
    expect(b).toBe(a);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(
      `/api/p/tok/blobs/${encodeURIComponent(HASH)}`,
    );
  });

  it("evicts the least recently used entry", async () => {
    const fetch = fakeFetch();
    const cache = new AssetCache({ fetch, caches: null, capacity: 1 });
    await cache.get("tok", HASH);
    await cache.get("tok", OTHER);
    await cache.get("tok", HASH);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("forgets failures so they can be retried", async () => {
    const fetch = fakeFetch(404);
    const cache = new AssetCache({ fetch, caches: null });
    await expect(cache.get("tok", HASH)).rejects.toThrow(/404/);
    await expect(cache.get("tok", HASH)).rejects.toThrow(/404/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads through Cache Storage across instances", async () => {
    const { storage, cache: store } = fakeCaches();
    const fetch = fakeFetch();
    await new AssetCache({ fetch, caches: storage }).get("tok", HASH);
    expect(storage.open).toHaveBeenCalledWith(BLOB_CACHE);
    expect(store.put).toHaveBeenCalledOnce();

    const again = await new AssetCache({ fetch, caches: storage }).get(
      "other-token",
      HASH,
    );
    expect(again).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("falls back to fetch when Cache Storage is unavailable", async () => {
    const storage = {
      open: vi.fn(async () => {
        throw new DOMException("insecure", "SecurityError");
      }),
    } as unknown as CacheStorage;
    const fetch = fakeFetch();
    const bytes = await new AssetCache({ fetch, caches: storage }).get(
      "tok",
      HASH,
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses content that does not match its hash", async () => {
    const { storage, cache: store } = fakeCaches();
    const served = vi.fn<typeof fetch>(async () => new Response(OTHER_BYTES));
    await expect(
      new AssetCache({ fetch: served, caches: storage }).get("tok", HASH),
    ).rejects.toThrow(/different content/);
    expect(store.put).not.toHaveBeenCalled();
  });
});
