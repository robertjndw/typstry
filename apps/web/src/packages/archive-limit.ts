import { MAX_ASSET_BYTES } from "@/assets/project-assets";
import { mb } from "@/import/unzip-limits";

import { PackageError } from "./errors";

/**
 * The stored .tar.gz is one asset, so it has to fit the upload limit. Kept
 * apart from limits.ts, which the zip worker imports.
 */
export const MAX_PACKAGE_ARCHIVE_BYTES = MAX_ASSET_BYTES;

export function packageTooLarge(): PackageError {
  return new PackageError(
    `The package is larger than ${mb(MAX_PACKAGE_ARCHIVE_BYTES)} MB.`,
  );
}
