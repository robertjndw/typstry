// Keeps each project's LoroDoc in this browser, so a project opens without
// the server and edits made offline survive a reload until they sync.
//
// Layout mirrors the server's old update log: per project one snapshot plus
// the updates appended since. Data here is plaintext; it never leaves the
// browser (sync encrypts on its own).
import { VersionVector, type LoroDoc } from "loro-crdt";

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
  /** Batches a burst of edits into one write. */
  flushDelayMs?: number;
  /** Fold the update log into a snapshot after this many appends. */
  compactAfter?: number;
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
  private readonly compactAfter: number;
  /** The doc version everything up to which is stored. */
  private persisted: VersionVector = new VersionVector(null);
  private appended = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
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
    this.compactAfter = options.compactAfter ?? 100;
  }

  /** Imports what is stored. Returns false when nothing was. */
  async load(): Promise<boolean> {
    const stored = await this.backend.load(this.projectId);
    const blobs = blobsOf(stored);
    if (blobs.length > 0) this.doc.importBatch(blobs);
    this.persisted = this.doc.oplogVersion();
    this.appended = stored.updates.length;
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
    return this.enqueue(() => this.write());
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  private async write(): Promise<void> {
    // Read the version and export in one synchronous step, so an edit that
    // lands while the write is in flight is neither lost nor counted early.
    const version = this.doc.oplogVersion();
    if (version.compare(this.persisted) === 0) return;
    const update = this.doc.export({ mode: "update", from: this.persisted });
    await this.backend.append(this.projectId, update);
    this.persisted = version;
    this.appended += 1;
    if (this.appended >= this.compactAfter) await this.compact();
  }

  private async compact(): Promise<void> {
    let version = this.persisted;
    await this.backend.compact(this.projectId, (stored) => {
      const blobs = blobsOf(stored);
      // Another tab may have stored ops this doc has never seen; importing
      // them is what keeps the new snapshot from dropping them.
      if (blobs.length > 0) this.doc.importBatch(blobs);
      version = this.doc.oplogVersion();
      return this.doc.export({ mode: "snapshot" });
    });
    this.persisted = version;
    this.appended = 0;
  }
}
