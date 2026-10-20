import {
  META,
  PACKAGE,
  PACKAGE_SOURCES,
  type PackageRecord,
  type ProjectDoc,
} from "@/doc/schema";

import type { FontBundleId } from "@/fonts/builtin";

import { formatSpec, packageKey } from "./spec";

export { packageKey };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("/") &&
    !value.includes("..")
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[/\\]/).includes("..");
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

/**
 * Validates a stored record. Peers write these directly, bypassing the
 * upload checks, and the fields end up in file paths and package specs, so
 * anything malformed is dropped rather than repaired. Unknown fields are
 * not carried over.
 */
export function parsePackageRecord(
  key: string,
  value: unknown,
): PackageRecord | null {
  if (!isObject(value)) return null;
  const namespace = value[PACKAGE.namespace];
  const name = value[PACKAGE.name];
  const version = value[PACKAGE.version];
  if (!isSegment(namespace) || !isSegment(name) || !isSegment(version))
    return null;
  if (key !== packageKey({ namespace, name, version })) return null;

  const hash = value[PACKAGE.hash];
  const mime = value[PACKAGE.mime];
  const entrypoint = value[PACKAGE.entrypoint];
  const size = value[PACKAGE.size];
  const fileCount = value[PACKAGE.fileCount];
  const unpackedSize = value[PACKAGE.unpackedSize];
  const addedAt = value[PACKAGE.addedAt];
  const source = value[PACKAGE.source];
  if (typeof hash !== "string" || typeof mime !== "string") return null;
  if (!isRelativePath(entrypoint)) return null;
  if (!isCount(size) || !isCount(fileCount) || !isCount(unpackedSize))
    return null;
  if (!isCount(addedAt)) return null;
  if (!PACKAGE_SOURCES.some((s) => s === source)) return null;

  const description = optionalString(value[PACKAGE.description]);
  const license = optionalString(value[PACKAGE.license]);
  const compiler = optionalString(value[PACKAGE.compiler]);
  if (description === null || license === null || compiler === null)
    return null;
  const authors = value[PACKAGE.authors];
  if (
    authors !== undefined &&
    !(
      Array.isArray(authors) &&
      authors.every((a): a is string => typeof a === "string")
    )
  )
    return null;

  const record: PackageRecord = {
    namespace,
    name,
    version,
    hash,
    size,
    mime,
    entrypoint,
    fileCount,
    unpackedSize,
    source: source as PackageRecord["source"],
    addedAt,
  };
  if (description !== undefined) record.description = description;
  if (authors !== undefined) record.authors = [...(authors as string[])];
  if (license !== undefined) record.license = license;
  if (compiler !== undefined) record.compiler = compiler;
  return record;
}

/** All valid package records, sorted by key. */
export function readPackages(project: ProjectDoc): Map<string, PackageRecord> {
  const out = new Map<string, PackageRecord>();
  const entries = project.packages.keys().sort();
  for (const key of entries) {
    const value: unknown = project.packages.get(key);
    const record = parsePackageRecord(key, value);
    if (record) out.set(key, record);
  }
  return out;
}

export function putPackage(project: ProjectDoc, record: PackageRecord): void {
  const key = packageKey(record);
  // Stored as a plain object so a replacement is one atomic write.
  project.packages.set(key, { ...record });
  project.doc.commit({
    message: `add package ${formatSpec(record)}`,
  });
}

export function deletePackage(project: ProjectDoc, key: string): void {
  const [namespace = "", name = "", version = ""] = key.split("/");
  project.packages.delete(key);
  project.doc.commit({
    message: `remove package ${formatSpec({ namespace, name, version })}`,
  });
}

const BUNDLE_KEYS = { cjk: META.cjkFonts, emoji: META.emojiFonts } as const;

export function setFontBundle(
  project: ProjectDoc,
  bundle: FontBundleId,
  on: boolean,
): void {
  project.meta.set(BUNDLE_KEYS[bundle], on);
  project.doc.commit({
    message: `${on ? "enable" : "disable"} ${bundle === "cjk" ? "CJK" : "emoji"} fonts`,
  });
}

export function readFontBundles(project: ProjectDoc): {
  cjk: boolean;
  emoji: boolean;
} {
  return {
    cjk: project.meta.get(META.cjkFonts) === true,
    emoji: project.meta.get(META.emojiFonts) === true,
  };
}
