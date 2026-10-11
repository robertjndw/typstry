// Keeps each project's LoroDoc in this browser, so a project opens without
// the server and edits made offline survive a reload until they sync.
//
// Layout mirrors the server's old update log: per project one snapshot plus
// the updates appended since. Data here is plaintext; it never leaves the
// browser (sync encrypts on its own).
import { VersionVector, decodeImportBlobMeta, type LoroDoc } from "loro-crdt";

import { sameBytes } from "@/crypto/bytes";
import { onPageExit } from "@/lib/page-exit";
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

/**
 * What this browser keeps of a project's MLS group. The device is stored
 * apart from the group state so a device that has to rejoin (lost or
 * outdated state) comes back as itself instead of leaving a ghost leaf.
 */
export interface MlsRecord {
  /** `ProjectGroup.exportState()`; null while only the device exists. */
  state: Uint8Array | null;
  /** `Device.export()`. */
  device: Uint8Array | null;
  /** The group removed this device. Kept so a reload still says so. */
  removed: boolean;
  /**
   * The links of the latest rotation this device went through, so a tab
   * that missed it (asleep, or opened later) can still follow it.
   */
  rotation: StoredRotation | null;
  /**
   * The person id of the project's first owner, pinned so a later group
   * that starts with another owner is refused. Set on the first join or
   * create.
   */
  ownerPerson?: Uint8Array;
}

export interface StoredRotation {
  /** The secret to put in the URL fragment. */
  link: string;
  /** The token to open the project with: the edit token for editors. */
  token: string;
  /** The view token, for members who got the edit link. */
  viewToken: string | null;
  canEdit: boolean;
}

export interface DocBackend {
  load(projectId: string): Promise<StoredDoc>;
  loadMls(projectId: string): Promise<MlsRecord | null>;
  /** Callers serialize writers themselves (see mls/session.ts). */
  saveMls(projectId: string, record: MlsRecord): Promise<void>;
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
  /** The `DeviceKey.export` bytes of this browser, if it has made one. */
  loadDeviceKey(): Promise<Uint8Array | null>;
  /**
   * Stores the device key unless one exists, and returns the one that is
   * stored. First write wins, so tabs that race to create the key all end up
   * with the same one.
   */
  saveDeviceKey(key: Uint8Array): Promise<Uint8Array>;
  /** The `PersonGraph.encode` bytes of this browser's person, if any. */
  loadGraph(): Promise<Uint8Array | null>;
  /**
   * Replaces the stored graph with what `merge` makes of it and `incoming`,
   * inside one transaction, and returns the result. `merge` runs on the
   * stored bytes as they are right then, so tabs that merge at once all
   * keep each other's entries; it throws to refuse (a graph of another
   * person), which leaves the store as it was.
   */
  mergeGraph(
    incoming: Uint8Array,
    merge: (stored: Uint8Array | null, incoming: Uint8Array) => Uint8Array,
  ): Promise<Uint8Array>;
  /** Names this browser gave devices of its person, by hex device key. */
  loadLabels(): Promise<Record<string, string>>;
  /** Sets the names given, by hex device key, keeping the others. */
  saveLabels(labels: Record<string, string>): Promise<void>;
  /** Drops everything stored for the project. */
  remove(projectId: string): Promise<void>;
}

const DB_NAME = "typstry";
const DB_VERSION = 1;
const SNAPSHOTS = "snapshots";
const UPDATES = "updates";
const MLS = "mls";
const PERSON = "person";
const DEVICE_ROW = "device";
const GRAPH_ROW = "graph";
const LABELS_ROW = "labels";
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

/** The PERSON store holds a few rows of its own: device, graph, labels. */
type PersonRow =
  | { id: typeof DEVICE_ROW | typeof GRAPH_ROW; key: Uint8Array }
  | { id: typeof LABELS_ROW; labels: Record<string, string> };

function keyOf(row: PersonRow | undefined): Uint8Array | null {
  return row && "key" in row ? row.key : null;
}

type MlsRow = MlsRecord & { projectId: string };

export class IndexedDbBackend implements DocBackend {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(
    factory: IDBFactory = indexedDB,
  ): Promise<IndexedDbBackend> {
    const req = factory.open(DB_NAME, DB_VERSION);
    // Each schema change appends an `oldVersion < n` step and bumps
    // DB_VERSION; never edit an earlier step, since browsers that already
    // ran it skip it and would end up with a different schema.
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1) {
        db.createObjectStore(SNAPSHOTS, { keyPath: "projectId" });
        const updates = db.createObjectStore(UPDATES, { autoIncrement: true });
        updates.createIndex(BY_PROJECT, "projectId");
        db.createObjectStore(MLS, { keyPath: "projectId" });
        db.createObjectStore(PERSON, { keyPath: "id" });
      }
    };
    // Fires while another tab still holds an older connection. Those tabs
    // close on versionchange, so the open normally goes through moments
    // later; rejecting here would drop to memory for a transient delay.
    req.onblocked = () =>
      console.warn("local persistence upgrade waiting on another tab");
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

  async loadMls(projectId: string): Promise<MlsRecord | null> {
    const tx = this.db.transaction(MLS, "readonly");
    const row = await request<MlsRow | undefined>(
      tx.objectStore(MLS).get(projectId),
    );
    if (!row) return null;
    const { state, device, removed, rotation, ownerPerson } = row;
    return { state, device, removed, rotation, ownerPerson };
  }

  async saveMls(projectId: string, record: MlsRecord): Promise<void> {
    const tx = this.db.transaction(MLS, "readwrite");
    tx.objectStore(MLS).put({ ...record, projectId } satisfies MlsRow);
    await done(tx);
  }

  private async loadKeyRow(id: typeof DEVICE_ROW | typeof GRAPH_ROW) {
    const tx = this.db.transaction(PERSON, "readonly");
    const row = await request<PersonRow | undefined>(
      tx.objectStore(PERSON).get(id),
    );
    return keyOf(row);
  }

  loadDeviceKey(): Promise<Uint8Array | null> {
    return this.loadKeyRow(DEVICE_ROW);
  }

  async saveDeviceKey(key: Uint8Array): Promise<Uint8Array> {
    const tx = this.db.transaction(PERSON, "readwrite");
    const store = tx.objectStore(PERSON);
    const existing = await request<PersonRow | undefined>(
      store.get(DEVICE_ROW),
    );
    // The get and the put share one readwrite transaction, which browsers
    // run one at a time per store, so a racing tab sees our key or we see
    // theirs.
    if (!existing) store.put({ id: DEVICE_ROW, key } satisfies PersonRow);
    await done(tx);
    return keyOf(existing) ?? key;
  }

  loadGraph(): Promise<Uint8Array | null> {
    return this.loadKeyRow(GRAPH_ROW);
  }

  async mergeGraph(
    incoming: Uint8Array,
    merge: (stored: Uint8Array | null, incoming: Uint8Array) => Uint8Array,
  ): Promise<Uint8Array> {
    const tx = this.db.transaction(PERSON, "readwrite");
    const committed = done(tx);
    const store = tx.objectStore(PERSON);
    const stored = keyOf(
      await request<PersonRow | undefined>(store.get(GRAPH_ROW)),
    );
    let key: Uint8Array;
    try {
      key = merge(stored, incoming);
    } catch (error) {
      tx.abort();
      await committed.catch(() => {});
      throw error;
    }
    // Most merges add nothing, and a write still costs a transaction commit.
    if (!stored || !sameBytes(stored, key))
      store.put({ id: GRAPH_ROW, key } satisfies PersonRow);
    await committed;
    return key;
  }

  async loadLabels(): Promise<Record<string, string>> {
    const tx = this.db.transaction(PERSON, "readonly");
    const row = await request<PersonRow | undefined>(
      tx.objectStore(PERSON).get(LABELS_ROW),
    );
    return row && "labels" in row ? row.labels : {};
  }

  async saveLabels(labels: Record<string, string>): Promise<void> {
    const tx = this.db.transaction(PERSON, "readwrite");
    const committed = done(tx);
    const store = tx.objectStore(PERSON);
    const row = await request<PersonRow | undefined>(store.get(LABELS_ROW));
    const stored = row && "labels" in row ? row.labels : {};
    store.put({
      id: LABELS_ROW,
      labels: { ...stored, ...labels },
    } satisfies PersonRow);
    await committed;
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
    const tx = this.db.transaction([SNAPSHOTS, UPDATES, MLS], "readwrite");
    const committed = done(tx);
    tx.objectStore(SNAPSHOTS).delete(projectId);
    tx.objectStore(MLS).delete(projectId);
    const updates = tx.objectStore(UPDATES);
    const keys = await request(updates.index(BY_PROJECT).getAllKeys(projectId));
    for (const key of keys) updates.delete(key);
    await committed;
  }
}

/** For browsers without usable IndexedDB: survives navigation, not reloads. */
export class MemoryBackend implements DocBackend {
  private readonly docs = new Map<string, StoredDoc>();
  private readonly groups = new Map<string, MlsRecord>();
  private device: Uint8Array | null = null;
  private graph: Uint8Array | null = null;
  private labels: Record<string, string> = {};

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

  async loadMls(projectId: string): Promise<MlsRecord | null> {
    return this.groups.get(projectId) ?? null;
  }

  async saveMls(projectId: string, record: MlsRecord): Promise<void> {
    this.groups.set(projectId, record);
  }

  async loadDeviceKey(): Promise<Uint8Array | null> {
    return this.device;
  }

  async saveDeviceKey(key: Uint8Array): Promise<Uint8Array> {
    this.device ??= key;
    return this.device;
  }

  async loadGraph(): Promise<Uint8Array | null> {
    return this.graph;
  }

  async mergeGraph(
    incoming: Uint8Array,
    merge: (stored: Uint8Array | null, incoming: Uint8Array) => Uint8Array,
  ): Promise<Uint8Array> {
    this.graph = merge(this.graph, incoming);
    return this.graph;
  }

  async loadLabels(): Promise<Record<string, string>> {
    return { ...this.labels };
  }

  async saveLabels(labels: Record<string, string>): Promise<void> {
    this.labels = { ...this.labels, ...labels };
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
    this.groups.delete(projectId);
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
   * Fold the update log into a snapshot once it outgrows both this share of
   * the snapshot's size and `compactMinBytes`.
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
    const stopPageExit = onPageExit(() => void this.flush());
    this.stopListening = () => {
      unsubscribeDoc();
      unsubscribeLocal();
      stopPageExit();
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
