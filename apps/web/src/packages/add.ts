import type { PackageRecord, ProjectDoc } from "@/doc/schema";
import type { ProjectAssets } from "@/assets/project-assets";

import { PackageError } from "./errors";
import type { PreparedPackage } from "./normalize";
import { putPackage, readPackages } from "./records";
import { isIdent } from "./spec";

/** The package already stored under `key`, if any. */
export function findConflict(
  project: ProjectDoc,
  key: string,
): PackageRecord | null {
  return readPackages(project).get(key) ?? null;
}

/**
 * Stores the archive, then records the package. The doc is only touched once
 * the upload succeeded, so a failed upload leaves no record pointing at a
 * blob that is not there. Replacing an existing key is the caller's call;
 * see findConflict.
 */
export async function addPackage(
  project: ProjectDoc,
  assets: ProjectAssets,
  prepared: PreparedPackage,
  opts: {
    namespace: string;
    source: PackageRecord["source"];
    signal?: AbortSignal;
  },
): Promise<PackageRecord> {
  const { namespace, source, signal } = opts;
  if (!isIdent(namespace)) {
    throw new PackageError(
      `"${namespace}" is not a valid namespace. Use letters, digits, - and _, starting with a letter.`,
    );
  }
  const { manifest } = prepared;
  const file = new File(
    [prepared.archive as Uint8Array<ArrayBuffer>],
    `${manifest.name}-${manifest.version}.tar.gz`,
    { type: "application/gzip" },
  );
  const stored = await assets.store(file, { signal });

  // Optional fields are left out rather than undefined, which the doc cannot hold.
  const record: PackageRecord = {
    namespace,
    name: manifest.name,
    version: manifest.version,
    hash: stored.hash,
    size: stored.size,
    mime: stored.mime,
    entrypoint: manifest.entrypoint,
    fileCount: prepared.fileCount,
    unpackedSize: prepared.unpackedSize,
    source,
    addedAt: Date.now(),
  };
  if (manifest.description !== undefined)
    record.description = manifest.description;
  if (manifest.authors !== undefined) record.authors = manifest.authors;
  if (manifest.license !== undefined) record.license = manifest.license;
  if (manifest.compiler !== undefined) record.compiler = manifest.compiler;

  putPackage(project, record);
  return record;
}
