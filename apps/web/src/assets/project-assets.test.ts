// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateRawProjectKey, importProjectKey } from "@/crypto/project-key";
import { AssetCache } from "@/typst/asset-cache";

import { MAX_ASSET_BYTES, mimeOf, projectAssets } from "./project-assets";

afterEach(() => vi.unstubAllGlobals());

/** A blob store that keeps whatever it is sent, like the server does. */
function fakeServer() {
  const blobs = new Map<string, Uint8Array>();
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = init.body as Uint8Array;
      const hash = `sha256:${String(blobs.size).padStart(64, "0")}`;
      blobs.set(hash, body);
      return new Response(JSON.stringify({ hash, size: body.length }), {
        status: 201,
      });
    }
    const hash = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const bytes = blobs.get(hash);
    return bytes
      ? new Response(bytes.slice())
      : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchFn);
  return { blobs, fetch: fetchFn };
}

describe("projectAssets", () => {
  it("stores ciphertext and loads plaintext", async () => {
    const { blobs } = fakeServer();
    const key = await importProjectKey(generateRawProjectKey());
    const assets = projectAssets("tok", key, {
      cache: new AssetCache({ caches: null }),
    });
    const content = new TextEncoder().encode("private figure");
    const info = await assets.store(
      new File([content], "fig.png", { type: "image/png" }),
    );
    expect(info).toMatchObject({ size: content.length, mime: "image/png" });
    const stored = blobs.get(info.hash)!;
    expect(new TextDecoder().decode(stored)).not.toContain("private");
    expect(await assets.load(info.hash)).toEqual(content);

    const stranger = projectAssets(
      "tok",
      await importProjectKey(generateRawProjectKey()),
      { cache: new AssetCache({ caches: null }) },
    );
    await expect(stranger.load(info.hash)).rejects.toThrow();
  });

  it("refuses files that would not fit once encrypted", async () => {
    const { fetch } = fakeServer();
    const key = await importProjectKey(generateRawProjectKey());
    const assets = projectAssets("tok", key);
    const big = {
      name: "big.pdf",
      type: "",
      size: MAX_ASSET_BYTES + 1,
    } as File;
    await expect(assets.store(big)).rejects.toThrow(/larger than 25 MB/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("mimeOf", () => {
  it("prefers the browser's type and guesses otherwise", () => {
    expect(mimeOf({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(mimeOf({ name: "Inter.TTF", type: "" })).toBe("font/ttf");
    expect(mimeOf({ name: "x.otf", type: "application/octet-stream" })).toBe(
      "font/otf",
    );
    expect(mimeOf({ name: "data.bin", type: "" })).toBe(
      "application/octet-stream",
    );
  });
});
