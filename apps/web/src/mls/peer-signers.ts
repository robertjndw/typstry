import { useSyncExternalStore } from "react";

import { toHex } from "@/crypto/bytes";

/**
 * Which device key signed what a Loro peer wrote, learned from the signed
 * records that decrypted. Peer ids are random per page load and mean nothing
 * by themselves; this is what ties them to a member of the group, whose
 * profile is authenticated.
 *
 * Only records bind a peer. A presence update is signed too, but the peer
 * ids inside it are whatever its author put there, so any member could
 * announce itself as somebody else's peer and take their name. Presence is
 * checked against these bindings instead (see `conflicts`).
 *
 * The first signer seen for a peer wins. A later record that claims the
 * same peer under another key is some other member trying to pass as it,
 * and must not take the name over.
 */
export class PeerSigners {
  private readonly signers = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  record(peer: string, signer: Uint8Array): void {
    if (this.signers.has(peer)) return;
    this.signers.set(peer, toHex(signer));
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  /** Whether `peer` is bound to a signer other than `signer` (hex). */
  conflicts(peer: string, signer: string): boolean {
    const bound = this.signers.get(peer);
    return bound !== undefined && bound !== signer;
  }

  get size(): number {
    return this.signers.size;
  }

  /** Hex of the signer's public key. */
  get(peer: string): string | undefined {
    return this.signers.get(peer);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever an entry is added, for `useSyncExternalStore`. */
  getVersion = (): number => this.version;
}

/** Re-renders when `signers` learns of a new peer. */
export function usePeerSignersVersion(signers: PeerSigners): number {
  return useSyncExternalStore(signers.subscribe, signers.getVersion);
}
