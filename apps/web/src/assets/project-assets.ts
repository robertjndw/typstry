import { mimeOf } from "@/assets/file-types";
import { BLOB_OVERHEAD, type SpaceCrypto } from "@/crypto/space-crypto";
import type { AssetInfo } from "@/doc/schema";
import type { DocBackend } from "@/persist/local-doc-store";
import { ApiError, MAX_UPLOAD_BYTES, uploadBlob } from "@/sync/api";
import { AssetCache, contentHash } from "@/typst/asset-cache";

/** Binary files of a synced project, encrypted on the way to the server. */
export interface ProjectAssets {
  /** The plaintext bytes of the blob the doc refers to by `hash`. */
  load(hash: string): Promise<Uint8Array>;
  /** Encrypts and uploads `file`; the caller adds the node to the doc. */
  store(file: File, opts?: { signal?: AbortSignal }): Promise<AssetInfo>;
}

/** Largest file that still fits the server's limit once encrypted. */
export const MAX_ASSET_BYTES = MAX_UPLOAD_BYTES - BLOB_OVERHEAD;

let sharedCache: AssetCache | null = null;

// Both kinds of project report the server's limit, so a file refused in one
// is described the same way in the other.
function assertFits(file: File, limit: number): void {
  if (file.size > limit) {
    throw new ApiError(
      413,
      `${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
    );
  }
}

export function projectAssets(
  token: string,
  crypto: SpaceCrypto,
  opts: { cache?: AssetCache; baseUrl?: string } = {},
): ProjectAssets {
  const cache = opts.cache ?? (sharedCache ??= new AssetCache());
  return {
    // The cache holds ciphertext, so decrypted files never sit in Cache
    // Storage; decrypting again on each load is cheap next to compiling.
    load: async (hash) => crypto.openBlob(await cache.get(token, hash)),
    async store(file, { signal } = {}) {
      assertFits(file, MAX_ASSET_BYTES);
      const plaintext = new Uint8Array(await file.arrayBuffer());
      const sealed = crypto.sealBlob(plaintext);
      const [{ hash }, expected] = await Promise.all([
        uploadBlob(token, sealed, file.name, {
          baseUrl: opts.baseUrl,
          signal,
        }),
        contentHash(sealed),
      ]);
      // The doc we sign names the blob by this hash, and downloads are only
      // checked against it. Taking the server's word for it would let the
      // server pick which blob the signed doc points at.
      if (hash !== expected) {
        throw new ApiError(
          502,
          `uploading ${file.name} failed: the server named it ${hash}, not ${expected}`,
        );
      }
      return { hash, size: file.size, mime: mimeOf(file) };
    },
  };
}

/**
 * Binary files of a project that has no server: the plaintext goes to the
 * browser's blob store, keyed by content hash. AssetCache can't be the
 * only copy, it evicts what has not been used for a while.
 */
export function localProjectAssets(
  spaceId: string,
  backend: DocBackend,
): ProjectAssets {
  return {
    async load(hash) {
      const data = await backend.loadBlob(spaceId, hash);
      if (!data)
        throw new Error(`the file ${hash} is missing from this browser`);
      return data;
    },
    async store(file) {
      assertFits(file, MAX_UPLOAD_BYTES);
      const data = new Uint8Array(await file.arrayBuffer());
      const hash = await contentHash(data);
      await backend.saveBlob(spaceId, hash, data);
      return { hash, size: file.size, mime: mimeOf(file) };
    },
  };
}
