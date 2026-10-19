// One sync cycle between the linked folder and the doc, a port of the CLI's
// reconcile (crates/typstry-cli/src/engine/reconcile.rs). Compares each side
// with the base (base.ts), applies changes across, merges text both sides
// edited and reports what it couldn't decide. Everything that reaches the doc
// is one local commit, so the normal sync pushes it like any edit.
import type { OpId } from "loro-crdt";

import { MAX_ASSET_BYTES, type ProjectAssets } from "@/assets/project-assets";
import { basename } from "@/doc/names";
import type { ProjectDoc } from "@/doc/schema";
import { mapConcurrent } from "@/lib/concurrent";

import {
  applyChanges,
  type ApplyReport,
  type Change,
  type SkipReason,
} from "./apply";
import { trustedBase, type BaseFile, type FolderBase } from "./base";
import { asText, digest, mimeForPath } from "./classify";
import { caseClashes } from "./case-clashes";
import type { FileStat, FolderFs } from "./folder-fs";
import {
  materialize,
  materializeDirs,
  type MaterializedFile,
} from "./materialize";
import { mergeText, mergeTexts } from "./merge";
import { FOLDER_ORIGIN } from "./origin";
import { scanFolder, type ScanResult } from "./scan";

/** What a first link does with files that differ between folder and project. */
export type FirstLinkMode = "folder-wins" | "project-wins";

export interface ReconcileInput {
  project: ProjectDoc;
  fs: FolderFs;
  assets: ProjectAssets;
  /** What the last cycle left behind; checked against the doc here again. */
  base: FolderBase | null;
  /** False for a view-only link: the doc is never written. */
  canWrite: boolean;
  signal?: AbortSignal;
  /** Only used while there is no base. */
  mode?: FirstLinkMode;
  /** Binary uploads that settled, out of those this cycle needs. */
  onProgress?: (done: number, total: number) => void;
}

export interface Conflict {
  path: string;
  reason: string;
}

export interface ReconcileReport {
  conflicts: Conflict[];
  skipped: { path: string; reason: string }[];
  warnings: string[];
  written: string[];
  deleted: string[];
  merged: string[];
  applied: ApplyReport | null;
  heldLocal: string[];
}

export interface ReconcileResult {
  base: FolderBase;
  report: ReconcileReport;
  /**
   * A failure that stopped the write-back after the doc was committed, such
   * as lost permission. The base is complete anyway and must be kept.
   */
  interrupted?: unknown;
}

export interface FirstLinkPreview {
  onlyFolder: number;
  onlyProject: number;
  differing: string[];
}

const CONCURRENCY = 4;
const COMMIT_MESSAGE = "folder sync";
/** A remote edit landing mid-cycle makes it start over; this many times. */
const MAX_ATTEMPTS = 4;

const encoder = new TextEncoder();

interface LocalFile {
  stat: FileStat;
  bytes: Uint8Array;
  digest: string;
  /** Null when the bytes cannot be a text node. */
  text: string | null;
}

type LocalChange =
  { kind: "added" | "modified"; file: LocalFile } | { kind: "deleted" };

type RemoteChange =
  { kind: "added" | "modified"; file: MaterializedFile } | { kind: "deleted" };

interface AssetInfo {
  hash: string;
  size: number;
  mime: string;
}

type ToDoc =
  | { kind: "delete" }
  | { kind: "text"; text: string }
  | { kind: "asset"; file: LocalFile };

type DiskContent =
  | { kind: "text"; text: string }
  | { kind: "asset"; hash: string; size: number; mime: string };

interface DiskWrite {
  content: DiskContent;
  /** What the scan saw there; null for a path that was not on disk. */
  expect: FileStat | null;
}

/** What a path's base entry becomes once the cycle is through. */
type Outcome =
  | { t: "keep" }
  | { t: "gone" }
  /** The doc takes (or already has) the local file's content. */
  | { t: "local"; file: LocalFile; kind: "text" | "asset"; info?: AssetInfo }
  /** The folder takes the doc's content, see `DiskWrite`. */
  | { t: "disk" };

interface Merge {
  file: LocalFile;
  remote: Extract<MaterializedFile, { kind: "text" }>;
  pin: OpId[];
  /** The disk text an earlier, unwritten merge used; the pin is moot then. */
  baseText?: string;
}

/** The doc moved between reading it and committing; the cycle starts over. */
class Stale extends Error {}

function frontierKey(frontiers: OpId[]): string {
  return frontiers
    .map((id) => `${id.peer}:${id.counter}`)
    .sort()
    .join(",");
}

export function sameFrontiers(a: OpId[], b: OpId[]): boolean {
  return frontierKey(a) === frontierKey(b);
}

function sameStat(a: FileStat, b: FileStat | null): boolean {
  return b !== null && a.size === b.size && a.mtime === b.mtime;
}

/** For a file that is unchanged on both sides: it matches the doc now. */
function withoutPin(file: BaseFile): BaseFile {
  if (!file.at && !("text" in file)) return file;
  const {
    at: _at,
    text: _text,
    ...rest
  } = file as BaseFile & {
    text?: string;
  };
  void _at;
  void _text;
  return rest as BaseFile;
}

function pinnedAt(file: BaseFile, state: OpId[] | undefined): BaseFile {
  const at = file.at ?? state;
  return at ? { ...file, at } : file;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function skipText(reason: SkipReason): string {
  return reason.kind === "invalid-name"
    ? reason.message
    : `inside the file ${reason.file}`;
}

/**
 * The one cycle. Nothing outside the folder or doc is touched before the
 * commit, so failing until then leaves both as they were. After it the cycle
 * finishes writing anyway, so folder and doc agree.
 */
export async function reconcile(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await cycle(input, false);
      return out as ReconcileResult;
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error("The project kept changing while syncing the folder", {
          cause: e,
        });
      }
    }
  }
}

/**
 * What linking this folder would do, without touching anything: how many
 * files exist on one side only and which differ. For the confirmation shown
 * before a non-empty folder is linked.
 */
export async function preview(
  input: Omit<ReconcileInput, "base" | "mode" | "canWrite">,
): Promise<FirstLinkPreview> {
  const out = await cycle(
    { ...input, base: null, canWrite: true, mode: "folder-wins" },
    true,
  );
  return out as FirstLinkPreview;
}

async function cycle(
  input: ReconcileInput,
  dry: boolean,
): Promise<ReconcileResult | FirstLinkPreview> {
  const { project, fs, assets, canWrite, signal } = input;
  const { doc } = project;
  const base = dry ? null : trustedBase(doc, input.base);
  const baseFiles = base?.files ?? {};
  const mode = base ? "folder-wins" : (input.mode ?? "folder-wins");

  const report: ReconcileReport = {
    conflicts: [],
    skipped: [],
    warnings: [],
    written: [],
    deleted: [],
    merged: [],
    applied: null,
    heldLocal: [],
  };
  const tally: FirstLinkPreview = {
    onlyFolder: 0,
    onlyProject: 0,
    differing: [],
  };

  const scan: ScanResult = await scanFolder(fs);
  signal?.throwIfAborted();
  report.skipped.push(...scan.skipped);

  // Pending editor edits have to be in the oplog before it is compared with
  // the base, or they would be mistaken for a remote change.
  doc.commit();
  const seen = doc.oplogFrontiers();
  // A pinned file, or one whose merge is still to be written, differs from
  // the doc even at equal frontiers.
  const pinned = Object.values(baseFiles).some((f) => f.at || "text" in f);
  const hasNew = [...scan.files.keys()].some((p) => !baseFiles[p]);
  // Nothing in the doc moved since the folder last matched it, so the doc
  // side needs no look at all. A path that is new on disk is checked
  // against the doc anyway, since the doc may already hold something there.
  const fast =
    base !== null && !pinned && !hasNew && sameFrontiers(seen, base.frontiers);
  const remote = fast ? null : materialize(project);

  const dropped = new Set<string>();
  if (await fs.caseInsensitive()) {
    const paths = new Set([
      ...Object.keys(baseFiles),
      ...(remote?.keys() ?? []),
      ...scan.files.keys(),
    ]);
    for (const [, path] of caseClashes(paths, (name) =>
      scan.present.has(name),
    )) {
      dropped.add(path);
    }
  }

  // Local side
  const locals = new Map<string, LocalChange>();
  const refreshed = new Map<string, BaseFile>();
  const unsynced = new Set<string>();
  const toRead: [string, FileStat][] = [];
  for (const [path, stat] of scan.files) {
    if (dropped.has(path)) continue;
    const b = baseFiles[path];
    // Same size and time as when the base was taken: not worth reading.
    if (b && b.size === stat.size && b.mtime === stat.mtime) continue;
    toRead.push([path, stat]);
  }
  await mapConcurrent(toRead, CONCURRENCY, async ([path, stat]) => {
    const bytes = await fs.read(path);
    const file: LocalFile = {
      stat,
      bytes,
      digest: await digest(bytes),
      text: asText(bytes),
    };
    const b = baseFiles[path];
    if (b && b.digest === file.digest) {
      refreshed.set(path, { ...b, size: stat.size, mtime: stat.mtime });
    } else {
      locals.set(path, { kind: b ? "modified" : "added", file });
    }
  });
  signal?.throwIfAborted();
  for (const path of Object.keys(baseFiles)) {
    if (scan.files.has(path) || dropped.has(path)) continue;
    // Still on disk, just not ours (ignored, too large, a case variant):
    // the user did not delete it, and it is never ours to delete.
    if (
      scan.present.has(path) ||
      scan.rules.classify(path, false).kind !== "sync"
    ) {
      unsynced.add(path);
    } else {
      locals.set(path, { kind: "deleted" });
    }
  }

  // Doc side
  const remoteChanges = new Map<string, RemoteChange>();
  if (remote) {
    for (const [path, file] of remote) {
      if (dropped.has(path)) {
        report.warnings.push(
          `${path} differs from another file of the project only in case, which this file system cannot tell apart; not syncing it`,
        );
        continue;
      }
      const b = baseFiles[path];
      if (!b) remoteChanges.set(path, { kind: "added", file });
      else if (await remoteDiffers(b, file)) {
        remoteChanges.set(path, { kind: "modified", file });
      }
    }
    for (const path of Object.keys(baseFiles)) {
      if (!remote.has(path) && !dropped.has(path)) {
        remoteChanges.set(path, { kind: "deleted" });
      }
    }
  }
  signal?.throwIfAborted();

  const blobDigests = new Map<string, Promise<string>>();
  const remoteDigest = (hash: string) => {
    let known = blobDigests.get(hash);
    if (!known) {
      known = assets.load(hash).then(digest);
      blobDigests.set(hash, known);
    }
    return known;
  };
  const kindOf = (
    file: LocalFile,
    existing: "text" | "asset" | undefined,
  ): "text" | "asset" =>
    // An existing asset stays one even if its bytes would decode, so an SVG
    // uploaded as an image does not turn into text.
    existing === "asset" || file.text === null ? "asset" : "text";
  const sameAsRemote = async (
    file: LocalFile,
    kind: "text" | "asset",
    r: MaterializedFile,
  ): Promise<boolean> => {
    if (r.kind === "text") return kind === "text" && file.text === r.text;
    return kind === "asset" && (await remoteDigest(r.hash)) === file.digest;
  };

  // Classification
  const outcomes = new Map<string, Outcome>();
  const toDoc = new Map<string, ToDoc>();
  const toDisk = new Map<string, DiskWrite>();
  const removals = new Map<string, FileStat>();
  const merges = new Map<string, Merge>();
  const onDisk = (path: string) => scan.files.get(path) ?? null;
  const conflict = (path: string, reason: string) =>
    report.conflicts.push({ path, reason });
  const writeDoc = (
    path: string,
    r: MaterializedFile,
    expect: FileStat | null,
  ) => {
    toDisk.set(path, {
      content:
        r.kind === "text"
          ? { kind: "text", text: r.text }
          : { kind: "asset", hash: r.hash, size: r.size, mime: r.mime },
      expect,
    });
    outcomes.set(path, { t: "disk" });
  };
  const putLocal = (
    path: string,
    file: LocalFile,
    existing?: "text" | "asset",
  ) => {
    const kind = kindOf(file, existing);
    toDoc.set(
      path,
      kind === "text" ? { kind, text: file.text! } : { kind, file },
    );
    outcomes.set(path, { t: "local", file, kind });
  };

  const paths = [
    ...new Set([...locals.keys(), ...remoteChanges.keys()]),
  ].sort();
  for (const path of paths) {
    const l = locals.get(path);
    const r = remoteChanges.get(path);
    const b = baseFiles[path];
    const existing =
      b?.kind ?? (r && r.kind !== "deleted" ? r.file.kind : undefined);

    if (l && l.kind !== "deleted" && r && r.kind !== "deleted") {
      // The remote change is already on disk: an interrupted cycle, or the
      // same edit made on both sides. Applying it again would duplicate it.
      if (await sameAsRemote(l.file, kindOf(l.file, existing), r.file)) {
        const kind = kindOf(l.file, existing);
        outcomes.set(path, {
          t: "local",
          file: l.file,
          kind,
          info:
            r.file.kind === "asset"
              ? { hash: r.file.hash, size: r.file.size, mime: r.file.mime }
              : undefined,
        });
        continue;
      }
    }

    if (l && !canWrite) {
      report.heldLocal.push(path);
      outcomes.set(path, { t: "keep" });
      if (r) {
        conflict(
          path,
          "changed in the folder and in the project; the folder change is held because this link is view-only",
        );
      }
      continue;
    }

    if (l && !r) {
      if (l.kind === "deleted") {
        toDoc.set(path, { kind: "delete" });
        outcomes.set(path, { t: "gone" });
      } else {
        if (l.kind === "added") tally.onlyFolder++;
        putLocal(path, l.file, existing);
      }
      continue;
    }

    if (!l && r) {
      if (r.kind === "deleted") {
        if (unsynced.has(path)) {
          report.warnings.push(
            `${path} was deleted in the project but is ignored or not a regular file here; not removing it`,
          );
          outcomes.set(path, { t: "keep" });
        } else {
          const there = onDisk(path);
          if (there) removals.set(path, there);
          outcomes.set(path, { t: "gone" });
        }
        continue;
      }
      if (r.kind === "added") tally.onlyProject++;
      const there = onDisk(path);
      if (
        !there &&
        (scan.present.has(path) ||
          scan.rules.classify(path, false).kind !== "sync")
      ) {
        report.warnings.push(
          `${path} changed in the project, but a file that is not synced here (ignored, too large, a symlink or the same name in other case) is in its place; not writing it`,
        );
        outcomes.set(path, { t: "keep" });
      } else {
        writeDoc(path, r.file, there);
      }
      continue;
    }

    // Changed on both sides.
    if (!l || !r) continue;
    if (l.kind === "deleted" && r.kind === "deleted") {
      outcomes.set(path, { t: "gone" });
    } else if (l.kind === "deleted" && r.kind !== "deleted") {
      conflict(
        path,
        "deleted in the folder but edited in the project; restored it",
      );
      writeDoc(path, r.file, null);
    } else if (l.kind !== "deleted" && r.kind === "deleted") {
      conflict(
        path,
        "edited in the folder but deleted in the project; restored it",
      );
      putLocal(path, l.file, existing);
    } else if (l.kind !== "deleted" && r.kind !== "deleted") {
      if (l.kind === "added") tally.differing.push(path);
      if (mode === "project-wins" && !base) {
        writeDoc(path, r.file, l.file.stat);
        continue;
      }
      const kind = kindOf(l.file, existing);
      if (
        b?.kind === "text" &&
        kind === "text" &&
        r.file.kind === "text" &&
        l.file.text !== null
      ) {
        merges.set(path, {
          file: l.file,
          remote: r.file,
          pin: b.at ?? base!.frontiers,
          baseText: b.text,
        });
        outcomes.set(path, { t: "keep" });
        continue;
      }
      conflict(
        path,
        !b
          ? "differs between the folder and the project; kept the folder version"
          : b.kind !== kind || r.file.kind !== kind
            ? "changed its type in one place and was edited in the other; kept the folder version"
            : "changed in both places; kept the folder version",
      );
      putLocal(path, l.file, existing);
    }
  }
  tally.differing.sort();

  if (dry) return tally;

  // Binaries first: the doc must never name a blob that is not uploaded.
  const known = new Map<string, AssetInfo>();
  for (const b of Object.values(baseFiles)) {
    if (b.kind === "asset" && !known.has(b.digest)) {
      known.set(b.digest, { hash: b.hash, size: b.size, mime: b.mime });
    }
  }
  const uploads = new Map<string, { path: string; file: LocalFile }>();
  for (const [path, put] of toDoc) {
    if (put.kind !== "asset") continue;
    if (put.file.bytes.length > MAX_ASSET_BYTES) {
      toDoc.delete(path);
      outcomes.delete(path);
      report.skipped.push({ path, reason: "too large to sync" });
      continue;
    }
    if (!known.has(put.file.digest) && !uploads.has(put.file.digest)) {
      uploads.set(put.file.digest, { path, file: put.file });
    }
  }
  let uploaded = 0;
  await mapConcurrent([...uploads], CONCURRENCY, async ([key, up]) => {
    const file = new File(
      [up.file.bytes as Uint8Array<ArrayBuffer>],
      basename(up.path),
      { type: mimeForPath(up.path) },
    );
    known.set(key, await assets.store(file, { signal }));
    input.onProgress?.(++uploaded, uploads.size);
  });
  signal?.throwIfAborted();

  // A merge is only safe if the file is still what we read: its result
  // goes into the doc now, and the disk copy that merge is based on must
  // not move before it is written.
  for (const [path, merge] of [...merges]) {
    const now = await fs.stat(path);
    if (!sameStat(merge.file.stat, now)) {
      merges.delete(path);
      report.warnings.push(
        `${path} changed on disk while syncing; left it as it is, the next sync merges it`,
      );
    }
  }
  signal?.throwIfAborted();

  // Synchronous from here to the commit, so the doc can't move under us. If it
  // did while we were awaiting, the cycle restarts.
  doc.commit();
  if (!sameFrontiers(doc.oplogFrontiers(), seen)) throw new Stale();

  for (const [path, merge] of merges) {
    const { file, remote: theirs } = merge;
    const merged =
      merge.baseText !== undefined
        ? mergeTexts(merge.baseText, theirs.text, file.text!)
        : mergeText(doc, merge.pin, path, file.text!, theirs.id);
    if (merged === null) {
      conflict(path, "was replaced in the project; kept the folder version");
      putLocal(path, file, "text");
    } else if (merged === file.text) {
      // The disk already holds the merge; the doc catches up.
      if (merged !== theirs.text)
        toDoc.set(path, { kind: "text", text: merged });
      outcomes.set(path, { t: "local", file, kind: "text" });
      report.merged.push(path);
    } else {
      if (merged !== theirs.text)
        toDoc.set(path, { kind: "text", text: merged });
      toDisk.set(path, {
        content: { kind: "text", text: merged },
        expect: file.stat,
      });
      outcomes.set(path, { t: "disk" });
      report.merged.push(path);
    }
  }

  const changes = new Map<string, Change>();
  for (const [path, put] of toDoc) {
    if (put.kind === "delete") changes.set(path, { kind: "delete" });
    else if (put.kind === "text") changes.set(path, put);
    else {
      const info = known.get(put.file.digest)!;
      changes.set(path, { kind: "asset", ...info });
    }
  }
  if (changes.size > 0) {
    report.applied = applyChanges(project, changes, {
      message: COMMIT_MESSAGE,
      origin: FOLDER_ORIGIN,
    });
    for (const { path, reason } of report.applied.skipped) {
      report.skipped.push({ path, reason: skipText(reason) });
      outcomes.set(path, { t: "gone" });
      toDisk.delete(path);
    }
  }
  const synced = doc.oplogFrontiers();

  // Past the commit nothing may throw: the doc holds changes (merges
  // especially) that only the new base accounts for, and losing it would apply
  // them twice. A fatal error (permission gone) stops the remaining work and
  // is handed back next to the base. Stopping halfway for any other reason
  // would leave a merged doc whose merge is not on disk.
  let interrupted: unknown;
  const outdated = new Set<string>();
  const written = new Map<string, BaseFile>();
  const removed = new Set<string>();
  const changedSince = async (path: string, expect: FileStat | null) => {
    const now = await fs.stat(path);
    return expect === null ? now !== null : !sameStat(expect, now);
  };
  const skipWrite = (path: string, why: string) => {
    outdated.add(path);
    report.warnings.push(
      `${path} ${why}; left it as it is, the next sync merges it`,
    );
  };
  const fail = (path: string, e: unknown, what: string) => {
    if (isPermission(e)) interrupted ??= e;
    else skipWrite(path, `could not be ${what} (${errorText(e)})`);
  };

  await mapConcurrent([...toDisk], CONCURRENCY, async ([path, target]) => {
    if (interrupted) return;
    const { content } = target;
    try {
      const bytes =
        content.kind === "text"
          ? encoder.encode(content.text)
          : await assets.load(content.hash);
      // An editor may have saved since the scan; writing now would throw
      // that save away.
      if (await changedSince(path, target.expect)) {
        skipWrite(path, "changed on disk while syncing");
        return;
      }
      await fs.write(path, bytes);
      const stat = await fs.stat(path);
      if (!stat) return;
      const hash = await digest(bytes);
      written.set(
        path,
        content.kind === "text"
          ? { kind: "text", digest: hash, size: stat.size, mtime: stat.mtime }
          : {
              kind: "asset",
              hash: content.hash,
              digest: hash,
              size: stat.size,
              mtime: stat.mtime,
              mime: content.mime,
            },
      );
      report.written.push(path);
    } catch (e) {
      fail(path, e, "written");
    }
  });
  for (const [path, expect] of removals) {
    if (interrupted) break;
    try {
      if (await changedSince(path, expect)) {
        skipWrite(
          path,
          "was deleted in the project but changed on disk meanwhile",
        );
        continue;
      }
      await fs.remove(path);
      removed.add(path);
      report.deleted.push(path);
    } catch (e) {
      fail(path, e, "removed");
    }
  }
  // Whatever the interruption left undone stays as the base had it.
  for (const path of toDisk.keys()) {
    if (!written.has(path)) outdated.add(path);
  }
  for (const path of removals.keys()) {
    if (!removed.has(path)) outdated.add(path);
  }
  report.written.sort();
  report.deleted.sort();

  if (!interrupted && (!fast || report.applied?.changed)) {
    for (const dir of materializeDirs(project)) {
      if (scan.present.has(dir) || dropped.has(dir)) continue;
      if (scan.rules.classify(dir, true).kind !== "sync") continue;
      try {
        await fs.mkdir(dir);
      } catch (e) {
        if (isPermission(e)) {
          interrupted = e;
          break;
        }
        report.warnings.push(`could not create the folder ${dir}`);
      }
    }
  }

  // The new base
  const moved = !sameFrontiers(synced, base?.frontiers ?? []);
  const files: Record<string, BaseFile> = {};
  for (const [path, b] of Object.entries(baseFiles)) {
    // Unchanged on both sides, so it matches the doc at the new frontiers.
    files[path] = withoutPin(refreshed.get(path) ?? b);
  }
  for (const [path, outcome] of outcomes) {
    const old = baseFiles[path];
    const merge = merges.get(path);
    if (merge && outdated.has(path)) {
      // The doc holds the merge but the disk does not. The entry records
      // the disk text that went into it, so the next cycle merges the disk
      // as it is then against that, and does not replay this edit.
      const { file } = merge;
      files[path] = {
        kind: "text",
        digest: file.digest,
        size: file.stat.size,
        mtime: file.stat.mtime,
        text: file.text!,
      };
    } else if (outcome.t === "keep" || outdated.has(path)) {
      // The old entry stays, pinned to the doc state it matches, for a
      // file whose write was skipped or held back.
      if (!old) delete files[path];
      else files[path] = pinnedAt(old, moved ? base!.frontiers : undefined);
    } else if (outcome.t === "gone") {
      delete files[path];
    } else if (outcome.t === "disk") {
      const entry = written.get(path);
      if (entry) files[path] = entry;
      else delete files[path];
    } else {
      const { file, kind } = outcome;
      const info =
        outcome.info ?? (kind === "asset" ? known.get(file.digest) : undefined);
      const stat = { size: file.stat.size, mtime: file.stat.mtime };
      files[path] =
        kind === "text"
          ? { kind, digest: file.digest, ...stat }
          : {
              kind,
              hash: info!.hash,
              mime: info!.mime,
              digest: file.digest,
              ...stat,
            };
    }
  }
  return { base: { frontiers: synced, files }, report, interrupted };
}

async function remoteDiffers(
  b: BaseFile,
  r: MaterializedFile,
): Promise<boolean> {
  if (r.kind === "asset") return b.kind !== "asset" || r.hash !== b.hash;
  if (b.kind !== "text") return true;
  const bytes = encoder.encode(r.text);
  if (bytes.length !== b.size) return true;
  return (await digest(bytes)) !== b.digest;
}

/** The user took the folder's access away, or never gave it. */
export function isPermission(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "NotAllowedError" || e.name === "SecurityError")
  );
}
