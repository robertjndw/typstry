import { zipSync, type Zippable } from "fflate";

import { isSafePath } from "@/doc/fs-ops";
import { dirname } from "@/doc/names";
import { buildPathIndex } from "@/doc/paths";
import { fileText } from "@/doc/restore";
import { NODE, type ProjectDoc } from "@/doc/schema";
import { mapConcurrent } from "@/lib/concurrent";
import { toError } from "@/lib/errors";
import { readPackages } from "@/packages/records";
import { formatSpec } from "@/packages/spec";

import { unpackPackages, type PackageArchive } from "./unpack";
import type { ZipRequest, ZipResponse } from "./zip.worker";

/** Asset downloads in flight at once; each one is a fetch and a decrypt. */
const LOAD_CONCURRENCY = 4;

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
  /** Packages in the zip, unpacked under `typst-packages/`. */
  packages: number;
  /**
   * Package keys left out because the project has files at the same paths,
   * sorted. They stay in the project; only the export loses them.
   */
  packagesLeftOut: string[];
}

/**
 * Packs every file of `project` into a zip, using the same paths the
 * compiler sees (clash losers keep their "~id" names). If any asset fails to
 * load, the whole export fails. Project packages are unpacked into
 * `typst-packages/`, which `typst compile --package-path` takes as is. A zip with missing images looks fine until
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
  const assets: { path: string; hash: string }[] = [];
  const records = [...readPackages(project)];
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
    assets.push({ path, hash });
  }
  const archives: PackageArchive[] = [];
  if (loadAsset) {
    const fail = (name: string, err: unknown) => {
      failed.push(name);
      firstError ??= toError(err);
    };
    // One queue for both, so packages do not add to the downloads in flight.
    await mapConcurrent(
      [
        ...assets.map(({ path, hash }) => ({
          name: path,
          hash,
          // Images, PDFs and fonts are compressed already; deflating them
          // again only costs time.
          onLoad: (bytes: Uint8Array) => {
            files[path] = [bytes, { level: 0 }];
          },
        })),
        ...records.map(([key, r]) => ({
          name: formatSpec(r),
          hash: r.hash,
          onLoad: (bytes: Uint8Array) => {
            archives.push({ key, bytes });
          },
        })),
      ],
      LOAD_CONCURRENCY,
      ({ name, hash, onLoad }) =>
        loadAsset(hash).then(onLoad, (err: unknown) => fail(name, err)),
    );
  } else {
    for (const [, r] of records) {
      failed.push(formatSpec(r));
    }
  }
  if (failed.length > 0) throw new ExportError(failed.sort(), firstError);

  // Zips only know folders implicitly through file paths, so an empty one
  // needs an explicit entry to survive.
  for (const dir of dirs) {
    if (!nonEmptyDirs.has(dir)) files[`${dir}/`] = new Uint8Array(0);
  }
  const built = await zip(files, archives, mtime);
  return {
    zip: built.zip,
    skipped: skipped.sort(),
    packages: archives.length - built.left.length,
    packagesLeftOut: built.left,
  };
}

/**
 * Deflates off the main thread; a project with large text files or many
 * images would otherwise freeze the page. A module worker of our own rather
 * than fflate's async API, which builds its workers from blob URLs and
 * starts one per large file. Falls back to the main thread where there are
 * no workers (tests).
 */
function zip(
  files: Zippable,
  packages: PackageArchive[],
  mtime: number,
): Promise<{ zip: Uint8Array<ArrayBuffer>; left: string[] }> {
  if (typeof Worker === "undefined") {
    return new Promise((resolve) => {
      const left = unpackPackages(packages, files);
      resolve({
        zip: zipSync(files, { level: 6, mtime }) as Uint8Array<ArrayBuffer>,
        left,
      });
    });
  }
  const worker = new Worker(new URL("./zip.worker.ts", import.meta.url), {
    type: "module",
    name: "zip",
  });
  const transfer = new Set<ArrayBuffer>();
  const candidates = [
    ...Object.values(files).map((e) => (Array.isArray(e) ? e[0] : e)),
    ...packages.map((p) => p.bytes),
  ];
  for (const bytes of candidates) {
    // Only buffers nothing else could be looking at: the loader hands out
    // fresh ones, but a view into something larger would take the rest
    // along when detached.
    if (
      bytes instanceof Uint8Array &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    )
      transfer.add(bytes.buffer as ArrayBuffer);
  }
  return new Promise<{ zip: Uint8Array<ArrayBuffer>; left: string[] }>(
    (resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ZipResponse>) => {
        if (e.data.ok) resolve({ zip: e.data.zip, left: e.data.left });
        else reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || "zip failed"));
      const request: ZipRequest = { files, packages, mtime };
      worker.postMessage(request, [...transfer]);
    },
  ).finally(() => worker.terminate());
}
