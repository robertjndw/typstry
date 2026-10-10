import { zipSync, type Zippable } from "fflate";

import { isSafePath } from "@/doc/fs-ops";
import { dirname } from "@/doc/names";
import { buildPathIndex } from "@/doc/paths";
import { fileText } from "@/doc/restore";
import { NODE, type ProjectDoc } from "@/doc/schema";
import { toError } from "@/lib/errors";

export class ExportError extends Error {
  /** Paths of the files that could not be included. */
  readonly paths: string[];

  constructor(paths: string[], cause?: Error) {
    super(
      `Could not load ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
      { cause },
    );
    this.name = "ExportError";
    this.paths = paths;
  }
}

export interface ExportedZip {
  zip: Uint8Array<ArrayBuffer>;
  /**
   * Paths left out because unpacking them could be unsafe, sorted. A
   * modified client can put `.GIT/config` in a project, and unzipped into a
   * checkout on macOS or Windows that would become git's own config.
   */
  skipped: string[];
}

/**
 * Packs every file of `project` into a zip, using the same paths the
 * compiler sees (clash losers keep their "~id" names). If any asset fails to
 * load, the whole export fails. A zip with missing images looks fine until
 * someone tries to compile it.
 */
export async function exportZip(
  project: ProjectDoc,
  /** Plaintext bytes by hash, normally ProjectAssets.load. */
  loadAsset: ((hash: string) => Promise<Uint8Array>) | null,
  /** Modification time stamped on the entries, unix ms. */
  mtime = Date.now(),
): Promise<ExportedZip> {
  const index = buildPathIndex(project);
  const files: Zippable = {};
  const pending: Promise<void>[] = [];
  const failed: string[] = [];
  let firstError: Error | undefined;
  const nonEmptyDirs = new Set<string>();
  const dirs: string[] = [];
  const encoder = new TextEncoder();
  const skipped: string[] = [];

  for (const [id, { path, kind }] of index.byId) {
    if (!isSafePath(path)) {
      skipped.push(path);
      continue;
    }
    const parent = dirname(path);
    if (parent) nonEmptyDirs.add(parent);
    if (kind === "dir") {
      dirs.push(path);
      continue;
    }
    if (kind === "text") {
      files[path] = encoder.encode(fileText(project, id) ?? "");
      continue;
    }
    const hash: unknown = project.fs.getNodeByID(id)!.data.get(NODE.hash);
    if (!loadAsset || typeof hash !== "string") {
      failed.push(path);
      continue;
    }
    pending.push(
      loadAsset(hash).then(
        // Images, PDFs and fonts are compressed already; deflating them
        // again only costs time.
        (bytes) => void (files[path] = [bytes, { level: 0 }]),
        (err: unknown) => {
          failed.push(path);
          firstError ??= toError(err);
        },
      ),
    );
  }
  await Promise.all(pending);
  if (failed.length > 0) throw new ExportError(failed.sort(), firstError);

  // Zips only know folders implicitly through file paths, so an empty one
  // needs an explicit entry to survive.
  for (const dir of dirs) {
    if (!nonEmptyDirs.has(dir)) files[`${dir}/`] = new Uint8Array(0);
  }
  return { zip: zipSync(files, { level: 6, mtime }), skipped: skipped.sort() };
}
