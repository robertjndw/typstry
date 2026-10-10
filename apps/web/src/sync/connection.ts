// Live sync of a project's LoroDoc (and optionally its presence store) with
// crates/typstry-server over the Loro Protocol. Both rooms share one socket
// and use the project id as room id; the share token is the join auth.
// Everything is encrypted with the project key before it leaves the page.
import type { EphemeralStore, LoroDoc } from "loro-crdt";
import {
  LoroWebsocketClient,
  type ClientStatusValue,
  type LoroWebsocketClientRoom,
  type RoomJoinStatusValue,
} from "loro-websocket";
import type { ProjectKey } from "@/crypto/project-key";
import { toError } from "@/lib/errors";

import { EncryptedDocAdaptor } from "./encrypted-doc-adaptor";
import { EphemeralStoreAdaptor } from "./ephemeral-adaptor";

export type SyncStatus = "connecting" | "connected" | "disconnected";

/** "offline": the server could not be reached in time; edits stay queued. */
export type SyncNowResult = "synced" | "offline";

const SYNC_NOW_TIMEOUT_MS = 5000;

export interface ConnectOptions {
  projectId: string;
  /** Edit or view token; the server derives the permission from it. */
  token: string;
  key: ProjectKey;
  /** False for view links, which must not try to upload anything. */
  canWrite: boolean;
  doc: LoroDoc;
  ephemeral?: EphemeralStore;
  /** Defaults to `/ws` on the page's origin. */
  url?: string;
  onError?: (error: Error) => void;
  /** Received data does not decrypt with `key`. */
  onDecryptError?: (error: Error) => void;
}

export interface ProjectConnection {
  getStatus(): SyncStatus;
  /** Calls `listener` with the current status right away, then on change. */
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /**
   * Resolves once the doc holds everything the server had when the first
   * join succeeded. Rejects if that join fails (e.g. an unknown token).
   */
  readonly synced: Promise<void>;
  /**
   * Reconnects right away if the socket is down (skipping the backoff),
   * sends every pending edit and waits for the server to have received them.
   */
  syncNow(timeoutMs?: number): Promise<SyncNowResult>;
  /** Stops syncing for good. The doc and the store stay usable. */
  close(): void;
}

export function projectWsUrl(loc: Pick<Location, "protocol" | "host">): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
}

export function connectProject(opts: ConnectOptions): ProjectConnection {
  const url = opts.url ?? projectWsUrl(window.location);
  const auth = new TextEncoder().encode(opts.token);
  const listeners = new Set<(status: SyncStatus) => void>();

  let socket: ClientStatusValue = "connecting";
  let docRoom: RoomJoinStatusValue = "connecting";
  // A rejected join (bad token) or a closed connection never recovers.
  let finished = false;
  let status: SyncStatus = "connecting";

  const update = () => {
    const next: SyncStatus =
      finished || socket === "disconnected"
        ? "disconnected"
        : socket === "connected" && docRoom === "joined"
          ? "connected"
          : "connecting";
    if (next === status) return;
    status = next;
    for (const listener of [...listeners]) listener(status);
  };

  const client = new LoroWebsocketClient({ url, onError: opts.onError });
  const docAdaptor = new EncryptedDocAdaptor(opts.doc, {
    key: opts.key,
    canWrite: opts.canWrite,
    onDecryptError: opts.onDecryptError,
  });
  const ephemeralAdaptor = opts.ephemeral
    ? new EphemeralStoreAdaptor(opts.ephemeral, opts.key)
    : undefined;

  const stopSocketStatus = client.onStatusChange((s) => {
    socket = s;
    update();
  });

  const fail = () => {
    if (finished) return;
    finished = true;
    update();
    shutdown();
  };

  const docJoin: Promise<LoroWebsocketClientRoom> = client.join({
    roomId: opts.projectId,
    crdtAdaptor: docAdaptor,
    auth,
    onStatusChange: (s) => {
      docRoom = s;
      if (s === "error") fail();
      else update();
    },
  });
  // Without this, a failed join would also surface as an unhandled rejection
  // when nobody awaits `synced`.
  docJoin.catch(fail);

  if (ephemeralAdaptor) {
    client
      .join({
        roomId: opts.projectId,
        crdtAdaptor: ephemeralAdaptor,
        auth,
      })
      .catch((error: unknown) => {
        opts.onError?.(toError(error));
      });
  }

  const synced = docJoin.then((room) => room.waitForReachingServerVersion());
  synced.catch(() => {});

  const untilConnected = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (status === "connected") return resolve(true);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const listener = (s: SyncStatus) => {
        if (s === "connected") done(true);
      };
      listeners.add(listener);
    });

  async function syncNow(
    timeoutMs = SYNC_NOW_TIMEOUT_MS,
  ): Promise<SyncNowResult> {
    if (finished) return "offline";
    if (socket !== "connected") client.retryNow().catch(() => {});
    if (!(await untilConnected(timeoutMs))) return "offline";
    try {
      await docAdaptor.flush();
      // The socket is ordered, so a pong means the server has read every
      // update sent before the ping.
      await client.ping(timeoutMs);
      return "synced";
    } catch {
      return "offline";
    }
  }

  function shutdown() {
    stopSocketStatus();
    // Destroying the adaptors only unsubscribes them from the doc and store;
    // the server forgets our rooms when the socket closes.
    docAdaptor.destroy();
    ephemeralAdaptor?.destroy();
    client.destroy();
  }

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    synced,
    syncNow,
    close() {
      if (finished) return;
      finished = true;
      update();
      listeners.clear();
      shutdown();
    },
  };
}
