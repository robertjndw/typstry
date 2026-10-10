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
import { toError } from "@/lib/errors";

import { unzip } from "./unzip";

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

// OS clutter nobody means to import. Dropped without a mention.
const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const JUNK_DIRS = new Set(["__MACOSX"]);

// Uploads run a few at a time: one by one is slow for a folder of figures,
// all at once can stall the browser on a big project.
const UPLOAD_CONCURRENCY = 4;

export async function readZip(file: File): Promise<ImportSource> {
  let entries: [string, Uint8Array][];
  try {
    entries = await unzip(await file.arrayBuffer());
  } catch (err) {
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
  const raw = await Promise.all(
    entries.map(async ({ path, file }) => ({
      path,
      bytes: file && new Uint8Array(await file.arrayBuffer()),
    })),
  );
  return collect("", raw);
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
    .filter(
      ({ segments }) =>
        segments.length > 0 &&
        !segments.some((s) => JUNK_DIRS.has(s)) &&
        !JUNK_NAMES.has(segments.at(-1)!),
    );

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
  const tooLarge = [...source.files]
    .filter(
      // Size first: decoding a large text file just to skip it is wasted.
      ([path, bytes]) => bytes.length > MAX_ASSET_BYTES && !isText(path, bytes),
    )
    .map(([path]) => path)
    .sort();
  if (tooLarge.length > 0) {
    const what =
      tooLarge.length === 1 ? tooLarge[0] : `${tooLarge.length} files`;
    throw new ImportError(
      `${what} ${tooLarge.length === 1 ? "is" : "are"} larger than ${Math.floor(MAX_ASSET_BYTES / 1024 / 1024)} MB`,
      tooLarge,
    );
  }
}

function isText(path: string, bytes: Uint8Array): boolean {
  return decodeText(basename(path), bytes) !== null;
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
  let next = 0;
  let settled = 0;
  onProgress?.(0, binaries.length);
  async function worker() {
    while (next < binaries.length) {
      const [path, bytes] = binaries[next++]!;
      try {
        const file = new File(
          [bytes as Uint8Array<ArrayBuffer>],
          basename(path),
        );
        stored.set(path, await assets.store(file));
      } catch (err) {
        failed.push(path);
        firstError ??= toError(err);
      }
      onProgress?.(++settled, binaries.length);
    }
  }
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, () => worker()));
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
