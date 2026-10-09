import { VersionVector, type LoroDoc, type PeerID } from "loro-crdt";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "loro-adaptors";
import {
  CrdtType,
  EloRecordKind,
  UpdateStatusCode,
  decodeEloContainer,
  decryptEloRecord,
  encodeEloContainer,
  encryptDeltaSpan,
  encryptSnapshot,
  parseEloRecordHeader,
  type JoinResponseOk,
} from "loro-protocol";

import { KeyMismatchError, type ProjectKey } from "@/crypto/project-key";
import { toError } from "@/lib/errors";
import { createSerialQueue } from "@/lib/serial-queue";

/** Per peer, the end of the op counter range known to be stored. */
type Counters = Map<PeerID, number>;

interface Span {
  peer: PeerID;
  start: number;
  end: number;
}

export interface EncryptedDocAdaptorOptions {
  key: ProjectKey;
  /** View links never send: the server refuses their doc updates anyway. */
  canWrite: boolean;
  /**
   * Upload a compaction snapshot once the server reports holding this many
   * delta records. The server cannot compact what it cannot read, so
   * writers do it for it.
   */
  compactAfterDeltas?: number;
  /** Delay before resending spans the server refused for a passing reason. */
  retryMs?: number;
  /** A record could not be decrypted: wrong key, or tampered data. */
  onDecryptError?: (error: Error) => void;
}

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

function raise(map: Counters, peer: PeerID, end: number) {
  if ((map.get(peer) ?? 0) < end) map.set(peer, end);
}

const encoder = new TextEncoder();
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
 * leaves this client AES-GCM encrypted, and the server only sees which op
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
    Omit<EncryptedDocAdaptorOptions, "onDecryptError">
  > &
    Pick<EncryptedDocAdaptorOptions, "onDecryptError">;
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
  private serverDeltas = 0;
  private snapshotSent = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  // Encryption and decryption are async. Running every step through one
  // chain keeps sends in op order and imports in arrival order.
  private readonly enqueue = createSerialQueue("encrypted sync step failed");
  private readonly synced: Promise<void>;
  private resolveSynced!: () => void;

  constructor(doc: LoroDoc, options: EncryptedDocAdaptorOptions) {
    this.doc = doc;
    this.options = {
      compactAfterDeltas: 200,
      retryMs: 2000,
      ...options,
    };
    this.synced = new Promise((resolve) => {
      this.resolveSynced = resolve;
    });
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.unsubscribe?.();
    this.unsubscribe = this.options.canWrite
      ? this.doc.subscribeLocalUpdates(() => this.enqueue(() => this.push()))
      : undefined;
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
    this.snapshotSent = false;
    this.joined = true;
    // Edits made offline (or before a reconnect) go up first.
    await this.enqueue(() => this.push());
    this.checkReached();
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
      void this.enqueue(() => this.push());
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
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.ctx = undefined;
  }

  /** Sends every op the server does not have yet. */
  private async push(): Promise<void> {
    if (this.destroyed || !this.joined || !this.options.canWrite) return;
    const spans = missingSpans(this.doc.oplogVersion(), this.server);
    if (spans.length === 0) return;

    const { key, keyId } = this.options.key;
    let batch: Uint8Array[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      this.ctx?.send([encodeEloContainer(batch)]);
      batch = [];
      size = 0;
    };
    for (const span of spans) {
      const plaintext = this.doc.export({
        mode: "updates-in-range",
        spans: [
          {
            id: { peer: span.peer, counter: span.start },
            len: span.end - span.start,
          },
        ],
      });
      const { record } = await encryptDeltaSpan(
        plaintext,
        {
          peerId: encoder.encode(span.peer),
          start: span.start,
          end: span.end,
          keyId,
        },
        key,
      );
      if (this.destroyed) return;
      if (size + record.length > CONTAINER_BUDGET) flush();
      batch.push(record);
      size += record.length;
      raise(this.server, span.peer, span.end);
    }
    flush();
  }

  private async importContainer(container: Uint8Array): Promise<void> {
    const { key, keyId } = this.options.key;
    const plaintexts: Uint8Array[] = [];
    const received: Counters = new Map();
    for (const record of decodeEloContainer(container)) {
      try {
        const out = await decryptEloRecord(record, async (recordKeyId) => {
          if (recordKeyId !== keyId) throw new KeyMismatchError(recordKeyId);
          return key;
        });
        plaintexts.push(out.plaintext);
        if (out.kind === EloRecordKind.DeltaSpan) {
          raise(
            received,
            decoder.decode(out.header.peerId) as PeerID,
            out.header.end,
          );
        } else {
          for (const { peerId, counter } of out.header.vv) {
            raise(received, decoder.decode(peerId) as PeerID, counter);
          }
        }
      } catch (error) {
        this.options.onDecryptError?.(toError(error));
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
    this.checkReached();
  }

  private checkReached(): void {
    if (this.targetReached || !this.target || !this.joined) return;
    const cmp = this.doc.oplogVersion().compare(this.target);
    if (cmp === undefined || cmp < 0) return;
    this.targetReached = true;
    this.resolveSynced();
    this.maybeCompact();
  }

  private maybeCompact(): void {
    if (
      !this.options.canWrite ||
      this.snapshotSent ||
      this.serverDeltas < this.options.compactAfterDeltas
    )
      return;
    this.snapshotSent = true;
    void this.enqueue(() => this.sendSnapshot());
  }

  /**
   * The server swaps its deltas for a snapshot only when the snapshot covers
   * everything it holds, so pending local ops go up first and the snapshot
   * is taken right after.
   */
  private async sendSnapshot(): Promise<void> {
    await this.push();
    if (this.destroyed || !this.joined) return;
    const vv = [...this.doc.oplogVersion().toJSON()]
      // The protocol wants entries sorted by peer id bytes; peer ids are
      // ASCII digits, so string order is byte order.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([peer, counter]) => ({ peerId: encoder.encode(peer), counter }));
    const { record } = await encryptSnapshot(
      this.doc.export({ mode: "snapshot" }),
      { vv, keyId: this.options.key.keyId },
      this.options.key.key,
    );
    if (this.destroyed) return;
    this.ctx?.send([encodeEloContainer([record])]);
    this.serverDeltas = 0;
  }
}
