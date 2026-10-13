import type { TreeID } from "loro-crdt";

import { MAX_ASSET_BYTES, type ProjectAssets } from "@/assets/project-assets";
import { decodeText } from "@/assets/upload";
import { createAsset, createFile, isSafePath, setMainFile } from "@/doc/fs-ops";
import { basename, dirname, extensionOf, stemLength } from "@/doc/names";
import {
  DEFAULT_MAIN_FILE,
  type AssetInfo,
  type ProjectDoc,
} from "@/doc/schema";
import { mapConcurrent } from "@/lib/concurrent";
import { toError } from "@/lib/errors";

import { unzip, UnzipLimitError, type UnzipLimits } from "./unzip";
import { isJunk, mb, tooLargeMessage } from "./unzip-limits";

export class ImportError extends Error {
  /** Paths of the files at fault, if the error is about specific files. */
  readonly paths: string[];

  constructor(message: string, paths: string[] = [], cause?: Error) {
    super(message, { cause });
    this.name = "ImportError";
    this.paths = paths;
  }
}

/** Files and folders to import, keyed by their path in the new project. */
export interface ImportSource {
  /** Zip or folder name, a sensible default for the project title. */
  name: string;
  files: Map<string, Uint8Array>;
  /** Every folder, including the parents of files, so empty ones survive. */
  dirs: Set<string>;
  /** Paths left out because no project may hold them, sorted. */
  skipped: string[];
}

interface RawEntry {
  path: string;
  /** null for an explicit folder entry. */
  bytes: Uint8Array | null;
}

export { JUNK_DIRS } from "./unzip-limits";

/** Most bytes one import reads, before anything is uploaded. */
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
/** Most files and folders one import takes. */
export const MAX_IMPORT_ENTRIES = 10_000;

const LIMITS: UnzipLimits = {
  maxEntries: MAX_IMPORT_ENTRIES,
  // Same cap as assertImportable, applied before inflating anything.
  maxEntryBytes: MAX_ASSET_BYTES,
  maxTotalBytes: MAX_IMPORT_BYTES,
};

export function tooManyEntries(): ImportError {
  return new ImportError(
    `There are more than ${MAX_IMPORT_ENTRIES} files and folders to import`,
  );
}

// Uploads run a few at a time: one by one is slow for a folder of figures,
// all at once can stall the browser on a big project.
const UPLOAD_CONCURRENCY = 4;

export async function readZip(file: File): Promise<ImportSource> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportError(
      `${file.name} is larger than ${mb(MAX_IMPORT_BYTES)} MB`,
    );
  }
  let entries: [string, Uint8Array][];
  try {
    entries = await unzip(await file.arrayBuffer(), LIMITS);
  } catch (err) {
    if (err instanceof UnzipLimitError)
      throw new ImportError(err.message, err.paths);
    throw new ImportError(
      `${file.name} is not a valid zip file`,
      [],
      toError(err),
    );
  }
  const raw = entries.map(([path, bytes]) => ({
    path,
    bytes: path.endsWith("/") ? null : bytes,
  }));
  return collect(file.name.slice(0, stemLength(file.name)), raw);
}

/** Loose files and folders by path; a null `file` is a folder. */
export async function readFiles(
  entries: { path: string; file: File | null }[],
): Promise<ImportSource> {
  if (entries.length > MAX_IMPORT_ENTRIES) throw tooManyEntries();
  // Sizes are known up front, so limits fail before anything is read, and
  // files collect() would drop anyway are never read at all.
  const wanted = entries.map(({ path, file }) => ({
    path,
    file: file && !dropped(segmentsOf(path)) ? file : null,
    isFile: file !== null,
  }));
  const tooLarge = wanted
    .filter(({ file }) => file && file.size > MAX_ASSET_BYTES)
    .map(({ path }) => segmentsOf(path).join("/"))
    .sort();
  if (tooLarge.length > 0) {
    throw new ImportError(tooLargeMessage(tooLarge, MAX_ASSET_BYTES), tooLarge);
  }
  const total = wanted.reduce((sum, { file }) => sum + (file?.size ?? 0), 0);
  if (total > MAX_IMPORT_BYTES) {
    throw new ImportError(
      `The files add up to more than ${mb(MAX_IMPORT_BYTES)} MB`,
    );
  }
  const raw = await mapConcurrent(
    wanted,
    8,
    async ({ path, file, isFile }) => ({
      path,
      // Skipped files stay files (empty ones), so collect() still reports
      // the reserved ones and the folder detection is unchanged.
      bytes: file
        ? new Uint8Array(await file.arrayBuffer())
        : isFile
          ? new Uint8Array()
          : null,
    }),
  );
  return collect("", raw);
}

/**
 * Whether collect() would drop a file at these segments no matter how the
 * import is wrapped: clutter, or a reserved name below the top level.
 */
function dropped(segments: string[]): boolean {
  return isJunk(segments) || segments.slice(1).some((s) => !isSafePath(s));
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * Normalizes paths and drops clutter. A zip of a folder, and every folder
 * pick, wraps everything in one top-level folder; that folder becomes the
 * project, so it is stripped and names the project instead.
 */
export function collect(fallbackName: string, raw: RawEntry[]): ImportSource {
  const entries = raw
    .map((e) => ({ segments: segmentsOf(e.path), bytes: e.bytes }))
    .filter(({ segments }) => segments.length > 0 && !isJunk(segments));

  let name = fallbackName;
  const root = entries[0]?.segments[0];
  const wrapped =
    root !== undefined &&
    entries.every(
      (e) =>
        e.segments[0] === root && (e.bytes === null || e.segments.length > 1),
    );
  if (wrapped) {
    name = root;
    for (const e of entries) e.segments.shift();
  }

  const source: ImportSource = {
    name,
    files: new Map(),
    dirs: new Set(),
    skipped: [],
  };
  for (const { segments, bytes } of entries) {
    if (segments.length === 0) continue;
    const path = segments.join("/");
    if (!isSafePath(path)) {
      source.skipped.push(path);
      continue;
    }
    if (bytes) source.files.set(path, bytes);
    else source.dirs.add(path);
    for (let dir = dirname(path); dir; dir = dirname(dir)) source.dirs.add(dir);
  }
  // "a" and "a/b" in one archive: a project cannot hold both.
  for (const path of source.files.keys()) {
    if (source.dirs.has(path)) {
      source.files.delete(path);
      source.skipped.push(path);
    }
  }
  source.skipped.sort();
  return source;
}

/**
 * Throws if `source` cannot be imported as a whole. Checked before the
 * project is registered, so a predictable failure creates nothing.
 */
export function assertImportable(source: ImportSource): void {
  if (source.files.size === 0 && source.dirs.size === 0) {
    throw new ImportError(
      source.skipped.length > 0
        ? "None of the files can be imported"
        : "There is nothing to import",
      source.skipped,
    );
  }
  // Text is capped far below the asset limit, so anything this large is
  // uploaded as an asset.
  const tooLarge = [...source.files]
    .filter(([, bytes]) => bytes.length > MAX_ASSET_BYTES)
    .map(([path]) => path)
    .sort();
  if (tooLarge.length > 0) {
    throw new ImportError(tooLargeMessage(tooLarge, MAX_ASSET_BYTES), tooLarge);
  }
}

/**
 * Writes `source` into a freshly initialized `project`. Binary files are
 * uploaded first and the doc is only touched once all of them made it, so
 * a failed import leaves the doc empty rather than missing images.
 */
export async function writeImport(
  project: ProjectDoc,
  source: ImportSource,
  assets: ProjectAssets,
  /** Called as binary files finish uploading. */
  onProgress?: (uploaded: number, total: number) => void,
): Promise<void> {
  const texts = new Map<string, string>();
  const binaries: [string, Uint8Array][] = [];
  for (const [path, bytes] of source.files) {
    const text = decodeText(basename(path), bytes);
    if (text !== null) texts.set(path, text);
    else binaries.push([path, bytes]);
  }

  const stored = new Map<string, AssetInfo>();
  const failed: string[] = [];
  let firstError: Error | undefined;
  let settled = 0;
  onProgress?.(0, binaries.length);
  await mapConcurrent(binaries, UPLOAD_CONCURRENCY, async ([path, bytes]) => {
    try {
      const file = new File([bytes as Uint8Array<ArrayBuffer>], basename(path));
      stored.set(path, await assets.store(file));
    } catch (err) {
      failed.push(path);
      firstError ??= toError(err);
    }
    onProgress?.(++settled, binaries.length);
  });
  if (failed.length > 0) {
    throw new ImportError(
      `Could not upload ${failed.length === 1 ? failed[0] : `${failed.length} files`}: ${firstError?.message}`,
      failed.sort(),
      firstError,
    );
  }

  // Sorted, a parent always comes before its children.
  const dirIds = new Map<string, TreeID>();
  const parentOf = (path: string) => dirIds.get(dirname(path)) ?? null;
  for (const dir of [...source.dirs].sort()) {
    dirIds.set(dir, createFile(project, parentOf(dir), basename(dir), "dir"));
  }
  const textIds = new Map<string, TreeID>();
  for (const [path, text] of texts) {
    textIds.set(
      path,
      createFile(project, parentOf(path), basename(path), "text", text),
    );
  }
  for (const [path, asset] of stored) {
    createAsset(project, parentOf(path), basename(path), asset);
  }

  const main = pickMainFile([...textIds.keys()]);
  if (main) setMainFile(project, textIds.get(main)!);
}

/**
 * The Typst file a project most likely compiles from: the shallowest .typ,
 * with main.typ winning ties and otherwise the first by name.
 */
export function pickMainFile(paths: string[]): string | null {
  const depth = (path: string) => path.split("/").length;
  const candidates = paths
    .filter((path) => extensionOf(path) === "typ")
    .sort(
      (a, b) =>
        depth(a) - depth(b) ||
        Number(basename(b) === DEFAULT_MAIN_FILE) -
          Number(basename(a) === DEFAULT_MAIN_FILE) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
  return candidates[0] ?? null;
}
