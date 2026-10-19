import { ownBuffer } from "@/crypto/bytes";

/** Left behind only if a probe crashed; the scanner ignores these. */
export const CASE_PROBE_PREFIX = ".typstry-case-probe-";

export interface FileStat {
  size: number;
  /** Milliseconds since the epoch, as `File.lastModified`. */
  mtime: number;
}

export interface FolderEntry {
  /** Relative to the folder, "/" separated, no leading slash. */
  path: string;
  name: string;
  kind: "file" | "dir";
  /** Files only. Cheaper than `FolderFs.stat`, which walks from the root. */
  stat?: () => Promise<FileStat>;
}

/**
 * The folder as the sync engine sees it. Paths are relative with "/"
 * separators. Kept narrow so tests can swap the browser's handles for a
 * fake.
 */
export interface FolderFs {
  /** The direct children of `dir` ("" is the root), in no set order. */
  readdir(dir: string): Promise<FolderEntry[]>;
  /** Null when there is no such file. */
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Uint8Array>;
  /** Creates missing parent folders. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  /**
   * Removes a file or a folder with everything in it, then the parents that
   * are left empty, never the root. A missing path is not an error.
   */
  remove(path: string): Promise<void>;
  /** Whether names that differ only in case are the same file here. */
  caseInsensitive(): Promise<boolean>;
}

function isMissing(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "NotFoundError" || e.name === "TypeMismatchError")
  );
}

async function isEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const _name of dir.keys()) {
    void _name;
    return false;
  }
  return true;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

export function handleFs(root: FileSystemDirectoryHandle): FolderFs {
  async function dirAt(
    segments: string[],
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }

  async function fileAt(path: string): Promise<FileSystemFileHandle> {
    const segments = segmentsOf(path);
    const name = segments.pop();
    if (name === undefined) throw new TypeError("Empty path");
    return (await dirAt(segments)).getFileHandle(name);
  }

  async function readdir(dir: string): Promise<FolderEntry[]> {
    const handle = await dirAt(segmentsOf(dir));
    const prefix = dir === "" ? "" : `${dir}/`;
    const out: FolderEntry[] = [];
    for await (const [name, child] of handle.entries()) {
      if (child.kind === "directory") {
        out.push({ path: prefix + name, name, kind: "dir" });
      } else {
        const file = child as FileSystemFileHandle;
        out.push({
          path: prefix + name,
          name,
          kind: "file",
          stat: async () => {
            const f = await file.getFile();
            return { size: f.size, mtime: f.lastModified };
          },
        });
      }
    }
    return out;
  }

  let caseProbe: Promise<boolean> | undefined;
  async function probeCase(): Promise<boolean> {
    const name = `${CASE_PROBE_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
    try {
      await root.getFileHandle(name, { create: true });
      try {
        await root.getFileHandle(name.toUpperCase());
        return true;
      } catch (e) {
        if (isMissing(e)) return false;
        throw e;
      } finally {
        await root.removeEntry(name).catch(() => {});
      }
    } catch {
      // A read-only or flaky folder cannot be probed; guess from the
      // platform, whose default file systems fold case.
      return /Mac|Windows/i.test(navigator.userAgent);
    }
  }

  return {
    readdir,

    async stat(path) {
      try {
        const f = await (await fileAt(path)).getFile();
        return { size: f.size, mtime: f.lastModified };
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },

    async read(path) {
      const f = await (await fileAt(path)).getFile();
      return new Uint8Array(await f.arrayBuffer());
    },

    async write(path, bytes) {
      const segments = segmentsOf(path);
      const name = segments.pop();
      if (name === undefined) throw new TypeError("Empty path");
      const dir = await dirAt(segments, true);
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(ownBuffer(bytes));
        await writable.close();
      } catch (e) {
        // Chromium writes to a swap file until close, so aborting leaves
        // the original untouched.
        await writable.abort().catch(() => {});
        throw e;
      }
    },

    async mkdir(path) {
      await dirAt(segmentsOf(path), true);
    },

    async remove(path) {
      const segments = segmentsOf(path);
      while (segments.length > 0) {
        const name = segments.pop()!;
        let parent: FileSystemDirectoryHandle;
        try {
          parent = await dirAt(segments);
          await parent.removeEntry(name, { recursive: true });
        } catch (e) {
          if (isMissing(e)) return;
          throw e;
        }
        // Stop at the first parent that still holds something.
        if (!(await isEmpty(parent))) return;
      }
    },

    caseInsensitive() {
      return (caseProbe ??= probeCase());
    },
  };
}
