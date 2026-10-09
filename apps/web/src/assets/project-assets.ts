import { mimeOf } from "@/assets/file-types";
import {
  BLOB_CONTEXT,
  SEAL_OVERHEAD,
  open,
  seal,
  type ProjectKey,
} from "@/crypto/project-key";
import type { AssetInfo } from "@/doc/schema";
import { ApiError, MAX_UPLOAD_BYTES, uploadBlob } from "@/sync/api";
import { AssetCache } from "@/typst/asset-cache";

/** Binary files of a synced project, encrypted on the way to the server. */
export interface ProjectAssets {
  /** The plaintext bytes of the blob the doc refers to by `hash`. */
  load(hash: string): Promise<Uint8Array>;
  /** Encrypts and uploads `file`; the caller adds the node to the doc. */
  store(file: File, opts?: { signal?: AbortSignal }): Promise<AssetInfo>;
}

/** Largest file that still fits the server's limit once encrypted. */
export const MAX_ASSET_BYTES = MAX_UPLOAD_BYTES - SEAL_OVERHEAD;

let sharedCache: AssetCache | null = null;

export function projectAssets(
  token: string,
  key: ProjectKey,
  opts: { cache?: AssetCache; baseUrl?: string } = {},
): ProjectAssets {
  const cache = opts.cache ?? (sharedCache ??= new AssetCache());
  return {
    // The cache holds ciphertext, so decrypted files never sit in Cache
    // Storage; decrypting again on each load is cheap next to compiling.
    load: async (hash) => open(key, await cache.get(token, hash), BLOB_CONTEXT),
    async store(file, { signal } = {}) {
      if (file.size > MAX_ASSET_BYTES) {
        throw new ApiError(
          413,
          `${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
        );
      }
      const plaintext = new Uint8Array(await file.arrayBuffer());
      const sealed = await seal(key, plaintext, BLOB_CONTEXT);
      const { hash } = await uploadBlob(token, sealed, file.name, {
        baseUrl: opts.baseUrl,
        signal,
      });
      return { hash, size: file.size, mime: mimeOf(file) };
    },
  };
}
