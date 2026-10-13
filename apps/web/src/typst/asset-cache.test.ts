// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { AssetCache, contentHash } from "./asset-cache";
import { BLOB_CACHE } from "./cache-names";

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
  const url = (key: string | Request) =>
    typeof key === "string" ? key : key.url;
  const cache = {
    match: vi.fn(async (key: string | Request) =>
      entries.get(url(key))?.clone(),
    ),
    put: vi.fn(async (key: string, res: Response) => {
      entries.set(key, res);
    }),
    keys: vi.fn(async () => [...entries.keys()].map((k) => new Request(k))),
    delete: vi.fn(async (key: string | Request) => entries.delete(url(key))),
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
      `/api/s/tok/blobs/${encodeURIComponent(HASH)}`,
    );
  });

  it("evicts the least recently used entry once over its byte budget", async () => {
    const fetch = fakeFetch();
    // HASH is 3 bytes and OTHER 2, so both together do not fit.
    const cache = new AssetCache({ fetch, caches: null, maxBytes: 4 });
    await cache.get("tok", HASH);
    await cache.get("tok", OTHER);
    await cache.get("tok", OTHER);
    expect(fetch).toHaveBeenCalledTimes(2);
    await cache.get("tok", HASH);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps several blobs that fit the budget together", async () => {
    const fetch = fakeFetch();
    const cache = new AssetCache({ fetch, caches: null, maxBytes: 5 });
    await cache.get("tok", HASH);
    await cache.get("tok", OTHER);
    await cache.get("tok", HASH);
    await cache.get("tok", OTHER);
    expect(fetch).toHaveBeenCalledTimes(2);
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

  describe("Cache Storage bound", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const keyOf = (hash: string) =>
      `https://typstry.invalid/__typstry-blob/${encodeURIComponent(hash)}`;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("drops the least recently used entries over its budget", async () => {
      const { storage, entries } = fakeCaches();
      const fetch = fakeFetch();
      let now = 1_000_000;
      const opts = { fetch, caches: storage, maxStoredBytes: 4 };
      await new AssetCache({ ...opts, now: () => now }).get("tok", HASH);
      await flush();
      now += 1000;
      await new AssetCache({ ...opts, now: () => now }).get("tok", OTHER);
      await flush();
      // Pruned at most once a minute, so going over is caught a bit later,
      // here by the next page load.
      expect(entries.size).toBe(2);
      now += 1000;
      await new AssetCache({ ...opts, now: () => now }).get("tok", OTHER);
      await flush();
      await flush();
      expect([...entries.keys()]).toEqual([keyOf(OTHER)]);
    });

    it("drops entries unused for months, and refreshes the ones in use", async () => {
      const { storage, entries } = fakeCaches();
      const fetch = fakeFetch();
      let now = 1_000_000;
      const opts = { fetch, caches: storage, now: () => now };
      await new AssetCache(opts).get("tok", HASH);
      await new AssetCache(opts).get("tok", OTHER);
      await flush();

      now += 60 * DAY;
      await new AssetCache(opts).get("tok", OTHER);
      await flush();
      expect(entries.get(keyOf(OTHER))!.headers.get("x-typstry-accessed")).toBe(
        String(now),
      );

      now += 40 * DAY;
      await new AssetCache(opts).get("tok", OTHER);
      await flush();
      await flush();
      expect([...entries.keys()]).toEqual([keyOf(OTHER)]);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
