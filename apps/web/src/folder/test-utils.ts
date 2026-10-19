import { vi } from "vitest";

import type { ProjectAssets } from "@/assets/project-assets";

/** Controls `lastModified` of fake files, so tests never sleep. */
export class FakeClock {
  time: number;
  constructor(time = 1_700_000_000_000) {
    this.time = time;
  }
  now(): number {
    return this.time;
  }
  advance(ms = 1000): void {
    this.time += ms;
  }
}

export interface FakeFolderOptions {
  /** Names that differ only in case are one entry, as on macOS. */
  caseInsensitive?: boolean;
  /** What `queryPermission` answers. */
  permission?: PermissionState;
  /** What `requestPermission` turns a "prompt" into. */
  grantOnRequest?: PermissionState;
  clock?: FakeClock;
}

interface Env {
  clock: FakeClock;
  caseInsensitive: boolean;
  permission: PermissionState;
  grantOnRequest: PermissionState;
}

const domError = (name: string, message = name) =>
  new DOMException(message, name);

abstract class FakeHandle {
  protected readonly env: Env;
  name: string;
  constructor(env: Env, name: string) {
    this.env = env;
    this.name = name;
  }
  abstract readonly kind: "file" | "directory";

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (other as unknown) === this;
  }
  async queryPermission(): Promise<PermissionState> {
    return this.env.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    if (this.env.permission === "prompt") {
      this.env.permission = this.env.grantOnRequest;
    }
    return this.env.permission;
  }
}

class FakeFileHandle extends FakeHandle {
  readonly kind = "file" as const;
  data = new Uint8Array(0);
  mtime: number;

  constructor(env: Env, name: string) {
    super(env, name);
    this.mtime = env.clock.now();
  }

  async getFile(): Promise<File> {
    return new File([this.data as Uint8Array<ArrayBuffer>], this.name, {
      lastModified: this.mtime,
    });
  }

  async createWritable() {
    const chunks: Uint8Array[] = [];
    let done = false;
    return {
      write: async (data: Uint8Array | Blob | string) => {
        if (done) throw domError("InvalidStateError");
        chunks.push(
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : new Uint8Array(data),
        );
      },
      // Like the browser's swap file: nothing changes until close.
      close: async () => {
        done = true;
        const size = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        this.data = out;
        this.mtime = this.env.clock.now();
      },
      abort: async () => {
        done = true;
      },
    };
  }
}

class FakeDirHandle extends FakeHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, FakeFileHandle | FakeDirHandle>();

  private key(name: string): string {
    return this.env.caseInsensitive ? name.toLowerCase() : name;
  }

  async getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    const hit = this.children.get(this.key(name));
    if (hit) {
      if (hit.kind !== "directory") throw domError("TypeMismatchError");
      return hit as unknown as FileSystemDirectoryHandle;
    }
    if (!opts?.create) throw domError("NotFoundError");
    const dir = new FakeDirHandle(this.env, name);
    this.children.set(this.key(name), dir);
    return dir as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FileSystemFileHandle> {
    const hit = this.children.get(this.key(name));
    if (hit) {
      if (hit.kind !== "file") throw domError("TypeMismatchError");
      return hit as unknown as FileSystemFileHandle;
    }
    if (!opts?.create) throw domError("NotFoundError");
    const file = new FakeFileHandle(this.env, name);
    this.children.set(this.key(name), file);
    return file as unknown as FileSystemFileHandle;
  }

  async removeEntry(
    name: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const hit = this.children.get(this.key(name));
    if (!hit) throw domError("NotFoundError");
    if (hit.kind === "directory" && !opts?.recursive) {
      if ((hit as FakeDirHandle).children.size > 0) {
        throw domError("InvalidModificationError");
      }
    }
    this.children.delete(this.key(name));
  }

  async *entries(): AsyncGenerator<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  > {
    for (const child of [...this.children.values()]) {
      yield [
        child.name,
        child as unknown as FileSystemDirectoryHandle | FileSystemFileHandle,
      ];
    }
  }
  async *keys(): AsyncGenerator<string> {
    for await (const [name] of this.entries()) yield name;
  }
  async *values() {
    for await (const [, handle] of this.entries()) yield handle;
  }
  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

/** An in-memory folder for `handleFs`, plus ways to edit it from outside. */
export interface FakeFolder {
  handle: FileSystemDirectoryHandle;
  clock: FakeClock;
  /** What another program does: replace or create a file, bumping mtime. */
  set(path: string, content: string | Uint8Array): void;
  /** Creates an empty folder (and its parents). */
  mkdir(path: string): void;
  /** Deletes a file or folder without tidying parents. */
  delete(path: string): void;
  /** The file's bytes, or undefined when it does not exist. */
  bytes(path: string): Uint8Array | undefined;
  /** The file's text, or undefined when it does not exist. */
  text(path: string): string | undefined;
  /** Every file path, sorted. */
  files(): string[];
  /** Every folder path, sorted. */
  dirs(): string[];
  setPermission(state: PermissionState): void;
}

export function fakeFolder(
  files: Record<string, string | Uint8Array> = {},
  opts: FakeFolderOptions = {},
): FakeFolder {
  const env: Env = {
    clock: opts.clock ?? new FakeClock(),
    caseInsensitive: opts.caseInsensitive ?? false,
    permission: opts.permission ?? "granted",
    grantOnRequest: opts.grantOnRequest ?? "granted",
  };
  const root = new FakeDirHandle(env, "root");

  function dirAt(path: string[], create: boolean): FakeDirHandle | undefined {
    let dir = root;
    for (const name of path) {
      let next = dir.children.get(
        env.caseInsensitive ? name.toLowerCase() : name,
      );
      if (!next && create) {
        next = new FakeDirHandle(env, name);
        dir.children.set(env.caseInsensitive ? name.toLowerCase() : name, next);
      }
      if (next?.kind !== "directory") return undefined;
      dir = next as FakeDirHandle;
    }
    return dir;
  }

  function lookup(path: string): FakeFileHandle | FakeDirHandle | undefined {
    const segments = path.split("/");
    const name = segments.pop()!;
    return dirAt(segments, false)?.children.get(
      env.caseInsensitive ? name.toLowerCase() : name,
    );
  }

  function set(path: string, content: string | Uint8Array) {
    const segments = path.split("/");
    const name = segments.pop()!;
    const dir = dirAt(segments, true)!;
    const key = env.caseInsensitive ? name.toLowerCase() : name;
    let file = dir.children.get(key);
    if (!file) {
      file = new FakeFileHandle(env, name);
      dir.children.set(key, file);
    }
    if (file.kind !== "file") throw new Error(`${path} is a folder`);
    (file as FakeFileHandle).data =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content);
    (file as FakeFileHandle).mtime = env.clock.now();
  }

  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) dirAt(path.slice(0, -1).split("/"), true);
    else set(path, content);
  }

  function walk(
    dir: FakeDirHandle,
    prefix: string,
    out: { files: string[]; dirs: string[] },
  ) {
    for (const child of dir.children.values()) {
      const path = prefix + child.name;
      if (child.kind === "directory") {
        out.dirs.push(path);
        walk(child as FakeDirHandle, `${path}/`, out);
      } else {
        out.files.push(path);
      }
    }
  }
  const all = () => {
    const out = { files: [] as string[], dirs: [] as string[] };
    walk(root, "", out);
    return out;
  };

  return {
    handle: root as unknown as FileSystemDirectoryHandle,
    clock: env.clock,
    set,
    mkdir: (path) => void dirAt(path.split("/"), true),
    delete(path) {
      const segments = path.split("/");
      const name = segments.pop()!;
      dirAt(segments, false)?.children.delete(
        env.caseInsensitive ? name.toLowerCase() : name,
      );
    },
    bytes(path) {
      const hit = lookup(path);
      return hit?.kind === "file" ? (hit as FakeFileHandle).data : undefined;
    },
    text(path) {
      const bytes = this.bytes(path);
      return bytes && new TextDecoder().decode(bytes);
    },
    files: () => all().files.sort(),
    dirs: () => all().dirs.sort(),
    setPermission: (state) => {
      env.permission = state;
    },
  };
}

export function fakeAssets(): ProjectAssets & {
  blobs: Map<string, Uint8Array>;
} {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    load: async (hash) => blobs.get(hash)!,
    store: vi.fn(async (f: File) => {
      const hash = `sha256:${f.name}`;
      blobs.set(hash, new Uint8Array(await f.arrayBuffer()));
      return { hash, size: f.size, mime: "image/png" };
    }),
  };
}
