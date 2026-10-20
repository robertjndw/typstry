import { Gunzip, gzipSync } from "fflate";

import { concatBytes } from "@/crypto/bytes";
import { mb } from "@/import/unzip-limits";

import { PackageError } from "./errors";
import { MAX_PACKAGE_FILES, MAX_PACKAGE_UNPACKED_BYTES } from "./limits";
import { readTar } from "./tar";

/**
 * Inflates `bytes`, giving up once the output passes `maxBytes`. Streaming,
 * so a gzip bomb is stopped near the cap instead of after it has filled
 * the tab's memory.
 */
export function gunzipLimited(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const gunzip = new Gunzip((chunk) => {
      total += chunk.length;
      if (total > maxBytes) throw new PackageError("TOO_LARGE");
      chunks.push(chunk);
    });
    gunzip.push(bytes, true);
  } catch (err) {
    if (err instanceof PackageError) {
      throw new PackageError(
        `The package unpacks to more than ${mb(maxBytes)} MB.`,
      );
    }
    throw new PackageError(
      "That is not a valid .tar.gz file.",
      err instanceof Error ? err : undefined,
    );
  }
  return concatBytes(chunks, total);
}

/**
 * The files of a package .tar.gz, within the package caps. Everything that
 * unpacks a stored archive goes through here, so a synced archive is held
 * to the same budget wherever it is opened.
 */
export function untarPackage(
  bytes: Uint8Array,
  maxEntries = MAX_PACKAGE_FILES,
): Map<string, Uint8Array> {
  // ustar spends a 512 byte header and block padding on every entry.
  const tar = gunzipLimited(
    bytes,
    MAX_PACKAGE_UNPACKED_BYTES + maxEntries * 1024,
  );
  return readTar(tar, {
    maxEntries,
    maxTotalBytes: MAX_PACKAGE_UNPACKED_BYTES,
  });
}

/** mtime 0 keeps the header free of the clock, so equal input is equal output. */
export function gzipDeterministic(tar: Uint8Array): Uint8Array {
  return gzipSync(tar, { level: 9, mtime: 0 });
}
