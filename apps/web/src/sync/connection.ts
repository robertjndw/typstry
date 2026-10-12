// Live sync of a project's LoroDoc (and optionally its presence store) with
// crates/typstry-server over the Loro Protocol. Both rooms share one socket
// and use the project id as room id; the share token is the join auth.
// Everything is encrypted with the project's keys before it leaves the page.
import type { EphemeralStore, LoroDoc } from "loro-crdt";
import {
  LoroWebsocketClient,
  type ClientStatusValue,
  type LoroWebsocketClientRoom,
  type RoomJoinStatusValue,
} from "loro-websocket";
import { toError } from "@/lib/errors";

import {
  EncryptedDocAdaptor,
  type RecordCrypto,
} from "./encrypted-doc-adaptor";
import {
  EphemeralStoreAdaptor,
  type PresenceCrypto,
} from "./ephemeral-adaptor";
import { fetchServerInfo, isOutdated, socketUrl } from "./protocol";

export type SyncStatus = "connecting" | "connected" | "disconnected";

/** "offline": the server could not be reached in time; edits stay queued. */
export type SyncNowResult = "synced" | "offline";

const SYNC_NOW_TIMEOUT_MS = 5000;

/**
 * A failing socket checks /api/info at most this often. Reconnects back off
 * to 15 s, so that is one request every couple of attempts.
 */
const OUTDATED_CHECK_MS = 30_000;

const RETIRED_CHECK_MS = 2000;

export interface ConnectOptions {
  spaceId: string;
  /** Edit or view token; the server derives the permission from it. */
  token: string;
  crypto: RecordCrypto & PresenceCrypto;
  /** False for view links, which must not try to upload anything. */
  canWrite: boolean;
  doc: LoroDoc;
  ephemeral?: EphemeralStore;
  /** Defaults to `/ws` on the page's origin. */
  url?: string;
  onError?: (error: Error) => void;
  /** Received data does not decrypt with `crypto`. */
  onDecryptError?: (error: Error) => void;
  /**
   * Received data is sealed under a key generation `crypto` lacks: the
   * group rotated, and its new links are what open it.
   */
  onUnknownGeneration?: (generation: number) => void;
  /** The server no longer serves this build. Syncing has already stopped. */
  onOutdated?: () => void;
  /** Whether the server refuses this build; replaceable for tests. */
  checkOutdated?: () => Promise<boolean>;
  /**
   * The link was replaced by a rotation, so the server closed the doc
   * socket for good. Syncing has already stopped; follow the group to find
   * the new links.
   */
  onRetired?: () => void;
  /**
   * Whether `token` was retired. The browser does not tell a socket's close
   * code apart from any other failure, so this asks the server.
   */
  checkRetired?: () => Promise<boolean>;
  /**
   * Whether the space's doc is what the caller meant to open, asked before
   * this device uploads anything; see EncryptedDocAdaptorOptions.accept.
   */
  accept?: (doc: LoroDoc) => boolean | undefined;
  /**
   * `accept` said no. Nothing was uploaded and syncing has already
   * stopped.
   */
  onRefused?: () => void;
  /** Upload a snapshot right after joining: a rotation just moved the keys. */
  compactOnJoin?: boolean;
}

export interface SpaceConnection {
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

/**
 * loro-websocket reports a join sent before the socket is open as an error,
 * but it also queues the join and sends it once the socket opens. Every
 * join made while connecting hits this, so there is nothing to report.
 */
function isQueuedJoin(error: Error): boolean {
  return error.message === "WebSocket not open during join";
}

export function projectWsUrl(loc: Pick<Location, "protocol" | "host">): string {
  return socketUrl(loc, "/ws");
}

export function connectSpace(opts: ConnectOptions): SpaceConnection {
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

  const onError = opts.onError;
  const client = new LoroWebsocketClient({
    url,
    onError: onError
      ? (error) => {
          if (!isQueuedJoin(error)) onError(error);
        }
      : undefined,
  });
  const docAdaptor = new EncryptedDocAdaptor(opts.doc, {
    crypto: opts.crypto,
    canWrite: opts.canWrite,
    onDecryptError: opts.onDecryptError,
    onUnknownGeneration: opts.onUnknownGeneration,
    compactOnJoin: opts.compactOnJoin,
    accept: opts.accept,
    onRefused: () => {
      if (finished) return;
      fail();
      opts.onRefused?.();
    },
  });
  const ephemeralAdaptor = opts.ephemeral
    ? new EphemeralStoreAdaptor(opts.ephemeral, opts.crypto)
    : undefined;

  const fail = () => {
    if (finished) return;
    finished = true;
    update();
    shutdown();
  };

  // The server answers an outdated client's handshake with a 426, but the
  // browser reports that as a plain failed socket, same as being offline.
  // So after a failure we ask /api/info and stop retrying if we're too old.
  const checkOutdated =
    opts.checkOutdated ?? (async () => isOutdated(await fetchServerInfo()));
  let lastCheck = -Infinity;
  const onDisconnect = () => {
    const now = Date.now();
    if (now - lastCheck < OUTDATED_CHECK_MS) return;
    lastCheck = now;
    void checkOutdated().then(
      (outdated) => {
        if (!outdated || finished) return;
        fail();
        opts.onOutdated?.();
      },
      () => {},
    );
  };

  // The server ends a retired token's doc sockets with a code the page
  // cannot read, so each drop asks whether that is why. Throttled, since a
  // flaky connection drops often.
  let lastRetiredCheck = -Infinity;
  const checkRetired = opts.checkRetired;
  const onDropped = () => {
    if (!checkRetired) return;
    const now = Date.now();
    if (now - lastRetiredCheck < RETIRED_CHECK_MS) return;
    lastRetiredCheck = now;
    void checkRetired().then(
      (retired) => {
        if (!retired || finished) return;
        fail();
        opts.onRetired?.();
      },
      () => {},
    );
  };

  const stopSocketStatus = client.onStatusChange((s) => {
    socket = s;
    if (s === "disconnected" && !finished) {
      onDisconnect();
      onDropped();
    }
    update();
  });

  const docJoin: Promise<LoroWebsocketClientRoom> = client.join({
    roomId: opts.spaceId,
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
        roomId: opts.spaceId,
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
      // Commits not yet handed to the socket (waiting for the push timer,
      // queued, or still encrypting) would otherwise only go up on the next
      // visit, since destroy() makes a running push give up. Encrypting them
      // takes a moment, so the socket stays open until then.
      if (docAdaptor.hasPendingPush) void docAdaptor.flush().finally(shutdown);
      else shutdown();
    },
  };
}
