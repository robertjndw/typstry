import type { Zippable } from "fflate";

import { untarPackage } from "@/packages/gzip";

/** Folder `typst compile --package-path` expects, next to the project. */
export const PACKAGES_DIR = "typst-packages";

export interface PackageArchive {
  /** `namespace/name/version`, the record key. */
  key: string;
  /** The stored .tar.gz. */
  bytes: Uint8Array;
}

/**
 * Unpacks each archive into `files` under `typst-packages/{key}/`. A package
 * with any path that would overwrite, or sit inside or on top of, a project
 * file is left out whole: half a package fails to compile in a more
 * confusing way than a missing one, and the user's own files are never the
 * ones to lose. Returns the keys that were left out, sorted.
 */
export function unpackPackages(
  archives: PackageArchive[],
  files: Zippable,
): string[] {
  const taken = new Set<string>();
  const folders = new Set<string>();
  for (const path of Object.keys(files)) {
    const clean = path.replace(/\/$/, "");
    // A trailing slash is an explicit empty folder, which packages may
    // share; only a real file blocks the path.
    if (clean === path) taken.add(clean);
    else folders.add(clean);
    for (let i = clean.indexOf("/"); i !== -1; i = clean.indexOf("/", i + 1)) {
      folders.add(clean.slice(0, i));
    }
  }

  const left: string[] = [];
  for (const { key, bytes } of [...archives].sort((a, b) =>
    a.key < b.key ? -1 : 1,
  )) {
    const entries = untarPackage(bytes);
    const base = `${PACKAGES_DIR}/${key}`;
    const paths = [...entries.keys()].map((rel) => `${base}/${rel}`);
    const clashes = paths.some((path) => {
      if (taken.has(path) || folders.has(path)) return true;
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
        if (taken.has(path.slice(0, i))) return true;
      }
      return false;
    });
    if (clashes) {
      left.push(key);
      continue;
    }
    for (const [rel, data] of entries) files[`${base}/${rel}`] = data;
  }
  return left;
}
