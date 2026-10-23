/**
 * The smallest in-memory file system isomorphic-git can fetch into: it
 * needs somewhere to put the pack and the repo config, and nothing is ever
 * checked out. Paths are absolute and "/"-separated.
 */
export interface MemFs {
  promises: {
    readFile(path: string, opts?: unknown): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<Stat>;
    lstat(path: string): Promise<Stat>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
}

interface Stat {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export function createMemFs(): MemFs {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  let inode = 0;
  const inodes = new Map<string, number>();

  const norm = (path: string) => {
    const parts = path.split("/").filter((s) => s !== "" && s !== ".");
    return "/" + parts.join("/");
  };
  const parentOf = (path: string) =>
    path.slice(0, path.lastIndexOf("/")) || "/";
  const encoder = new TextEncoder();

  const stat = async (raw: string): Promise<Stat> => {
    const path = norm(raw);
    const isDir = dirs.has(path);
    const data = files.get(path);
    if (!isDir && !data) throw fsError("ENOENT", path);
    if (!inodes.has(path)) inodes.set(path, ++inode);
    return {
      type: isDir ? "dir" : "file",
      mode: isDir ? 0o40000 : 0o100644,
      size: data?.length ?? 0,
      ino: inodes.get(path)!,
      mtimeMs: 0,
      ctimeMs: 0,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    };
  };

  return {
    promises: {
      async readFile(raw, opts) {
        const path = norm(raw);
        const data = files.get(path);
        if (!data) throw fsError("ENOENT", path);
        const encoding = typeof opts === "string" ? opts : undefined;
        const asked =
          encoding ?? (opts as { encoding?: string } | undefined)?.encoding;
        return asked ? new TextDecoder().decode(data) : data;
      },
      async writeFile(raw, data) {
        const path = norm(raw);
        if (!dirs.has(parentOf(path))) throw fsError("ENOENT", path);
        files.set(path, typeof data === "string" ? encoder.encode(data) : data);
      },
      async unlink(raw) {
        const path = norm(raw);
        if (!files.delete(path)) throw fsError("ENOENT", path);
      },
      async readdir(raw) {
        const path = norm(raw);
        if (!dirs.has(path)) throw fsError("ENOENT", path);
        const prefix = path === "/" ? "/" : path + "/";
        const names = new Set<string>();
        for (const key of [...files.keys(), ...dirs]) {
          if (key !== path && key.startsWith(prefix))
            names.add(key.slice(prefix.length).split("/")[0]!);
        }
        return [...names];
      },
      async mkdir(raw) {
        const path = norm(raw);
        if (dirs.has(path) || files.has(path)) throw fsError("EEXIST", path);
        if (!dirs.has(parentOf(path))) throw fsError("ENOENT", path);
        dirs.add(path);
      },
      async rmdir(raw) {
        const path = norm(raw);
        if (!dirs.has(path)) throw fsError("ENOENT", path);
        const prefix = path + "/";
        const used = [...files.keys(), ...dirs].some((k) =>
          k.startsWith(prefix),
        );
        if (used) throw fsError("ENOTEMPTY", path);
        dirs.delete(path);
      },
      stat,
      // No symlinks are ever created, so both behave the same.
      lstat: stat,
      async readlink(raw) {
        throw fsError("ENOENT", norm(raw));
      },
      async symlink(_target, raw) {
        throw fsError("ENOSYS", norm(raw));
      },
    },
  };
}
