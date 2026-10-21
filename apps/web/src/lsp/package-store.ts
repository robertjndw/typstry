import { untarPackage } from "@/packages/gzip";
import { packageKey, type PackageSpec } from "@/packages/spec";

// Runs inside the tinymist worker, so like packages/spec.ts it must stay
// free of the doc layer and the DOM.

/** Where unpacked packages live as far as tinymist is concerned. */
export const PACKAGE_ROOT = "/typstry-packages";

export type FetchArchive = (spec: PackageSpec) => Uint8Array | undefined;

/**
 * Packages for tinymist's synchronous `resolveFn`. A package is "resolved" by
 * unpacking its archive into an in-memory tree and handing back the
 * directory; tinymist then reads the files through the same file requests
 * it uses for the project, which the worker answers from file().
 */
export class PackageStore {
  /** `data` is released once the package is unpacked into `files`. */
  private readonly projectPackages = new Map<
    string,
    { hash: string; data: Uint8Array | null }
  >();
  /** Resolved directory per package key, so each is unpacked once. */
  private readonly dirs = new Map<string, string>();
  /** Files by absolute path, across every unpacked package. */
  private readonly files = new Map<string, Uint8Array>();
  /** Paths belonging to each key, for dropping a package's files. */
  private readonly pathsByKey = new Map<string, string[]>();
  /**
   * Keys that failed to resolve. tinymist asks again on every compile, and
   * each retry would block the worker on another request.
   */
  private readonly failed = new Set<string>();

  private readonly fetchArchive: FetchArchive | null;

  constructor(fetchArchive: FetchArchive | null = null) {
    this.fetchArchive = fetchArchive;
  }

  /** `key` is the doc's "namespace/name/version". */
  set(key: string, hash: string, data: Uint8Array): void {
    this.drop(key);
    this.projectPackages.set(key, { hash, data });
  }

  remove(key: string): void {
    this.projectPackages.delete(key);
    this.drop(key);
  }

  /** The directory holding the package, or undefined if it is unknown. */
  resolve(spec: PackageSpec): string | undefined {
    const key = packageKey(spec);
    const known = this.dirs.get(key);
    if (known !== undefined) return known;
    if (this.failed.has(key)) return undefined;

    const project = this.projectPackages.get(key);
    let archive: Uint8Array | undefined;
    let dir: string;
    try {
      if (project) {
        archive = project.data ?? undefined;
        // The hash is part of the path: tinymist caches what it read from a
        // path, so replaced contents need a path it has never seen.
        dir = `${PACKAGE_ROOT}/${spec.namespace}/${spec.name}/${spec.version}-${project.hash.slice(0, 12)}`;
      } else if (spec.namespace === "preview" && this.fetchArchive) {
        archive = this.fetchArchive(spec);
        dir = `${PACKAGE_ROOT}/${spec.namespace}/${spec.name}/${spec.version}`;
      } else {
        return undefined;
      }
      if (!archive) {
        this.failed.add(key);
        return undefined;
      }
      const tree = untarPackage(archive);
      const paths: string[] = [];
      for (const [path, data] of tree) {
        const full = `${dir}/${path}`;
        this.files.set(full, data);
        paths.push(full);
      }
      this.pathsByKey.set(key, paths);
      this.dirs.set(key, dir);
      if (project) project.data = null;
      return dir;
    } catch (err) {
      console.warn(`[tinymist] could not load package ${key}`, err);
      this.failed.add(key);
      return undefined;
    }
  }

  /** The contents behind a `file://` URI tinymist asked for, if ours. */
  file(uri: string): Uint8Array | undefined {
    let path: string;
    try {
      // tinymist builds URIs from paths with its own escaping rules, so
      // compare decoded paths instead of reproducing them.
      path = decodeURIComponent(new URL(uri).pathname);
    } catch {
      return undefined;
    }
    return this.files.get(path);
  }

  private drop(key: string): void {
    for (const path of this.pathsByKey.get(key) ?? []) this.files.delete(path);
    this.pathsByKey.delete(key);
    this.dirs.delete(key);
    this.failed.delete(key);
  }
}

/**
 * Bytes of a response read as text with the x-user-defined charset, which
 * maps every byte to one char. Synchronous XHR may not ask for an
 * arraybuffer, so this is how the archive comes out of one.
 */
export function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
