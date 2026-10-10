import {
  Cursor,
  type EphemeralStore,
  type LoroDoc,
  type LoroText,
  type TreeID,
} from "loro-crdt";

import { isValidColor, normalizeName, type Identity } from "./identity";

/** What each client publishes under `p:<peerId>` in the ephemeral store. */
export interface PresenceState {
  name: string;
  color: string;
  fileId: TreeID | null;
  /** Encoded Loro cursors of the selection in `fileId`'s text. */
  anchor?: Uint8Array;
  head?: Uint8Array;
}

export interface RemotePeer extends PresenceState {
  peerId: string;
}

/**
 * Who is here and in which file, without the selection that moves with
 * every keystroke.
 */
export type PeerSummary = Pick<
  RemotePeer,
  "peerId" | "name" | "color" | "fileId"
>;

export interface PresenceSource {
  getPeers(): readonly RemotePeer[];
  subscribe(listener: () => void): () => void;
}

const KEY_PREFIX = "p:";

export function presenceKey(peerId: string): string {
  return KEY_PREFIX + peerId;
}

const TREE_ID = /^\d+@\d+$/;

/** Validates a state received from another client. */
export function parsePresence(value: unknown): PresenceState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !isValidColor(v.color)) return null;
  const name = normalizeName(v.name);
  if (!name) return null;
  const fileId =
    typeof v.fileId === "string" && TREE_ID.test(v.fileId)
      ? (v.fileId as TreeID)
      : null;
  const state: PresenceState = { name, color: v.color, fileId };
  if (v.anchor instanceof Uint8Array && v.head instanceof Uint8Array) {
    state.anchor = v.anchor;
    state.head = v.head;
  }
  return state;
}

function encodeCursor(text: LoroText, pos: number): Uint8Array | undefined {
  const cursor = text.getCursor(pos);
  if (!cursor) return undefined;
  try {
    return cursor.encode();
  } finally {
    cursor.free();
  }
}

/** Encodes a selection as stable Loro cursors (UTF-16 offsets in `text`). */
export function encodeSelection(
  text: LoroText,
  anchor: number,
  head: number,
): { anchor: Uint8Array; head: Uint8Array } | null {
  const a = encodeCursor(text, anchor);
  const h = anchor === head ? a : encodeCursor(text, head);
  return a && h ? { anchor: a, head: h } : null;
}

function decodeCursor(
  doc: LoroDoc,
  textId: string,
  bytes: Uint8Array,
): number | null {
  let cursor: Cursor;
  try {
    cursor = Cursor.decode(bytes);
  } catch {
    return null;
  }
  try {
    if (cursor.containerId() !== textId) return null;
    // Throws when the cursor points at ops this doc has not received yet,
    // which happens when presence overtakes the matching doc update.
    return doc.getCursorPos(cursor)?.offset ?? null;
  } catch {
    return null;
  } finally {
    cursor.free();
  }
}

/** Resolves a peer's selection against the current state of `text`. */
export function resolveSelection(
  doc: LoroDoc,
  text: LoroText,
  state: Pick<PresenceState, "anchor" | "head">,
): { anchor: number; head: number } | null {
  if (!state.anchor || !state.head) return null;
  const anchor = decodeCursor(doc, text.id, state.anchor);
  const head = decodeCursor(doc, text.id, state.head);
  if (anchor === null || head === null) return null;
  return { anchor, head };
}

export interface PresenceOptions {
  doc: LoroDoc;
  ephemeral: EphemeralStore;
  identity: Identity;
  throttleMs?: number;
  /** Must stay below the store timeout (30 s) or we flicker for others. */
  refreshMs?: number;
}

const EMPTY: readonly RemotePeer[] = [];
const EMPTY_SUMMARY: readonly PeerSummary[] = [];

function sameSummary(
  prev: readonly PeerSummary[],
  next: readonly RemotePeer[],
): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (p, i) =>
        p.peerId === next[i]!.peerId &&
        p.name === next[i]!.name &&
        p.color === next[i]!.color &&
        p.fileId === next[i]!.fileId,
    )
  );
}

/**
 * This client's entry in the ephemeral store plus a cached, validated view of
 * everybody else's. Call `start()`/`dispose()` from an effect; a disposed
 * instance can be started again (StrictMode remounts do that).
 */
export class Presence implements PresenceSource {
  readonly peerId: string;
  private readonly ephemeral: EphemeralStore;
  private readonly throttleMs: number;
  private readonly refreshMs: number;
  private identity: Identity;
  private fileId: TreeID | null = null;
  private selection: { anchor: Uint8Array; head: Uint8Array } | null = null;
  private peers: readonly RemotePeer[] = EMPTY;
  private summary: readonly PeerSummary[] = EMPTY_SUMMARY;
  private readonly listeners = new Set<() => void>();
  private running = false;
  /** Time of our last write (set or delete) to the store. */
  private lastWrite = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: PresenceOptions) {
    this.ephemeral = options.ephemeral;
    this.identity = options.identity;
    this.peerId = options.doc.peerIdStr;
    // At least 1 ms: the store resolves writes by millisecond timestamp and
    // peers drop a second write within the same millisecond.
    this.throttleMs = Math.max(1, options.throttleMs ?? 50);
    this.refreshMs = options.refreshMs ?? 15_000;
  }

  get key(): string {
    return presenceKey(this.peerId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.ephemeral.subscribe((event) => {
      const keys = [...event.added, ...event.updated, ...event.removed];
      // Our own throttled updates would otherwise re-render every consumer.
      if (keys.every((k) => k === this.key)) return;
      this.recompute();
    });
    this.refresh = setInterval(() => this.publish(), this.refreshMs);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.schedulePublish();
    this.recompute();
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    this.clearPending();
    if (this.refresh !== null) clearInterval(this.refresh);
    this.refresh = null;
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deleteOwn();
  }

  getPeers = (): readonly RemotePeer[] => this.peers;

  /**
   * Keeps its identity until somebody joins, leaves, renames or switches
   * files, so views that only show who is where skip the updates every
   * remote caret move triggers. Shares `subscribe` with `getPeers`.
   */
  getSummary = (): readonly PeerSummary[] => this.summary;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setIdentity(identity: Identity): void {
    if (
      identity.name === this.identity.name &&
      identity.color === this.identity.color
    )
      return;
    this.identity = identity;
    this.schedulePublish();
  }

  /** Switching files drops the selection; the editor reports a new one. */
  setFile(fileId: TreeID | null): void {
    if (fileId === this.fileId) return;
    this.fileId = fileId;
    this.selection = null;
    this.schedulePublish();
  }

  /**
   * The cursors are encoded right away, so a later local edit cannot shift
   * the offsets before the throttled publish goes out. Takes the file too:
   * a freshly mounted editor reports before the provider's `setFile` effect
   * runs (child effects first), and the pair must never be published apart.
   */
  setSelection(
    fileId: TreeID,
    text: LoroText,
    anchor: number,
    head: number,
  ): void {
    this.fileId = fileId;
    this.selection = encodeSelection(text, anchor, head);
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (!this.running) return;
    const wait = this.lastWrite + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.publish();
    } else if (this.pending === null) {
      this.pending = setTimeout(() => {
        this.pending = null;
        this.publish();
      }, wait);
    }
  }

  private publish(): void {
    if (!this.running) return;
    this.clearPending();
    this.lastWrite = Date.now();
    const state: PresenceState = {
      name: this.identity.name,
      color: this.identity.color,
      fileId: this.fileId,
    };
    if (this.selection) {
      state.anchor = this.selection.anchor;
      state.head = this.selection.head;
    }
    // EphemeralStore's typing wants a Value; a plain object of strings, null
    // and bytes is one.
    this.ephemeral.set(this.key, state as never);
  }

  private deleteOwn(): void {
    // Runs on teardown, where deferring is not an option. A same-millisecond
    // delete would be ignored by peers, so wait out the clock tick (bounded,
    // in case Date is frozen by fake timers).
    const until = performance.now() + 2;
    while (Date.now() <= this.lastWrite && performance.now() < until) {
      // spin
    }
    this.lastWrite = Date.now();
    this.ephemeral.delete(this.key);
  }

  private clearPending(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
  }

  private recompute(): void {
    const states = this.ephemeral.getAllStates() as Record<string, unknown>;
    const next: RemotePeer[] = [];
    for (const [key, value] of Object.entries(states)) {
      if (!key.startsWith(KEY_PREFIX) || key === this.key) continue;
      const state = parsePresence(value);
      if (state) next.push({ ...state, peerId: key.slice(KEY_PREFIX.length) });
    }
    next.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.peerId.localeCompare(b.peerId),
    );
    this.peers = next.length === 0 ? EMPTY : next;
    if (!sameSummary(this.summary, next)) {
      this.summary =
        next.length === 0
          ? EMPTY_SUMMARY
          : next.map(({ peerId, name, color, fileId }) => ({
              peerId,
              name,
              color,
              fileId,
            }));
    }
    for (const listener of [...this.listeners]) listener();
  }

  // Tell the others right away instead of letting them wait for the timeout.
  private onPageHide = () => {
    this.clearPending();
    this.deleteOwn();
  };

  // Coming back from the back/forward cache after pagehide removed us.
  private onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) this.publish();
  };
}
