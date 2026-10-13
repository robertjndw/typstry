// Shared by unzip.ts and its worker. Kept apart from unzip.ts, which spawns
// the worker, so the worker bundle does not include itself.
import { unzipSync } from "fflate";

// OS and tooling clutter nobody means to import. Dropped without a mention.
export const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
export const JUNK_DIRS = new Set(["__MACOSX", "node_modules"]);

export function isJunk(segments: string[]): boolean {
  return (
    segments.some((s) => JUNK_DIRS.has(s)) ||
    JUNK_NAMES.has(segments.at(-1) ?? "")
  );
}

/** Caps checked against the sizes the archive declares, before inflating. */
export interface UnzipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export interface UnzipRequest {
  zip: ArrayBuffer;
  limits: UnzipLimits;
}

export type UnzipResponse =
  | { ok: true; entries: [string, Uint8Array][] }
  | { ok: false; message: string; limit?: { paths: string[] } };

/** The archive is valid but too large to import. */
export class UnzipLimitError extends Error {
  /** Entries over the per-file cap, if that is what failed. */
  readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(message);
    this.name = "UnzipLimitError";
    this.paths = paths;
  }
}

export const mb = (bytes: number) => Math.floor(bytes / 1024 / 1024);

/** "a.png is larger than…" or "3 files are larger than…"; `paths` sorted. */
export function tooLargeMessage(paths: string[], limitBytes: number): string {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  return `${what} ${paths.length === 1 ? "is" : "are"} larger than ${mb(limitBytes)} MB`;
}

/**
 * unzipSync with limits. A small zip can declare gigabytes of content, and
 * inflating it all before anything checks sizes would take the tab down,
 * so the filter rejects by the declared sizes first. fflate inflates each
 * entry into a buffer of exactly its declared size, so a lying header
 * cannot get past that either.
 *
 * Entries the import drops anyway are left packed and do not count: macOS
 * adds a `__MACOSX` twin for every file, and a `.git` folder alone can hold
 * more objects (and larger packs) than the project has files. A `.git`
 * folder still comes back as one empty folder entry, so the import can say
 * it was left out.
 */
export function unzipWithLimits(
  zip: Uint8Array,
  limits: UnzipLimits,
): [string, Uint8Array][] {
  let count = 0;
  let total = 0;
  const tooLarge: string[] = [];
  const gitDirs = new Set<string>();
  const files = unzipSync(zip, {
    filter(file) {
      const segments = file.name.split("/");
      if (isJunk(segments.filter((s) => s !== ""))) return false;
      const git = segments.findIndex((s) => s.toLowerCase() === ".git");
      if (git >= 0) {
        gitDirs.add(segments.slice(0, git + 1).join("/") + "/");
        return false;
      }
      if (++count > limits.maxEntries) {
        throw new UnzipLimitError(
          `The archive has more than ${limits.maxEntries} entries`,
        );
      }
      if (file.originalSize > limits.maxEntryBytes) {
        tooLarge.push(file.name);
        return false;
      }
      total += file.originalSize;
      if (total > limits.maxTotalBytes) {
        throw new UnzipLimitError(
          `The archive unpacks to more than ${mb(limits.maxTotalBytes)} MB`,
        );
      }
      return true;
    },
  });
  if (tooLarge.length > 0) {
    tooLarge.sort();
    throw new UnzipLimitError(
      tooLargeMessage(tooLarge, limits.maxEntryBytes),
      tooLarge,
    );
  }
  const entries = Object.entries(files);
  for (const dir of gitDirs) entries.push([dir, new Uint8Array(0)]);
  return entries;
}
