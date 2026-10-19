// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { newProject } from "@/crypto/test-utils";
import { AssetCache, contentHash } from "@/typst/asset-cache";

import { mimeOf } from "./file-types";
import { MemoryBackend } from "@/persist/local-doc-store";
import { MAX_UPLOAD_BYTES } from "@/sync/api";

import {
  localProjectAssets,
  MAX_ASSET_BYTES,
  projectAssets,
} from "./project-assets";

afterEach(() => vi.unstubAllGlobals());

/** A blob store that keeps whatever it is sent, like the server does. */
function fakeServer() {
  const blobs = new Map<string, Uint8Array>();
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = init.body as Uint8Array;
      const hash = await contentHash(body);
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
    const key = newProject().crypto;
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

    const stranger = projectAssets("tok", newProject().crypto, {
      cache: new AssetCache({ caches: null }),
    });
    await expect(stranger.load(info.hash)).rejects.toThrow();
  });

  it("refuses files that would not fit once encrypted", async () => {
    const { fetch } = fakeServer();
    const key = newProject().crypto;
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

describe("localProjectAssets", () => {
  it("round-trips a file through the blob store by content hash", async () => {
    const backend = new MemoryBackend();
    const assets = localProjectAssets("p1", backend);
    const file = new File(["figure"], "fig.png", { type: "image/png" });

    const info = await assets.store(file);

    expect(info).toEqual({
      hash: await contentHash(new TextEncoder().encode("figure")),
      size: 6,
      mime: "image/png",
    });
    expect(new TextDecoder().decode(await assets.load(info.hash))).toBe(
      "figure",
    );
  });

  it("keeps projects apart and drops blobs with their project", async () => {
    const backend = new MemoryBackend();
    const one = localProjectAssets("p1", backend);
    const two = localProjectAssets("p2", backend);
    const { hash } = await one.store(new File(["same"], "a.txt"));
    await two.store(new File(["same"], "a.txt"));

    await backend.remove("p1");

    await expect(one.load(hash)).rejects.toThrow(/missing/);
    expect(await two.load(hash)).toEqual(new TextEncoder().encode("same"));
  });

  it("refuses a file over the upload limit", async () => {
    const assets = localProjectAssets("p1", new MemoryBackend());
    const big = new File([], "big.bin");
    Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
    await expect(assets.store(big)).rejects.toMatchObject({ status: 413 });
  });
});
