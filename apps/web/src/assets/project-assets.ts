import {
  BLOB_CONTEXT,
  SEAL_OVERHEAD,
  open,
  seal,
  type ProjectKey,
} from "@/crypto/project-key";
import { extensionOf } from "@/doc/names";
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

const GENERIC_MIME = new Set(["", "application/octet-stream"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  bib: "application/x-bibtex",
  txt: "text/plain",
};

/**
 * The browser's idea of the type when it has one, else a guess from the
 * extension. Browsers report nothing useful for extensions they do not
 * know, which includes most fonts on some platforms.
 */
export function mimeOf(file: Pick<File, "name" | "type">): string {
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  if (!GENERIC_MIME.has(type)) return type;
  return (
    MIME_BY_EXTENSION[extensionOf(file.name)] ?? "application/octet-stream"
  );
}
