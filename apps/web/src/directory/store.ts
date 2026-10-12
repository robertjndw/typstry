// The page-wide directory: one LoroDoc kept in this browser under a fixed
// id, shared by every tab through a BroadcastChannel. Nothing here touches
// the device key or the person graph, so merely listing projects never
// gives a browser an identity.
import { useSyncExternalStore } from "react";
import { LoroDoc, VersionVector } from "loro-crdt";

import {
  defaultBackend,
  LocalDocStore,
  type DocBackend,
} from "@/persist/local-doc-store";

import { Directory, type Entry } from "./directory";

// Not 22 base64url characters, so it cannot collide with a space id. Also
// the id the doc will keep when it becomes the content of a synced space.
export const DIRECTORY_STORE_ID = "~directory";
const CHANNEL_NAME = "typstry:directory";
// Bumped when the person replaces this browser's identity, which throws the
// directory away. Every tab keys its store and channel on it, so a tab with
// the old directory in memory can neither write it back nor sync it into
// the new one.
export const GENERATION_KEY = "typstry:directory-generation";

function readGeneration(): number {
  try {
    const n = Number(localStorage.getItem(GENERATION_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function storeIdOf(generation: number): string {
  return `${DIRECTORY_STORE_ID}.${generation}`;
}

function channelOf(generation: number): string {
  return `${CHANNEL_NAME}.${generation}`;
}

/**
 * Calls `reload` when another tab reset the directory. Reloading is the one
 * sure way to drop the documents and sessions this page built on the old
 * one, and a reset is rare.
 */
export function onDirectoryReset(
  reload: () => void = () => location.reload(),
): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === GENERATION_KEY) reload();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

const UPDATE = 0;
const REQUEST = 1;

/** A channel message: a tag byte, then an update or a version vector. */
function frame(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

/** One open directory: the doc, its persistence and its tab channel. */
export class DirectoryStore {
  readonly directory: Directory;
  /** @internal flushDirectory */
  readonly local: LocalDocStore;
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<() => void>();
  private entries: Entry[];
  private readonly cleanup: (() => void)[] = [];

  private constructor(
    directory: Directory,
    local: LocalDocStore,
    channel: BroadcastChannel | null,
  ) {
    this.directory = directory;
    this.local = local;
    this.channel = channel;
    this.entries = directory.list(Date.now());
    const { doc } = directory;
    // Fires for local commits and imports alike, so the list also follows
    // what other tabs wrote.
    this.cleanup.push(
      doc.subscribe(() => {
        this.entries = directory.list(Date.now());
        for (const listener of [...this.listeners]) listener();
      }),
    );
    if (channel) {
      this.cleanup.push(
        doc.subscribeLocalUpdates((bytes) =>
          channel.postMessage(frame(UPDATE, bytes)),
        ),
      );
      channel.onmessage = (event: MessageEvent<unknown>) => {
        try {
          this.receive(event.data);
        } catch (error) {
          console.warn("ignoring a bad directory message", error);
        }
      };
      // Tabs that opened before one another's first write each made their
      // own init, which later updates depend on, so a new tab asks for
      // whatever it lacks instead of trusting that storage had it all.
      channel.postMessage(frame(REQUEST, doc.oplogVersion().encode()));
    }
  }

  private receive(data: unknown): void {
    // Not instanceof: a clone can come from another realm.
    if (!ArrayBuffer.isView(data) || data.byteLength === 0) return;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const body = bytes.subarray(1);
    const { doc } = this.directory;
    if (bytes[0] === UPDATE) {
      doc.import(body);
    } else if (bytes[0] === REQUEST) {
      const theirs = VersionVector.decode(body);
      this.channel?.postMessage(
        frame(UPDATE, doc.export({ mode: "update", from: theirs })),
      );
      // They may hold ops we lack too; asking after the update keeps the
      // exchange from looping, since by then they are never behind us.
      const order = doc.oplogVersion().compare(theirs);
      if (order === undefined || order < 0)
        this.channel?.postMessage(frame(REQUEST, doc.oplogVersion().encode()));
    }
  }

  static async open(
    backend: DocBackend,
    channelName: string | null = CHANNEL_NAME,
    storeId: string = DIRECTORY_STORE_ID,
  ): Promise<DirectoryStore> {
    const doc = new LoroDoc();
    const directory = new Directory(doc);
    const local = new LocalDocStore(storeId, doc, backend);
    await local.load();
    local.start();
    directory.init();
    const channel =
      channelName !== null && typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(channelName)
        : null;
    return new DirectoryStore(directory, local, channel);
  }

  /** Every project, recomputed only when the doc changed. */
  get snapshot(): Entry[] {
    return this.entries;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async close(): Promise<void> {
    for (const stop of this.cleanup.splice(0)) stop();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.listeners.clear();
    await this.local.stop();
  }
}

interface Shared {
  generation: number;
  opening: Promise<DirectoryStore>;
  backend: Promise<DocBackend>;
  ready: DirectoryStore | null;
}

let shared: Shared | null = null;
let watching = false;

function sharedStore(): Shared {
  if (shared) return shared;
  if (!watching && typeof window !== "undefined") {
    watching = true;
    onDirectoryReset();
  }
  const backend = defaultBackend();
  const generation = readGeneration();
  const entry: Shared = {
    generation,
    backend,
    ready: null,
    opening: backend
      .then((b) =>
        DirectoryStore.open(b, channelOf(generation), storeIdOf(generation)),
      )
      .then((store) => {
        // A reset while opening replaced `shared`; this one is stale.
        if (shared === entry) entry.ready = store;
        return store;
      }),
  };
  // A failed open must not stick, or every later call would fail the same.
  entry.opening.catch(() => {
    if (shared === entry) shared = null;
  });
  shared = entry;
  return entry;
}

/** The page's directory, opened on first use. */
export async function directory(): Promise<Directory> {
  return (await sharedStore().opening).directory;
}

/**
 * Writes the directory to storage now. Debounced saving alone could lose a
 * write when the person navigates away right after opening a project, and
 * a page that is unloading cannot be relied on to finish the save.
 */
export async function flushDirectory(): Promise<void> {
  await (await sharedStore().opening).local.flush();
}

const NONE: Entry[] | null = null;

function subscribe(onChange: () => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;
  sharedStore().opening.then(
    (store) => {
      if (cancelled) return;
      unsubscribe = store.subscribe(onChange);
      onChange();
    },
    (error) => console.warn("could not open the project directory", error),
  );
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/** The person's projects, or null until the directory has loaded. */
export function useDirectory(): Entry[] | null {
  return useSyncExternalStore(subscribe, () => shared?.ready?.snapshot ?? NONE);
}

/**
 * Closes the page's directory, deletes what it stored and moves every tab
 * to a fresh generation, so the next `directory()` starts from nothing.
 * Other tabs reload (see `onDirectoryReset`). Tests also use it, since they
 * share one module.
 */
export async function resetDirectory(): Promise<void> {
  const old = shared;
  shared = null;
  const generation = old?.generation ?? readGeneration();
  try {
    localStorage.setItem(GENERATION_KEY, String(generation + 1));
  } catch {
    // Without storage there are no other tabs to tell.
  }
  const store = old ? await old.opening.catch(() => null) : null;
  await store?.close();
  await (
    await (old?.backend ?? defaultBackend())
  ).remove(storeIdOf(generation));
}
