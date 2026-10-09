import type { EphemeralStore } from "loro-crdt";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "loro-adaptors";
import { CrdtType } from "loro-protocol";

import {
  PRESENCE_CONTEXT,
  open,
  seal,
  type ProjectKey,
} from "@/crypto/project-key";
import { toError } from "@/lib/errors";
import { createSerialQueue } from "@/lib/serial-queue";

/**
 * Presence over the `%EPH` room, end-to-end encrypted. The server only
 * relays opaque blobs and keeps the latest one per connection for late
 * joiners, so each blob has to stand on its own: it is always this client's
 * own complete state (presence only ever sets its own `p:<peer>` key, with
 * the whole value), never other peers' entries.
 *
 * Unlike upstream `LoroEphemeralAdaptor`, `destroy()` leaves the store
 * alone: the caller owns it and may reconnect with the same instance (React
 * StrictMode remounts do exactly that).
 */
export class EphemeralStoreAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.LoroEphemeralStore;

  private readonly store: EphemeralStore;
  private readonly key: ProjectKey;
  private ctx?: CrdtAdaptorContext;
  private unsubscribe?: () => void;
  private destroyed = false;
  /** Our latest local update, resent on (re)join. */
  private latest: Uint8Array | null = null;
  // Keeps sends and applies in order across the async crypto.
  private readonly enqueue = createSerialQueue("presence sync step failed");

  constructor(store: EphemeralStore, key: ProjectKey) {
    this.store = store;
    this.key = key;
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.unsubscribe?.();
    this.unsubscribe = this.store.subscribeLocalUpdates((update) => {
      if (this.destroyed) return;
      this.latest = update;
      this.send(update);
    });
  }

  async handleJoinOk(): Promise<void> {
    if (this.destroyed || !this.ctx) return;
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
          const update = await open(this.key, sealed, PRESENCE_CONTEXT);
          if (!this.destroyed) this.store.apply(update);
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
    this.ctx = undefined;
  }

  private send(update: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      const sealed = await seal(this.key, update, PRESENCE_CONTEXT);
      if (!this.destroyed) this.ctx?.send([sealed]);
    });
  }
}
