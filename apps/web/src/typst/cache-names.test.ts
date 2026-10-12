import { describe, expect, it } from "vitest";

import { BLOB_CACHE, FONT_CACHE, pruneStaleCaches } from "./cache-names";

function fakeStorage(names: string[]) {
  const live = new Set(names);
  return {
    live,
    storage: {
      keys: async () => [...live],
      delete: async (name: string) => live.delete(name),
    } as unknown as CacheStorage,
  };
}

describe("pruneStaleCaches", () => {
  it("deletes only old typstry caches", async () => {
    const { live, storage } = fakeStorage([
      BLOB_CACHE,
      FONT_CACHE,
      "typstry-blobs-v0",
      "typstry-fonts-v0",
      "other-app",
    ]);
    await pruneStaleCaches(storage);
    expect([...live].sort()).toEqual(
      [BLOB_CACHE, FONT_CACHE, "other-app"].sort(),
    );
  });

  it("tolerates missing or failing storage", async () => {
    await expect(pruneStaleCaches(undefined)).resolves.toBeUndefined();
    const broken = {
      keys: async () => {
        throw new Error("denied");
      },
    } as unknown as CacheStorage;
    await expect(pruneStaleCaches(broken)).resolves.toBeUndefined();
  });
});
