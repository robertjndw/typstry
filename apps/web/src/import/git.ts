import { toError } from "@/lib/errors";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  RELOAD_MESSAGE,
} from "@/sync/protocol";

import {
  collect,
  ImportError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  segmentsOf,
  tooManyEntries,
  type ImportSource,
} from "./import";
import { createMemFs, type MemFs } from "./memfs";
import { isJunk, mb } from "./unzip-limits";

/** Where a project comes from: a repository, a ref in it, a folder in that. */
export interface GitSpec {
  url: string;
  /** Branch or tag; the repository's default branch when empty. */
  ref?: string;
  /** Folder to take instead of the whole repository. */
  path?: string;
}

/** Same-origin relay of the server; Git hosts send no CORS headers. */
const CORS_PROXY = "/api/git";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Turns what people paste into a clone URL plus the ref and folder it points
 * at. Understands the browser URLs of GitHub and Gitea (`/tree/<ref>/<path>`,
 * `/blob/...`) and GitLab (`/-/tree/<ref>/<path>`), as well as plain clone
 * URLs. A ref containing slashes cannot be told from a folder, so the first
 * segment is the ref; the "Branch or tag" and "Folder" fields are for those.
 */
export function parseGitUrl(
  input: string,
): Required<Pick<GitSpec, "url">> & Pick<GitSpec, "ref" | "path"> {
  const raw = input.trim();
  if (!raw) throw new ImportError("Enter the address of a Git repository");
  if (SCHEME.test(raw) && !/^https:\/\//i.test(raw)) {
    throw new ImportError("Only https:// repositories can be imported");
  }
  let url: URL;
  try {
    url = new URL(SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ImportError("That is not a valid repository address");
  }
  const segments = url.pathname.split("/").filter((s) => s !== "");

  // GitLab marks the browser part with "-", which also allows nested groups.
  // Elsewhere the repository is exactly owner/name, so "tree" can be a name.
  const dash = segments.indexOf("-");
  const marker =
    dash >= 0 && ["tree", "blob"].includes(segments[dash + 1] ?? "")
      ? dash + 1
      : segments.findIndex((s, i) => i >= 2 && (s === "tree" || s === "blob"));

  let repo =
    marker >= 0 ? segments.slice(0, dash >= 0 ? dash : marker) : segments;
  let ref: string | undefined;
  let path: string | undefined;
  if (marker >= 0) {
    ref = segments[marker + 1];
    let rest = segments.slice(marker + 2);
    // A link to a file stands for the folder it sits in.
    if (segments[marker] === "blob") rest = rest.slice(0, -1);
    path = rest.length > 0 ? rest.map(decodeURIComponent).join("/") : undefined;
    if (ref) ref = decodeURIComponent(ref);
  }
  if (repo.length < 2) {
    throw new ImportError("That does not look like a repository address");
  }
  repo = [...repo.slice(0, -1), repo.at(-1)!.replace(/\.git$/i, "")];
  return {
    // Every host accepts the .git form of the smart HTTP endpoints.
    url: `https://${url.host}/${repo.join("/")}.git`,
    ref,
    path,
  };
}

/** The hooks readGit runs against; tests swap them for local ones. */
export interface GitDeps {
  fs?: MemFs;
  http?: unknown;
  corsProxy?: string;
}

/** What listRefs found on the remote, without downloading any objects. */
export interface RemoteRefs {
  /** Normalized clone URL, as parseGitUrl returns it. */
  url: string;
  /** Branch HEAD points at; null if the server does not say. */
  defaultBranch: string | null;
  /** Short names ("main", "feature/x"), default branch first, then alphabetical. */
  branches: string[];
  /** Short names, newest version first (v10 before v9). */
  tags: string[];
}

/** One folder of a fetched repository. */
export interface GitFolder {
  /** "" for the repository root, else "a/b" without slashes at the ends. */
  path: string;
  /** Files anywhere below it, after junk filtering, symlinks/submodules excluded. */
  files: number;
  /** Holds a .typ file directly inside. */
  typst: boolean;
  /** Holds a typst.toml directly inside (a Typst package or template). */
  manifest: boolean;
}

export interface GitSnapshot {
  url: string;
  /** The ref as asked for; undefined means the default branch. */
  ref: string | undefined;
  /** Every folder, root first, then depth-first in path order. */
  folders: GitFolder[];
  /** The files under `path` ("" = whole repository), without a second fetch. */
  read(path: string): Promise<ImportSource>;
}

/** Keeps a repository with a huge tree from flooding the folder picker. */
const MAX_FOLDERS = 5000;

/** The last path segment of a clone URL, without ".git". */
export function repoName(url: string): string {
  return url
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .at(-1)!;
}

/** isomorphic-git, its HTTP client, and the Buffer global it relies on. */
async function loadGit(deps: GitDeps) {
  // The trailing slash picks the npm package; bare "buffer" resolves to the
  // bundler's empty browser stub.
  const [{ Buffer }, { default: git }, http] = await Promise.all([
    import("buffer/"),
    import("isomorphic-git"),
    deps.http ?? loadHttp(),
  ]);
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
  return { git, http: http as never };
}

/** Lists branches and tags with one info/refs request; no objects are downloaded. */
export async function listRefs(
  input: string,
  deps: GitDeps = {},
): Promise<RemoteRefs> {
  const { url } = parseGitUrl(input);
  const { git, http } = await loadGit(deps);
  let refs: { ref: string; target?: string }[];
  try {
    // Protocol v1 answers with the whole listing in the GET itself, where v2
    // would need a second round trip for ls-refs.
    refs = await git.listServerRefs({
      http,
      url,
      corsProxy: deps.corsProxy ?? CORS_PROXY,
      protocolVersion: 1,
      symrefs: true,
    });
  } catch (err) {
    throw fetchError(err, undefined);
  }

  const short = (prefix: string) =>
    refs
      .filter((r) => r.ref.startsWith(prefix))
      .map((r) => r.ref.slice(prefix.length));
  const head = refs.find((r) => r.ref === "HEAD")?.target;
  const defaultBranch = head?.startsWith("refs/heads/")
    ? head.slice("refs/heads/".length)
    : null;
  const branches = short("refs/heads/").sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (branches.length === 0) {
    throw new ImportError("The repository has no branches");
  }
  if (defaultBranch && branches.includes(defaultBranch)) {
    branches.splice(branches.indexOf(defaultBranch), 1);
    branches.unshift(defaultBranch);
  }
  // Numeric collation puts v10 above v9, so the newest release comes first.
  const tags = short("refs/tags/").sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  return { url, defaultBranch, branches, tags };
}

/**
 * One shallow, single-ref fetch into memory. Folders are listed from the tree
 * objects alone; blobs are only read when `read` is called.
 */
export async function fetchSnapshot(
  input: string,
  ref: string | undefined,
  onProgress?: (phase: string) => void,
  deps: GitDeps = {},
): Promise<GitSnapshot> {
  const { url } = parseGitUrl(input);
  const { git, http } = await loadGit(deps);
  const fs = deps.fs ?? createMemFs();
  const dir = "/";

  let head: string | null;
  try {
    await git.init({ fs, dir });
    // fetch updates the remote-tracking refs, which need the remote's config.
    await git.addRemote({ fs, dir, remote: "origin", url });
    ({ fetchHead: head } = await git.fetch({
      fs,
      http,
      dir,
      url,
      corsProxy: deps.corsProxy ?? CORS_PROXY,
      ref,
      singleBranch: true,
      depth: 1,
      tags: false,
      onProgress: onProgress && ((p) => onProgress(describe(p))),
    }));
  } catch (err) {
    throw fetchError(err, ref);
  }

  if (!head) throw new ImportError("The repository is empty");
  const oid = head;

  const folders: GitFolder[] = [];
  async function list(treeOid: string, at: string): Promise<GitFolder> {
    const folder: GitFolder = {
      path: at,
      files: 0,
      typst: false,
      manifest: false,
    };
    if (folders.length < MAX_FOLDERS) folders.push(folder);
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });
    // Git sorts directories as if they ended in a slash; the picker wants
    // plain path order.
    const entries = [...tree].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const entry of entries) {
      const child = at ? `${at}/${entry.path}` : entry.path;
      if (isJunk(child.split("/"))) continue;
      if (entry.type === "tree") {
        folder.files += (await list(entry.oid, child)).files;
      } else if (entry.type === "blob" && entry.mode !== "120000") {
        folder.files++;
        if (entry.path.toLowerCase().endsWith(".typ")) folder.typst = true;
        if (entry.path === "typst.toml") folder.manifest = true;
      }
    }
    return folder;
  }
  try {
    onProgress?.("Listing folders");
    const root = await git.readTree({ fs, dir, oid });
    await list(root.oid, "");
  } catch (err) {
    throw new ImportError(
      "Could not read the files of the repository",
      [],
      toError(err),
    );
  }

  async function read(input: string): Promise<ImportSource> {
    const path = segmentsOf(input).join("/");
    onProgress?.("Reading files");
    const raw: { path: string; bytes: Uint8Array }[] = [];
    const skipped: string[] = [];
    let bytes = 0;
    try {
      const root = await git.readTree({
        fs,
        dir,
        oid,
        filepath: path || undefined,
      });
      const trees = [{ at: path, entries: root.tree }];
      for (let tree = trees.pop(); tree; tree = trees.pop()) {
        for (const entry of tree.entries) {
          const at = tree.at ? `${tree.at}/${entry.path}` : entry.path;
          const shown = at.slice(path ? path.length + 1 : 0);
          if (isJunk(shown.split("/"))) continue;
          if (entry.type === "tree") {
            const sub = await git.readTree({ fs, dir, oid: entry.oid });
            trees.push({ at, entries: sub.tree });
            continue;
          }
          // Links point outside the project and submodules are other repos.
          if (entry.type === "commit" || entry.mode === "120000") {
            skipped.push(shown);
            continue;
          }
          if (raw.length >= MAX_IMPORT_ENTRIES) throw tooManyEntries();
          const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
          bytes += blob.length;
          if (bytes > MAX_IMPORT_BYTES) {
            throw new ImportError(
              `The files add up to more than ${mb(MAX_IMPORT_BYTES)} MB`,
            );
          }
          raw.push({ path: shown, bytes: new Uint8Array(blob) });
        }
      }
    } catch (err) {
      if (err instanceof ImportError) throw err;
      if (path && isMissing(err)) {
        throw new ImportError(`The folder "${path}" is not in the repository`);
      }
      throw new ImportError(
        "Could not read the files of the repository",
        [],
        toError(err),
      );
    }

    // The tree has no wrapping folder to strip, unlike a zip of a folder.
    const name = path ? path.split("/").at(-1)! : repoName(url);
    const source = collect(name, raw, { unwrap: false });
    source.skipped = [...source.skipped, ...skipped].sort();
    return source;
  }

  return { url, ref, folders, read };
}

/**
 * Fetches one shallow, single-ref snapshot of a public repository into
 * memory and returns the files under `spec.path`. Nothing is checked out:
 * the tree is read straight from the objects. Form fields in `spec` win over
 * what the URL itself says.
 */
export async function readGit(
  spec: GitSpec,
  onProgress?: (phase: string) => void,
  deps: GitDeps = {},
): Promise<ImportSource> {
  const parsed = parseGitUrl(spec.url);
  const ref = spec.ref?.trim() || parsed.ref;
  const path = spec.path?.trim() || parsed.path || "";
  const snapshot = await fetchSnapshot(parsed.url, ref, onProgress, deps);
  return snapshot.read(path);
}

/** The browser client, declaring the protocol version like apiFetch does. */
async function loadHttp(): Promise<unknown> {
  const { default: web } = await import("isomorphic-git/http/web");
  return {
    request: (req: Parameters<typeof web.request>[0]) =>
      web.request({
        ...req,
        headers: {
          ...req.headers,
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
      }),
  };
}

function describe(p: { phase: string; loaded: number; total?: number }) {
  return p.total
    ? `${p.phase} ${Math.floor((p.loaded / p.total) * 100)}%`
    : p.phase;
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "NotFoundError" || code === "ObjectTypeError";
}

/** What the relay's statuses mean for the person importing. */
const HTTP_MESSAGES: Record<number, string> = {
  400: "That is not a repository address the server can fetch",
  401: "That repository is not public",
  403: "This server does not allow importing from that host",
  404: "The repository was not found, or it is not public",
  413: "The repository is too large to import",
  426: RELOAD_MESSAGE,
  502: "The Git host could not be reached",
  504: "The Git host took too long to respond",
};

function fetchError(err: unknown, ref: string | undefined): ImportError {
  const e = err as { code?: string; data?: { statusCode?: number } };
  if (err instanceof ImportError) return err;
  if (e?.code === "HttpError") {
    const status = e.data?.statusCode ?? 0;
    return new ImportError(
      HTTP_MESSAGES[status] ??
        `The Git host answered with an error (${status})`,
      [],
      toError(err),
    );
  }
  if (e?.code === "NotFoundError" && ref) {
    return new ImportError(
      `The branch or tag "${ref}" was not found in the repository`,
      [],
      toError(err),
    );
  }
  if (err instanceof TypeError) {
    // The relay can only cut the connection once a response turns out too
    // large, so a broken fetch is not always the network's fault.
    return new ImportError(
      "The download broke off. The connection dropped, or the repository is too large",
      [],
      err,
    );
  }
  return new ImportError(
    "That address did not return a Git repository",
    [],
    toError(err),
  );
}
