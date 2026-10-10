// Keeps each project's LoroDoc in this browser, so a project opens without
// the server and edits made offline survive a reload until they sync.
//
// Layout mirrors the server's old update log: per project one snapshot plus
// the updates appended since. Data here is plaintext; it never leaves the
// browser (sync encrypts on its own).
import { VersionVector, decodeImportBlobMeta, type LoroDoc } from "loro-crdt";

import { createSerialQueue } from "@/lib/serial-queue";

export interface StoredDoc {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
}

function blobsOf(stored: StoredDoc): Uint8Array[] {
  return stored.snapshot
    ? [stored.snapshot, ...stored.updates]
    : stored.updates;
}

export interface DocBackend {
  load(projectId: string): Promise<StoredDoc>;
  append(projectId: string, update: Uint8Array): Promise<void>;
  /**
   * Replaces everything stored for the project with the snapshot `build`
   * returns. `build` gets what is stored right then and runs inside the same
   * transaction, so updates another tab appended meanwhile are folded in
   * instead of being deleted unseen.
   */
  compact(
    projectId: string,
    build: (stored: StoredDoc) => Uint8Array,
  ): Promise<void>;
  /** Drops everything stored for the project. */
  remove(projectId: string): Promise<void>;
}

const DB_NAME = "typstry";
const DB_VERSION = 1;
const SNAPSHOTS = "snapshots";
const UPDATES = "updates";
const BY_PROJECT = "projectId";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

interface Row {
  projectId: string;
  data: Uint8Array;
}

export class IndexedDbBackend implements DocBackend {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(
    factory: IDBFactory = indexedDB,
  ): Promise<IndexedDbBackend> {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(SNAPSHOTS, { keyPath: "projectId" });
      const updates = db.createObjectStore(UPDATES, { autoIncrement: true });
      updates.createIndex(BY_PROJECT, "projectId");
    };
    const db = await request(req);
    // Another tab upgrading the schema would wait on us forever otherwise.
    db.onversionchange = () => db.close();
    return new IndexedDbBackend(db);
  }

  async load(projectId: string): Promise<StoredDoc> {
    const tx = this.db.transaction([SNAPSHOTS, UPDATES], "readonly");
    const snapshot = request<Row | undefined>(
      tx.objectStore(SNAPSHOTS).get(projectId),
    );
    // Auto-increment keys keep the index in append order.
    const updates = request<Row[]>(
      tx.objectStore(UPDATES).index(BY_PROJECT).getAll(projectId),
    );
    const [snap, rows] = await Promise.all([snapshot, updates]);
    return {
      snapshot: snap?.data ?? null,
      updates: rows.map((row) => row.data),
    };
  }

  async append(projectId: string, update: Uint8Array): Promise<void> {
    const tx = this.db.transaction(UPDATES, "readwrite");
    tx.objectStore(UPDATES).add({
      projectId,
      data: update,
    } satisfies Row);
    await done(tx);
  }

  async compact(
    projectId: string,
    build: (stored: StoredDoc) => Uint8Array,
  ): Promise<void> {
    const tx = this.db.transaction([SNAPSHOTS, UPDATES], "readwrite");
    const committed = done(tx);
    const snapshots = tx.objectStore(SNAPSHOTS);
    const index = tx.objectStore(UPDATES).index(BY_PROJECT);
    // No other awaits in between: a transaction commits as soon as a task
    // ends without pending requests, and `build` must run while it is live.
    const [snap, rows, keys] = await Promise.all([
      request<Row | undefined>(snapshots.get(projectId)),
      request<Row[]>(index.getAll(projectId)),
      request<IDBValidKey[]>(index.getAllKeys(projectId)),
    ]);
    let data: Uint8Array;
    try {
      data = build({
        snapshot: snap?.data ?? null,
        updates: rows.map((row) => row.data),
      });
    } catch (error) {
      tx.abort();
      await committed.catch(() => {});
      throw error;
    }
    snapshots.put({ projectId, data } satisfies Row);
    const updates = tx.objectStore(UPDATES);
    for (const key of keys) updates.delete(key);
    await committed;
  }

  async remove(projectId: string): Promise<void> {
    const tx = this.db.transaction([SNAPSHOTS, UPDATES], "readwrite");
    const committed = done(tx);
    tx.objectStore(SNAPSHOTS).delete(projectId);
    const updates = tx.objectStore(UPDATES);
    const keys = await request(updates.index(BY_PROJECT).getAllKeys(projectId));
    for (const key of keys) updates.delete(key);
    await committed;
  }
}

/** For browsers without usable IndexedDB: survives navigation, not reloads. */
export class MemoryBackend implements DocBackend {
  private readonly docs = new Map<string, StoredDoc>();

  private entry(projectId: string): StoredDoc {
    let entry = this.docs.get(projectId);
    if (!entry) {
      entry = { snapshot: null, updates: [] };
      this.docs.set(projectId, entry);
    }
    return entry;
  }

  async load(projectId: string): Promise<StoredDoc> {
    const entry = this.entry(projectId);
    return { snapshot: entry.snapshot, updates: [...entry.updates] };
  }

  async append(projectId: string, update: Uint8Array): Promise<void> {
    this.entry(projectId).updates.push(update);
  }

  async compact(
    projectId: string,
    build: (stored: StoredDoc) => Uint8Array,
  ): Promise<void> {
    const snapshot = build(await this.load(projectId));
    this.docs.set(projectId, { snapshot, updates: [] });
  }

  async remove(projectId: string): Promise<void> {
    this.docs.delete(projectId);
  }
}

let shared: Promise<DocBackend> | null = null;

/** IndexedDB when it works (it can be missing or refuse in private modes). */
export function defaultBackend(): Promise<DocBackend> {
  shared ??= (async (): Promise<DocBackend> => {
    try {
      if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
      const backend = await IndexedDbBackend.open();
      // Best effort: asks the browser not to evict our data under storage
      // pressure. Safari still clears it after weeks without a visit.
      void navigator.storage?.persist?.().catch(() => false);
      return backend;
    } catch (error) {
      console.warn(
        "local persistence unavailable, keeping projects in memory",
        error,
      );
      return new MemoryBackend();
    }
  })();
  return shared;
}

export interface LocalDocStoreOptions {
  /** Writes once edits pause for this long, batching a burst into one row. */
  flushDelayMs?: number;
  /** Writes at least this often while edits keep coming. */
  maxFlushDelayMs?: number;
  /**
   * Fold the update log into a snapshot once it outgrows this share of the
   * snapshot's size, and `compactMinBytes`.
   */
  compactRatio?: number;
  /** Keeps a small project from compacting every few edits. */
  compactMinBytes?: number;
}

/**
 * Persists one project's doc: `load()` once before syncing, then `start()`
 * to write every change (local edits and synced ones) shortly after it
 * happens, and `stop()` to flush and let go.
 */
export class LocalDocStore {
  private readonly projectId: string;
  private readonly doc: LoroDoc;
  private readonly backend: DocBackend;
  private readonly flushDelayMs: number;
  private readonly maxFlushDelayMs: number;
  private readonly compactRatio: number;
  private readonly compactMinBytes: number;
  /** The doc version everything up to which is stored. */
  private persisted: VersionVector = new VersionVector(null);
  /** Stored snapshot size, as of the last load or compaction. */
  private snapshotBytes = 0;
  /**
   * Bytes in the update log. Rows other tabs append are not counted, so
   * with several tabs open this runs behind and compaction comes late.
   */
  private logBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest change not written yet happened. */
  private dirtySince: number | null = null;
  private readonly enqueue = createSerialQueue(
    "saving the project locally failed",
  );
  private stopListening: (() => void) | null = null;

  constructor(
    projectId: string,
    doc: LoroDoc,
    backend: DocBackend,
    options: LocalDocStoreOptions = {},
  ) {
    this.projectId = projectId;
    this.doc = doc;
    this.backend = backend;
    this.flushDelayMs = options.flushDelayMs ?? 300;
    this.maxFlushDelayMs = options.maxFlushDelayMs ?? 2000;
    this.compactRatio = options.compactRatio ?? 0.5;
    this.compactMinBytes = options.compactMinBytes ?? 64 * 1024;
  }

  /** Imports what is stored. Returns false when nothing was. */
  async load(): Promise<boolean> {
    const stored = await this.backend.load(this.projectId);
    const blobs = blobsOf(stored);
    if (blobs.length > 0) this.doc.importBatch(blobs);
    this.persisted = this.doc.oplogVersion();
    this.snapshotBytes = stored.snapshot?.length ?? 0;
    this.logBytes = totalBytes(stored.updates);
    return blobs.length > 0;
  }

  start(): void {
    if (this.stopListening) return;
    const schedule = () => this.schedule();
    const unsubscribeDoc = this.doc.subscribe(schedule);
    const unsubscribeLocal = this.doc.subscribeLocalUpdates(schedule);
    // A closing tab gets no second chance; hidden is the last reliable
    // moment, especially on mobile where pagehide may never fire.
    const onHide = () => {
      if (document.visibilityState === "hidden") void this.flush();
    };
    const onPageHide = () => void this.flush();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onHide);
      window.addEventListener("pagehide", onPageHide);
    }
    this.stopListening = () => {
      unsubscribeDoc();
      unsubscribeLocal();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onHide);
        window.removeEventListener("pagehide", onPageHide);
      }
    };
  }

  async stop(): Promise<void> {
    this.stopListening?.();
    this.stopListening = null;
    await this.flush();
  }

  /** Writes whatever is not stored yet. */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirtySince = null;
    return this.enqueue(() => this.write());
  }

  // Waits for a pause, so steady typing does not append a row every few
  // keystrokes, but never longer than maxFlushDelayMs: that bounds what a
  // crash can take with it.
  private schedule(): void {
    const now = Date.now();
    this.dirtySince ??= now;
    if (this.timer !== null) clearTimeout(this.timer);
    const wait = Math.min(
      this.flushDelayMs,
      this.dirtySince + this.maxFlushDelayMs - now,
    );
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(0, wait),
    );
  }

  private async write(): Promise<void> {
    // Read the version and export in one synchronous step, so an edit that
    // lands while the write is in flight is neither lost nor counted early.
    const version = this.doc.oplogVersion();
    if (version.compare(this.persisted) === 0) return;
    const update = this.doc.export({ mode: "update", from: this.persisted });
    await this.backend.append(this.projectId, update);
    this.persisted = version;
    this.logBytes += update.length;
    const limit = Math.max(
      this.compactMinBytes,
      this.snapshotBytes * this.compactRatio,
    );
    if (this.logBytes > limit) await this.compact();
  }

  private async compact(): Promise<void> {
    let version = this.persisted;
    let size = 0;
    await this.backend.compact(this.projectId, (stored) => {
      // Another tab may have stored ops this doc has never seen; importing
      // them is what keeps the new snapshot from dropping them. Most rows
      // are this tab's own or arrived here through sync too, and importing
      // those again would only cost time.
      const have = this.doc.oplogVersion();
      const missing = blobsOf(stored).filter((blob) => !covers(have, blob));
      if (missing.length > 0) this.doc.importBatch(missing);
      version = this.doc.oplogVersion();
      const snapshot = this.doc.export({ mode: "snapshot" });
      size = snapshot.length;
      return snapshot;
    });
    this.persisted = version;
    this.snapshotBytes = size;
    this.logBytes = 0;
  }
}

function totalBytes(blobs: Uint8Array[]): number {
  return blobs.reduce((sum, blob) => sum + blob.length, 0);
}

/** Whether `have` already includes every op in `blob`. */
function covers(have: VersionVector, blob: Uint8Array): boolean {
  let end: VersionVector;
  try {
    end = decodeImportBlobMeta(blob, false).partialEndVersionVector;
  } catch {
    // Let importBatch judge it: it throws for a broken row, which aborts
    // the compaction instead of writing a snapshot without that row.
    return false;
  }
  const cmp = have.compare(end);
  return cmp !== undefined && cmp >= 0;
}
