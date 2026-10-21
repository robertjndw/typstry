import type {
  PackageRegistry,
  PackageResolveContext,
  PackageSpec,
} from "@myriaddreamin/typst.ts/internal.types";
import type { MemoryAccessModel } from "@myriaddreamin/typst.ts/fs/memory";

import { packageKey } from "@/packages/spec";
import { normalizeArchivePath } from "@/packages/tar";

const ROOT = "/@memory/project-packages";

interface Entry {
  hash: string;
  /** The stored .tar.gz; dropped once unpacked, since the files replace it. */
  archive: Uint8Array | null;
  /** Where the package was unpacked, or null while it has not been. */
  dir: string | null;
  paths: string[];
}

/**
 * Serves the project's own packages (@local ones, and @preview pins that
 * override the network), and leaves everything else to `fallback`.
 *
 * Typst calls resolve() synchronously from inside the compile, so packages
 * must already be here as bytes; unpacking is deferred to the first import
 * because most packages in a project are never imported at once.
 */
export class ProjectPackageRegistry implements PackageRegistry {
  private readonly entries = new Map<string, Entry>();
  /**
   * Packages the compiler has asked about, found or not. Typst keeps the
   * answer for the life of the compiler, reset() included, so changing one
   * of these needs a new compiler; anything else is picked up on first use.
   */
  private readonly looked = new Set<string>();
  private readonly am: Pick<MemoryAccessModel, "insertFile" | "removeFile">;
  private readonly fallback: PackageRegistry;

  constructor(
    am: Pick<MemoryAccessModel, "insertFile" | "removeFile">,
    fallback: PackageRegistry,
  ) {
    this.am = am;
    this.fallback = fallback;
  }

  /**
   * `key` is the doc's "namespace/name/version". Returns true when the
   * running compiler may have cached an older answer for it.
   */
  set(key: string, hash: string, data: Uint8Array): boolean {
    this.remove(key);
    this.entries.set(key, { hash, archive: data, dir: null, paths: [] });
    return this.looked.has(key);
  }

  /** Like set(), true when the running compiler may still know the package. */
  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      for (const path of entry.paths) this.am.removeFile(path);
    }
    return this.looked.has(key);
  }

  /** Call when the compiler is replaced: the new one has asked about nothing. */
  forgetLookups(): void {
    this.looked.clear();
  }

  resolve(spec: PackageSpec, ctx: PackageResolveContext): string | undefined {
    const key = packageKey(spec);
    this.looked.add(key);
    const entry = this.entries.get(key);
    if (!entry) return this.fallback.resolve(spec, ctx);
    return entry.dir ?? this.unpack(key, entry, ctx);
  }

  private unpack(
    key: string,
    entry: Entry,
    ctx: PackageResolveContext,
  ): string | undefined {
    // The hash in the path keeps a replaced package from ever sharing a
    // directory with its predecessor: Typst may hold on to files it read
    // from the old one.
    const dir = `${ROOT}/${key}/${entry.hash.slice(0, 16)}`;
    const inserted: string[] = [];
    try {
      ctx.untar(entry.archive!, (raw, data, mtime) => {
        const path = normalizeArchivePath(raw);
        // The archive was validated on upload, but synced documents are
        // not trusted: an entry must never land outside its own directory.
        if (!path) return;
        const full = `${dir}/${path}`;
        this.am.insertFile(full, data, new Date(mtime));
        inserted.push(full);
      });
    } catch (err) {
      console.error(`failed to unpack package ${key}`, err);
      for (const path of inserted) this.am.removeFile(path);
      return undefined;
    }
    entry.dir = dir;
    entry.paths = inserted;
    entry.archive = null;
    return dir;
  }
}
