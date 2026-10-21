import { ImportError, readZip, type ImportSource } from "@/import/import";
import { isJunk, mb } from "@/import/unzip-limits";

import { PackageError } from "./errors";
import { gzipDeterministic, untarPackage } from "./gzip";
import { MAX_PACKAGE_ARCHIVE_BYTES, packageTooLarge } from "./archive-limit";
import { MAX_PACKAGE_FILES, MAX_PACKAGE_UNPACKED_BYTES } from "./limits";
import { parseCompiler, parseManifest, type PackageManifest } from "./manifest";
import { compareVersions, TYPST_VERSION, parseVersion } from "./spec";
import { writeTar } from "./tar";
import { findPreviewImports } from "./universe";

export type PackageInput =
  | { kind: "archive"; file: File }
  | { kind: "zip"; file: File }
  | { kind: "source"; source: Promise<ImportSource> }
  | { kind: "universe"; name: string; version: string; bytes: Uint8Array };

export interface PreparedPackage {
  manifest: PackageManifest;
  /** The canonical .tar.gz that gets stored. */
  archive: Uint8Array;
  fileCount: number;
  unpackedSize: number;
  /** Paths the project tree could not hold, so they are not in the archive. */
  skipped: string[];
  warnings: string[];
  /** `@preview` packages the package's own sources import. */
  dependencies: string[];
}

const MANIFEST = "typst.toml";

/**
 * Finds the package root: typst.toml at the top, or inside the one folder
 * that holds everything (what zipping or tarring a folder produces).
 * Returns the files relative to that root.
 */
export function locateRoot(files: Map<string, Uint8Array>): {
  root: string;
  files: Map<string, Uint8Array>;
} {
  if (files.has(MANIFEST)) return { root: "", files };
  const tops = new Set([...files.keys()].map((p) => p.split("/")[0]!));
  const [only] = tops;
  if (
    tops.size === 1 &&
    only !== undefined &&
    files.has(`${only}/${MANIFEST}`)
  ) {
    const prefix = `${only}/`;
    const inner = new Map<string, Uint8Array>();
    for (const [path, bytes] of files)
      inner.set(path.slice(prefix.length), bytes);
    return { root: only, files: inner };
  }
  throw new PackageError(
    "No typst.toml at the top of the package or inside a single folder.",
  );
}

function dropJunk(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const kept = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    const segments = path.split("/");
    // "._name" files are macOS resource forks that tar writes beside the
    // real file; they would also count as a second top-level entry.
    if (isJunk(segments) || segments.at(-1)!.startsWith("._")) continue;
    kept.set(path, bytes);
  }
  return kept;
}

async function readArchiveFile(file: File): Promise<Uint8Array> {
  assertArchiveSize(file.size);
  return new Uint8Array(await file.arrayBuffer());
}

function assertArchiveSize(size: number): void {
  if (size > MAX_PACKAGE_ARCHIVE_BYTES) throw packageTooLarge();
}

// Twice the file cap: uploads may carry clutter that is dropped before the
// real count is checked.
const untar = (bytes: Uint8Array) => untarPackage(bytes, MAX_PACKAGE_FILES * 2);

function readManifest(files: Map<string, Uint8Array>): PackageManifest {
  const bytes = files.get(MANIFEST)!;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackageError("typst.toml is not valid UTF-8 text.");
  }
  const manifest = parseManifest(text);
  if (!files.has(manifest.entrypoint)) {
    throw new PackageError(
      `The entrypoint ${manifest.entrypoint} is not in the package.`,
    );
  }
  return manifest;
}

function totals(files: Map<string, Uint8Array>) {
  let unpackedSize = 0;
  for (const bytes of files.values()) unpackedSize += bytes.length;
  if (files.size > MAX_PACKAGE_FILES) {
    throw new PackageError(
      `The package has more than ${MAX_PACKAGE_FILES} files.`,
    );
  }
  if (unpackedSize > MAX_PACKAGE_UNPACKED_BYTES) {
    throw new PackageError(
      `The package unpacks to more than ${mb(MAX_PACKAGE_UNPACKED_BYTES)} MB.`,
    );
  }
  return { fileCount: files.size, unpackedSize };
}

function warningsFor(manifest: PackageManifest): string[] {
  const needed = manifest.compiler ? parseCompiler(manifest.compiler) : null;
  const have = parseVersion(TYPST_VERSION)!;
  if (needed && compareVersions(needed, have) > 0) {
    return [
      `This package needs Typst ${manifest.compiler} or newer, and the editor compiles with ${TYPST_VERSION}.`,
    ];
  }
  return [];
}

function dependenciesOf(
  files: Map<string, Uint8Array>,
  manifest: PackageManifest,
): string[] {
  const decoder = new TextDecoder();
  const texts = [...files]
    .filter(([path]) => path.endsWith(".typ"))
    .map(([path, bytes]) => ({ path, text: decoder.decode(bytes) }));
  const self = `@preview/${manifest.name}:${manifest.version}`;
  return findPreviewImports(texts)
    .map((i) => i.spec)
    .filter((spec) => spec !== self);
}

async function sourceFiles(
  source: Promise<ImportSource>,
): Promise<{ files: Map<string, Uint8Array>; skipped: string[] }> {
  try {
    const { files, skipped } = await source;
    return { files, skipped };
  } catch (err) {
    if (err instanceof ImportError) throw new PackageError(err.message, err);
    throw err;
  }
}

/**
 * Validates a package from any source and produces its canonical archive.
 * Uploads are repacked (sorted, no timestamps, no clutter), so the same
 * package always has the same hash. Universe archives are kept byte for
 * byte, so what is stored is what the registry published.
 */
export async function preparePackage(
  input: PackageInput,
): Promise<PreparedPackage> {
  let skipped: string[] = [];
  let raw: Map<string, Uint8Array>;

  switch (input.kind) {
    case "archive":
      raw = untar(await readArchiveFile(input.file));
      break;
    case "zip": {
      assertArchiveSize(input.file.size);
      try {
        ({ files: raw, skipped } = await sourceFiles(readZip(input.file)));
      } catch (err) {
        throw err instanceof PackageError ? err : new PackageError(String(err));
      }
      break;
    }
    case "source":
      ({ files: raw, skipped } = await sourceFiles(input.source));
      break;
    case "universe":
      assertArchiveSize(input.bytes.length);
      raw = untar(input.bytes);
      break;
  }

  const { root, files } = locateRoot(dropJunk(raw));
  if (input.kind === "universe" && root !== "") {
    throw new PackageError("The package has no typst.toml at its top.");
  }
  const manifest = readManifest(files);
  const stats = totals(files);

  let archive: Uint8Array;
  if (input.kind === "universe") {
    if (manifest.name !== input.name || manifest.version !== input.version) {
      throw new PackageError(
        `Typst Universe sent ${manifest.name}:${manifest.version} instead of ${input.name}:${input.version}.`,
      );
    }
    archive = input.bytes;
  } else {
    archive = gzipDeterministic(writeTar(files));
    assertArchiveSize(archive.length);
  }

  return {
    manifest,
    archive,
    ...stats,
    skipped,
    warnings: warningsFor(manifest),
    dependencies: dependenciesOf(files, manifest),
  };
}
