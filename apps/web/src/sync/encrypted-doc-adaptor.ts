import { VersionVector, type LoroDoc, type PeerID } from "loro-crdt";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "loro-adaptors";
import {
  CrdtType,
  EloRecordKind,
  UpdateStatusCode,
  decodeEloContainer,
  encodeEloContainer,
  parseEloRecordHeader,
  type JoinResponseOk,
} from "loro-protocol";

import {
  UnknownGenerationError,
  type SpaceCrypto,
} from "@/crypto/space-crypto";
import { toError } from "@/lib/errors";
import { onPageExit } from "@/lib/page-exit";
import { createSerialQueue } from "@/lib/serial-queue";

/** Per peer, the end of the op counter range known to be stored. */
type Counters = Map<PeerID, number>;

interface Span {
  peer: PeerID;
  start: number;
  end: number;
}

/** What the doc adaptor needs of a space's keys. */
export type RecordCrypto = Pick<
  SpaceCrypto,
  "canWrite" | "encryptDelta" | "encryptSnapshot" | "decryptRecord"
>;

export interface EncryptedDocAdaptorOptions {
  crypto: RecordCrypto;
  /**
   * View links never send: the server refuses their doc updates, and
   * without an editor's attestation other clients would too.
   */
  canWrite: boolean;
  /**
   * Upload a compaction snapshot once the server holds this many delta
   * records, as reported at join plus what this client sent since. The
   * server cannot compact what it cannot read, so writers do it for it.
   */
  compactAfterDeltas?: number;
  /**
   * Least time between two compactions while connected. The one right
   * after joining does not wait for it.
   */
  compactIntervalMs?: number;
  /**
   * How long local commits gather before they go up together. Each send
   * becomes one stored record, so sending per keystroke would grow the
   * server log (and everyone's backfill) by one record per character.
   */
  pushDelayMs?: number;
  /** Delay before resending spans the server refused for a passing reason. */
  retryMs?: number;
  /**
   * Upload a snapshot as soon as the backfill is in, whatever the log
   * length. For a connection opened right after a rotation: the keys are
   * new, and a joiner should find a snapshot sealed under them first.
   */
  compactOnJoin?: boolean;
  /**
   * Decides whether this device may upload into the space: a link or
   * binding can point at a space of another kind, and the local history
   * must not end up there. Asked after every import until it answers;
   * `undefined` means it cannot tell yet (the doc's kind has not arrived),
   * which counts as yes once the doc has caught up with the server. Until
   * it answers local commits only queue. Asking early matters: a record
   * that never decrypts keeps the doc from catching up, and must not keep
   * this device from sending for good.
   */
  accept?: (doc: LoroDoc) => boolean | undefined;
  /** `accept` said no. Nothing local was or will be sent. */
  onRefused?: () => void;
  /** A record could not be decrypted: wrong key, unsigned or tampered. */
  onDecryptError?: (error: Error) => void;
  /**
   * A record is sealed under a key generation this keyring does not reach:
   * the group rotated, and the new keys come with the new link, which the
   * member group delivers. The record is skipped here; it arrives again on
   * the connection that link opens.
   */
  onUnknownGeneration?: (generation: number) => void;
}

// Each send is one stored record, so at the default push throttle steady
// typing reaches 200 records in well under a minute. Exporting, encrypting
// and uploading a full snapshot runs on the main thread and grows with the
// project, so mid-session compaction waits a few minutes between rounds;
// the backlog it leaves is a few thousand small records at worst, which a
// joining client compacts right away.
const COMPACT_INTERVAL_MS = 5 * 60 * 1000;

// A local commit landing during every encryption could keep the pre-snapshot
// push going forever; past this many rounds the compaction waits for the
// next chance instead.
const SNAPSHOT_PUSH_ROUNDS = 5;

// One container per send keeps each update well under the server's limit
// for a reassembled update.
const CONTAINER_BUDGET = 1024 * 1024;

function counters(vv: VersionVector): Counters {
  return new Map(vv.toJSON());
}

function missingSpans(have: VersionVector, server: Counters): Span[] {
  const spans: Span[] = [];
  for (const [peer, end] of have.toJSON()) {
    const start = server.get(peer) ?? 0;
    if (end > start) spans.push({ peer, start, end });
  }
  return spans;
}

function holdsSnapshot(container: Uint8Array): boolean {
  try {
    return decodeEloContainer(container).some(
      (record) =>
        parseEloRecordHeader(record).header.kind === EloRecordKind.Snapshot,
    );
  } catch {
    return false;
  }
}

function raise(map: Counters, peer: PeerID, end: number) {
  if ((map.get(peer) ?? 0) < end) map.set(peer, end);
}

const decoder = new TextDecoder();

/** Server-provided `{"deltas": n}`; anything unexpected reads as 0. */
function storedDeltas(extra: Uint8Array | undefined): number {
  if (!extra?.length) return 0;
  try {
    const value = JSON.parse(decoder.decode(extra)) as { deltas?: unknown };
    return typeof value.deltas === "number" ? value.deltas : 0;
  } catch {
    return 0;
  }
}

/**
 * Syncs a LoroDoc over the `%ELO` CRDT type of the Loro Protocol: every op
 * leaves this client encrypted and signed (see `crypto/space-crypto.ts`),
 * and the server only sees which op
 * ranges (peer, counter span) a record covers so it can store, dedupe and
 * backfill without reading anything.
 *
 * Replaces `EloAdaptor` from loro-adaptors, which resolves "synced" before
 * its async decryption has imported the backfill, re-uploads a full snapshot
 * on every join, and resends nothing after a refused update until the next
 * reconnect.
 */
export class EncryptedDocAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.Elo;

  private readonly doc: LoroDoc;
  private readonly options: Required<
    Omit<
      EncryptedDocAdaptorOptions,
      "onDecryptError" | "onUnknownGeneration" | "accept" | "onRefused"
    >
  > &
    Pick<
      EncryptedDocAdaptorOptions,
      "onDecryptError" | "onUnknownGeneration" | "accept" | "onRefused"
    >;
  private ctx?: CrdtAdaptorContext;
  private unsubscribe?: () => void;
  private destroyed = false;
  private joined = false;
  /**
   * What the server holds as far as we know: its coverage at join, plus
   * what we sent or received since. Sending is optimistic; a refusal winds
   * it back.
   */
  private server: Counters = new Map();
  /** The server's coverage at the latest join; "synced" means reaching it. */
  private target: VersionVector | null = null;
  private targetReached = false;
  /** `accept` ran and allowed it; sticky across reconnects. */
  private accepted = false;
  private refused = false;
  private serverDeltas = 0;
  private snapshotSent = false;
  /** When the last compaction was started, for `compactIntervalMs`. */
  private lastCompactAt = 0;
  /** Pushes queued or running, which `hasPendingPush` has to cover. */
  private queuedPushes = 0;
  /** Set once the server refused a snapshot for a reason that will not pass. */
  private compactionRefused = false;
  /**
   * The keys are new, so a snapshot sealed under them is due whatever the
   * log length: until one is stored, a joiner finds history only under keys
   * the removed members hold.
   */
  private generationDue = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPageListeners?: () => void;
  // Encryption and decryption are async. Running every step through one
  // chain keeps sends in op order and imports in arrival order.
  private readonly enqueue = createSerialQueue("encrypted sync step failed");
  private readonly synced: Promise<void>;
  private resolveSynced!: () => void;

  constructor(doc: LoroDoc, options: EncryptedDocAdaptorOptions) {
    this.doc = doc;
    // Spelled out instead of spread over defaults: an option passed as
    // `undefined` would otherwise replace its default.
    this.options = {
      crypto: options.crypto,
      canWrite: options.canWrite && options.crypto.canWrite,
      compactAfterDeltas: options.compactAfterDeltas ?? 200,
      compactIntervalMs: options.compactIntervalMs ?? COMPACT_INTERVAL_MS,
      pushDelayMs: options.pushDelayMs ?? 150,
      retryMs: options.retryMs ?? 2000,
      compactOnJoin: options.compactOnJoin ?? false,
      onDecryptError: options.onDecryptError,
      onUnknownGeneration: options.onUnknownGeneration,
      accept: options.accept,
      onRefused: options.onRefused,
    };
    this.generationDue = this.options.compactOnJoin && this.options.canWrite;
    this.synced = new Promise((resolve) => {
      this.resolveSynced = resolve;
    });
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.unsubscribe?.();
    this.unsubscribe = this.options.canWrite
      ? this.doc.subscribeLocalUpdates(() => this.schedulePush())
      : undefined;
    // A tab being closed or backgrounded may never run the push timer.
    if (this.options.canWrite && !this.stopPageListeners) {
      this.stopPageListeners = onPageExit(() => {
        if (this.pushTimer !== null) void this.flush();
      });
    }
  }

  /**
   * Sends whatever local commits have not gone up yet. Resolves once they
   * were handed to the socket, after any push already queued.
   */
  flush(): Promise<void> {
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    return this.enqueuePush();
  }

  /**
   * True while local commits have not been handed to the socket: waiting
   * for the push timer, or for a push that is queued or still encrypting.
   */
  get hasPendingPush(): boolean {
    if (this.pushTimer !== null || this.queuedPushes > 0) return true;
    if (!this.mayPush()) return false;
    return missingSpans(this.doc.oplogVersion(), this.server).length > 0;
  }

  private enqueuePush(): Promise<void> {
    this.queuedPushes++;
    return this.enqueue(async () => {
      try {
        await this.push();
      } finally {
        this.queuedPushes--;
      }
    });
  }

  private schedulePush(): void {
    if (this.destroyed) return;
    if (this.options.pushDelayMs <= 0) {
      void this.enqueuePush();
      return;
    }
    // A throttle, not a debounce: steady typing still goes out every
    // pushDelayMs instead of waiting for a pause.
    if (this.pushTimer !== null) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.enqueuePush();
    }, this.options.pushDelayMs);
  }

  async handleJoinOk(res: JoinResponseOk): Promise<void> {
    if (this.destroyed) return;
    // Synchronous up to the first await on purpose: the client applies the
    // backfill right after calling us, and those imports must queue behind
    // this state.
    const version =
      res.version.length > 0
        ? VersionVector.decode(res.version)
        : new VersionVector(null);
    this.server = counters(version);
    this.target = version;
    this.targetReached = false;
    this.serverDeltas = storedDeltas(res.extra);
    // snapshotSent stays as it is: a compaction queued before the
    // reconnect still runs, and clears it once it is done.
    this.joined = true;
    this.judge(false);
    // Edits made offline (or before a reconnect) go up first.
    await this.enqueuePush();
    this.checkReached();
  }

  /** Nothing local goes up before `accept` allowed it, or after it said no. */
  private mayPush(): boolean {
    return (
      !this.destroyed &&
      this.joined &&
      this.options.canWrite &&
      this.accepted &&
      !this.refused
    );
  }

  /** Asks `accept` until it answers; see there. */
  private judge(reached: boolean): void {
    if (this.accepted || this.refused) return;
    const verdict = this.options.accept ? this.options.accept(this.doc) : true;
    if (verdict === false) {
      this.refused = true;
      // Left unresolved: the doc is not what the caller asked to open.
      this.options.onRefused?.();
    } else if (verdict === true || reached) {
      this.accepted = true;
      void this.enqueuePush();
    }
  }

  waitForReachingServerVersion(): Promise<void> {
    return this.synced;
  }

  applyUpdate(updates: Uint8Array[]): void {
    if (this.destroyed) return;
    for (const container of updates) {
      void this.enqueue(() => this.importContainer(container));
    }
  }

  onUpdateError(updates: Uint8Array[], errorCode: number): void {
    if (this.destroyed) return;
    const retryable =
      errorCode === UpdateStatusCode.RateLimited ||
      errorCode === UpdateStatusCode.FragmentTimeout ||
      errorCode === UpdateStatusCode.Unknown;
    if (!retryable) {
      console.error("server refused an encrypted update", errorCode);
      // Every delta a snapshot would replace is already stored, so only the
      // compaction is lost, and sending the next one would hit the same
      // limit.
      if (updates.some(holdsSnapshot)) this.compactionRefused = true;
      return;
    }
    // The ops are still in the doc; forget that the server has them so the
    // next push sends them again.
    for (const container of updates) {
      for (const record of decodeEloContainer(container)) {
        const { header } = parseEloRecordHeader(record);
        if (header.kind !== EloRecordKind.DeltaSpan) continue;
        const peer = decoder.decode(header.peerId) as PeerID;
        const known = this.server.get(peer) ?? 0;
        if (header.start < known) this.server.set(peer, header.start);
      }
    }
    if (this.retry !== null) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.enqueuePush();
    }, this.options.retryMs);
  }

  cmpVersion(v: Uint8Array): 0 | 1 | -1 | undefined {
    return this.doc.oplogVersion().compare(VersionVector.decode(v)) as
      0 | 1 | -1 | undefined;
  }

  getVersion(): Uint8Array {
    return this.doc.oplogVersion().encode();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopPageListeners?.();
    this.stopPageListeners = undefined;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.ctx = undefined;
  }

  /**
   * Sends every op the server does not have yet, as of when it starts.
   * Commits landing while it encrypts are left to the next push.
   */
  private async push(): Promise<void> {
    if (!this.mayPush()) return;
    const spans = missingSpans(this.doc.oplogVersion(), this.server);
    if (spans.length === 0) return;

    let batch: Uint8Array[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      this.ctx?.send([encodeEloContainer(batch)]);
      // Counted optimistically like `server`; a span the server already
      // holds is not stored again, so this can only run ahead of it, which
      // at worst compacts a little early.
      this.serverDeltas += batch.length;
      batch = [];
      size = 0;
    };
    for (const span of spans) {
      for (const [piece, plaintext] of this.exportSpan(span)) {
        const record = this.options.crypto.encryptDelta(piece, plaintext);
        if (size + record.length > CONTAINER_BUDGET) flush();
        batch.push(record);
        size += record.length;
        raise(this.server, piece.peer, piece.end);
      }
    }
    flush();
    this.maybeCompact(false);
  }

  /**
   * The span's updates, cut into pieces of at most CONTAINER_BUDGET where
   * the ops allow. A single record past the server's reassembly limit is
   * refused for good, which a long offline session or a bulk import could
   * otherwise produce. Same sizing as `encrypt_span` in the CLI's engine.
   */
  private exportSpan(span: Span): [Span, Uint8Array][] {
    const plaintext = this.doc.export({
      mode: "updates-in-range",
      spans: [
        {
          id: { peer: span.peer, counter: span.start },
          len: span.end - span.start,
        },
      ],
    });
    const ops = span.end - span.start;
    if (plaintext.length <= CONTAINER_BUDGET || ops === 1) {
      return [[span, plaintext]];
    }
    const pieces = Math.min(
      Math.ceil(plaintext.length / (CONTAINER_BUDGET / 2)),
      ops,
    );
    const step = Math.ceil(ops / pieces);
    const out: [Span, Uint8Array][] = [];
    for (let at = span.start; at < span.end; at += step) {
      const end = Math.min(at + step, span.end);
      out.push(...this.exportSpan({ peer: span.peer, start: at, end }));
    }
    return out;
  }

  private async importContainer(container: Uint8Array): Promise<void> {
    const plaintexts: Uint8Array[] = [];
    const received: Counters = new Map();
    for (const record of decodeEloContainer(container)) {
      try {
        const out = this.options.crypto.decryptRecord(record);
        plaintexts.push(out.plaintext);
        if (out.kind === "delta") {
          raise(received, out.peer as PeerID, out.end);
        } else {
          for (const { peer, counter } of out.vv) {
            raise(received, peer as PeerID, counter);
          }
        }
      } catch (error) {
        if (error instanceof UnknownGenerationError) {
          this.options.onUnknownGeneration?.(error.generation);
        } else {
          this.options.onDecryptError?.(toError(error));
        }
      }
    }
    if (this.destroyed || plaintexts.length === 0) return;
    try {
      this.doc.importBatch(plaintexts);
    } catch (error) {
      this.ctx?.onImportError(toError(error), [container]);
      return;
    }
    for (const [peer, end] of received) raise(this.server, peer, end);
    this.judge(false);
    this.checkReached();
  }

  private checkReached(): void {
    if (this.targetReached || !this.target || !this.joined) return;
    const cmp = this.doc.oplogVersion().compare(this.target);
    if (cmp === undefined || cmp < 0) return;
    this.targetReached = true;
    this.judge(true);
    if (this.refused) return;
    this.resolveSynced();
    void this.enqueuePush();
    this.maybeCompact(true);
  }

  private maybeCompact(afterJoin: boolean): void {
    if (
      !this.mayPush() ||
      // Before the backfill is in, a snapshot would miss ops the server
      // holds, and the server would drop it.
      !this.targetReached ||
      this.compactionRefused ||
      this.snapshotSent ||
      (!this.generationDue &&
        this.serverDeltas < this.options.compactAfterDeltas)
    )
      return;
    const now = Date.now();
    if (
      !afterJoin &&
      !this.generationDue &&
      now - this.lastCompactAt < this.options.compactIntervalMs
    )
      return;
    this.lastCompactAt = now;
    this.snapshotSent = true;
    this.generationDue = false;
    void this.enqueue(() => this.sendSnapshot());
  }

  /**
   * The server swaps its deltas for a snapshot only when the snapshot covers
   * everything it holds, so pending local ops go up first and the snapshot
   * is taken right after.
   */
  private async sendSnapshot(): Promise<void> {
    try {
      await this.uploadSnapshot();
    } finally {
      // Lets the log compact again once it regrows, also after a failed
      // attempt.
      this.snapshotSent = false;
    }
  }

  private async uploadSnapshot(): Promise<void> {
    // The server takes the snapshot's version as covered and drops (and
    // never relays) deltas inside it afterwards, while the snapshot itself
    // only goes to later joiners. So every op in it must have gone out as a
    // delta first, and push() leaves out commits made while it encrypts.
    // Checking and exporting in one synchronous step pins the snapshot to
    // exactly what was sent.
    for (let round = 0; ; round++) {
      await this.push();
      // A compaction queued before a reconnect would otherwise go out
      // before the new backfill is in, and miss ops the server holds.
      if (this.destroyed || !this.joined || !this.targetReached) return;
      if (missingSpans(this.doc.oplogVersion(), this.server).length === 0)
        break;
      if (round + 1 >= SNAPSHOT_PUSH_ROUNDS) return;
    }
    // Unsorted on purpose: the wasm sorts the header's entries by peer id
    // bytes.
    const vv = [...this.doc.oplogVersion().toJSON()].map(([peer, counter]) => ({
      peer,
      counter,
    }));
    const snapshot = this.doc.export({ mode: "snapshot" });
    const record = this.options.crypto.encryptSnapshot(vv, snapshot);
    this.ctx?.send([encodeEloContainer([record])]);
    this.serverDeltas = 0;
  }
}
