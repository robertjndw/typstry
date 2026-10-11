import { EphemeralStore } from "loro-crdt";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "loro-adaptors";
import { CrdtType } from "loro-protocol";

import { toHex } from "@/crypto/bytes";
import type { ProjectCrypto } from "@/crypto/project-crypto";
import { toError } from "@/lib/errors";
import { createSerialQueue } from "@/lib/serial-queue";

const RESEND_MS = 2000;
// Long enough that nothing expires between applying an update and reading its keys.
const SCRATCH_TIMEOUT_MS = 60_000;

/**
 * Presence over the `%EPH` room, end-to-end encrypted. The server only
 * relays opaque blobs and keeps the latest one per connection for late
 * joiners, so each blob has to stand on its own: it is always this client's
 * own complete state (presence only ever sets its own `p:<peer>` key, with
 * the whole value), never other peers' entries.
 *
 * Presence is sealed under the key of the group's current epoch, so a member
 * who is removed stops being able to read it with the next epoch. Updates
 * sealed under another epoch are dropped: they are stale, or from a member
 * who is ahead of us and will resend once we catch up. When the key changes
 * our latest state goes out again under the new one, since nobody can read
 * the old blob any more.
 *
 * Unlike upstream `LoroEphemeralAdaptor`, `destroy()` leaves the store
 * alone: the caller owns it and may reconnect with the same instance (React
 * StrictMode remounts do exactly that).
 */
export class EphemeralStoreAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.LoroEphemeralStore;

  private readonly store: EphemeralStore;
  private readonly crypto: ProjectCrypto;
  private ctx?: CrdtAdaptorContext;
  private unsubscribe?: () => void;
  private stopKeyListener?: () => void;
  private destroyed = false;
  private joined = false;
  private resend: ReturnType<typeof setTimeout> | null = null;
  /** Our latest local update, resent on (re)join and when the key changes. */
  private latest: Uint8Array | null = null;
  // Keeps sends and applies in order across the async crypto.
  private readonly enqueue = createSerialQueue("presence sync step failed");

  constructor(store: EphemeralStore, crypto: ProjectCrypto) {
    this.store = store;
    this.crypto = crypto;
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.unsubscribe?.();
    this.unsubscribe = this.store.subscribeLocalUpdates((update) => {
      if (this.destroyed) return;
      this.latest = update;
      this.send(update);
    });
    this.stopKeyListener?.();
    this.stopKeyListener = this.crypto.onChange(() => {
      if (this.destroyed || !this.joined || !this.latest) return;
      void this.send(this.latest);
      // Around a join, members move to the new epoch at slightly different
      // moments, and what a member sends before the others got there is
      // dropped. Sending once more shortly after catches the stragglers
      // without waiting for the next refresh.
      if (this.resend !== null) clearTimeout(this.resend);
      this.resend = setTimeout(() => {
        this.resend = null;
        if (!this.destroyed && this.latest) void this.send(this.latest);
      }, RESEND_MS);
    });
  }

  async handleJoinOk(): Promise<void> {
    if (this.destroyed || !this.ctx) return;
    this.joined = true;
    // Announce ourselves to peers who joined before us.
    if (this.latest) await this.send(this.latest);
  }

  waitForReachingServerVersion(): Promise<void> {
    return Promise.resolve();
  }

  applyUpdate(updates: Uint8Array[]): void {
    if (this.destroyed) return;
    for (const sealed of updates) {
      if (sealed.length === 0) continue;
      this.enqueue(async () => {
        try {
          let signer: Uint8Array | null = null;
          const update = this.crypto.openPresence(sealed, (s) => (signer = s));
          if (!update || this.destroyed) return;
          if (signer && this.claimsBoundPeer(update, signer)) return;
          this.store.apply(update);
        } catch (error) {
          this.ctx?.onImportError(toError(error), [sealed]);
        }
      });
    }
  }

  cmpVersion(): 0 {
    return 0;
  }

  getVersion(): Uint8Array {
    return new Uint8Array();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopKeyListener?.();
    this.stopKeyListener = undefined;
    if (this.resend !== null) clearTimeout(this.resend);
    this.resend = null;
    this.ctx = undefined;
  }

  /**
   * Whether the update sets a `p:<peer>` entry of a peer that records
   * proved to belong to another device. Presence is signed by whoever sends
   * it but says whatever it likes, so such an update is somebody posing as
   * that peer and is dropped whole.
   */
  private claimsBoundPeer(update: Uint8Array, signer: Uint8Array): boolean {
    const { signers } = this.crypto;
    // Nothing bound yet, so nothing to pose as.
    if (signers.size === 0) return false;
    const signerHex = toHex(signer);
    const scratch = new EphemeralStore(SCRATCH_TIMEOUT_MS);
    try {
      scratch.apply(update);
      return scratch
        .keys()
        .some(
          (key) =>
            key.startsWith("p:") && signers.conflicts(key.slice(2), signerHex),
        );
    } finally {
      scratch.destroy();
    }
  }

  private send(update: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      if (this.destroyed) return;
      this.ctx?.send([this.crypto.sealPresence(update)]);
    });
  }
}
