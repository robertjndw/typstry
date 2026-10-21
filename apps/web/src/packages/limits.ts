// No imports on purpose: the zip worker reads these caps too, and pulling in
// the asset store would drag the crypto and sync layers into it. The archive
// size cap is in archive-limit.ts for that reason.

export const MAX_PACKAGE_FILES = 2000;
/**
 * Packages are untarred into the compiler's memory, and a small archive can
 * inflate to gigabytes, so the unpacked size is capped on its own.
 */
export const MAX_PACKAGE_UNPACKED_BYTES = 100 * 1024 * 1024;
