import type { EphemeralStore, LoroDoc } from "loro-crdt";

import {
  CryptoError,
  NewerVersionError,
  type SpaceCrypto,
} from "@/crypto/space-crypto";
import { isEditSecret, secretKind } from "@/crypto/secret";
import { loadWasm } from "@/crypto/wasm";
import { localIdentity, mergeOwnGraph } from "@/mls/identity";
import {
  IDLE,
  MlsSession,
  type GroupKeys,
  type MlsSnapshot,
} from "@/mls/session";
import {
  defaultBackend,
  LocalDocStore,
  type StoredRotation,
} from "@/persist/local-doc-store";
import type { Identity } from "@/presence/identity";
import {
  ApiError,
  fetchMlsBootstrap,
  OutdatedClientError,
  resolveShare,
  type ShareInfo,
} from "@/sync/api";
import {
  connectSpace,
  type SyncNowResult,
  type SyncStatus,
} from "@/sync/connection";
import { RELOAD_MESSAGE } from "@/sync/protocol";

import { NO_KEYS, NoKeyringError, openCrypto } from "./open-crypto";
import {
  forgetShare,
  loadShare,
  loadSpaceKey,
  rememberShare,
  saveKeyring,
  saveSpaceKey,
  storeRotation,
} from "./space-links";

const SLOW_SYNC_MS = 15_000;
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

// These say "project" because a project is the only kind of space people
// see so far.
const WRONG_KEY =
  "This link's key does not match the project. Check that the link was copied completely, including the part after #.";
export const TOO_NEW =
  "This project was saved by a newer version of typstry. Reload the page to update.";
const UNREACHABLE = "The server could not be reached.";
export const LINK_REPLACED =
  "This link was replaced, and this browser has no way to find the new one. Ask someone in the project for the current link.";

/** The links the space moved to; the page should open them. */
export interface FollowedLinks {
  token: string;
  /** The secret for the URL fragment. */
  link: string;
}

/** What is known about a space before anything doc-specific is. */
export type SpacePhase =
  | { phase: "resolving" }
  | { phase: "not-found" }
  /** The link lacks its `#key` and this browser never saw the space. */
  | { phase: "missing-key" }
  | { phase: "error"; message: string }
  /** The group removed this device. Its links stopped working. */
  | { phase: "removed" }
  | { phase: "syncing"; share: ShareInfo; slow: boolean }
  /** Loaded from this browser or synced; the keys are open. */
  | { phase: "opened"; share: ShareInfo; crypto: SpaceCrypto; synced: boolean };

export interface SpaceSnapshot {
  phase: SpacePhase;
  /** `undefined` while resolving, `null` when the server does not know it. */
  share: ShareInfo | null | undefined;
  crypto: SpaceCrypto | null;
  /** Loaded from this browser or synced. */
  opened: boolean;
  /** The server's data is in the doc. */
  synced: boolean;
  /** Connecting takes suspiciously long. */
  slow: boolean;
  status: SyncStatus;
  /**
   * The server refused local edits for good on this connection, said for
   * people; null while all is well. They stay in this browser.
   */
  syncProblem: string | null;
  followed: FollowedLinks | null;
  /** The member group; null until the share is known. */
  mls: MlsSession | null;
}

export interface SpaceSessionOptions {
  /** Edit or view token. Changes through `setTarget`. */
  token: string;
  /** The secret from the URL fragment, if the link had one. */
  linkKey: string | null;
  doc: LoroDoc;
  /** Without it no presence is synced. */
  ephemeral?: EphemeralStore;
  /** The profile to put in this device's leaf. */
  identity: Identity;
  /**
   * Whether the session saves the doc in this browser under the space id.
   * Off when the caller already persists the doc itself (the directory
   * does), so two stores never write the same doc. Then the doc counts as
   * loaded from the start. Defaults to on.
   */
  persist?: boolean;
  /**
   * Whether the space's doc is the kind the caller expects, asked before
   * this device uploads anything (see EncryptedDocAdaptorOptions.accept);
   * on false nothing is uploaded and the session ends in an error phase.
   */
  accept?: (doc: LoroDoc) => boolean | undefined;
  /** What the error phase says after a refusal. */
  refusedMessage?: string;
  /** After a refusal, once the error phase is set. */
  onRefused?: () => void;
  /**
   * A rotation was made or learned here and its links are stored already;
   * remember whatever else belongs to the space. `replaced` is the token the
   * session was on when the rotation happened.
   */
  onRotated?: (
    rotation: StoredRotation,
    spaceId: string,
    replaced: string,
  ) => void;
}

interface State {
  share: ShareInfo | null | undefined;
  error: string | null;
  /**
   * The share lookup failed and nothing cached stands in. Kept apart from
   * `error` because it clears itself once a retry gets through.
   */
  unreachable: boolean;
  crypto: SpaceCrypto | null;
  loadedLocally: boolean;
  synced: boolean;
  slow: boolean;
  status: SyncStatus;
  syncProblem: string | null;
  followed: FollowedLinks | null;
  mls: MlsSession | null;
  mlsSnapshot: MlsSnapshot;
}

function sameShare(a: ShareInfo | null | undefined, b: ShareInfo | null) {
  if (!a || !b) return a === b;
  return (
    a.spaceId === b.spaceId &&
    a.permission === b.permission &&
    a.viewToken === b.viewToken &&
    a.retired === b.retired
  );
}

/** Why the server refused local edits, for people. */
function refusedText(reason: string): string {
  if (reason === "permission_denied")
    return "The server no longer takes edits from this link. Your changes are kept in this browser.";
  if (reason === "malformed_record")
    return "Some changes could not be encrypted for upload. They are kept in this browser.";
  if (reason === "payload_too_large")
    return "Some changes are too large for the server. They are kept in this browser.";
  return "The server refused some changes. They are kept in this browser.";
}

/** What to tell the user when the space's keys would not open. */
function openError(error: unknown): string {
  if (error instanceof NewerVersionError) return TOO_NEW;
  if (error instanceof NoKeyringError) return NO_KEYS;
  if (error instanceof ApiError) return "This project could not be opened.";
  // A link of another space fails the keyring's signature check or its
  // key match; anything else typed is this family too.
  if (error instanceof CryptoError) return WRONG_KEY;
  return "This project could not be opened.";
}

/**
 * Opens a space from a share token and the key from the link fragment and
 * keeps its doc synced and saved in this browser while started. A space this
 * browser has opened before opens from local storage right away, without the
 * server. The doc belongs to one space for good; the doc and the member
 * group outlive a stop/start cycle (React StrictMode does one), only the
 * socket and the local store binding are re-created.
 *
 * Holds no resources until `start`, so building one during render is safe.
 */
export class SpaceSession {
  private token: string;
  private linkKey: string | null;
  private identity: Identity;
  private readonly opts: SpaceSessionOptions;
  private s: State;
  private snap: SpaceSnapshot;
  private readonly listeners = new Set<() => void>();
  private running = false;
  private resolving: AbortController | null = null;
  private cancelRetry: (() => void) | null = null;
  /** A rotation happened here, so the next connection uploads a snapshot. */
  private rotated = false;
  private unwatchMls: (() => void) | null = null;
  private mlsRun = 0;
  private mlsSpaceId = "";
  private mlsStarted: { mls: MlsSession; token: string; key: string } | null =
    null;
  private keysBound: { mls: MlsSession; crypto: SpaceCrypto } | null = null;
  private unbindKeys: (() => void) | null = null;
  private opened = "";
  private teardown: (() => void) | null = null;
  private flushAndSync: (() => Promise<SyncNowResult>) | null = null;
  private reconciling = false;

  constructor(opts: SpaceSessionOptions) {
    this.opts = opts;
    this.token = opts.token;
    this.linkKey = opts.linkKey;
    this.identity = opts.identity;
    this.s = {
      share: loadShare(opts.token) ?? undefined,
      error: null,
      unreachable: false,
      crypto: null,
      loadedLocally: false,
      synced: false,
      slow: false,
      status: "connecting",
      syncProblem: null,
      followed: null,
      mls: null,
      mlsSnapshot: IDLE,
    };
    this.ensureMls();
    this.snap = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): SpaceSnapshot => this.snap;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resolve();
    this.changed();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.resolving?.abort();
    this.resolving = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.mlsRun++;
    this.mlsStarted = null;
    this.s.mls?.stop();
    this.unbindKeys?.();
    this.unbindKeys = null;
    this.keysBound = null;
    this.teardown?.();
    this.teardown = null;
    this.opened = "";
  }

  /** The page moved to another token, or a link brought another key. */
  setTarget(token: string, linkKey: string | null): void {
    if (token === this.token && linkKey === this.linkKey) return;
    const tokenChanged = token !== this.token;
    this.token = token;
    this.linkKey = linkKey;
    // Said of the old token; the new one gets its own lookup.
    if (tokenChanged) this.s.unreachable = false;
    if (tokenChanged && this.running) this.resolve();
    this.changed();
  }

  /** The profile is read when the group needs it; see `updateProfile`. */
  setIdentity(identity: Identity): void {
    this.identity = identity;
  }

  /** Call when the profile (name, color) changed. */
  updateProfile(): void {
    this.s.mls?.updateProfile();
  }

  /** Saves locally and pushes pending edits to the server right away. */
  syncNow = async (): Promise<SyncNowResult> =>
    (await this.flushAndSync?.()) ?? "offline";

  /**
   * Keeps the secret that opened the space, once that is proven enough.
   * Returns false when nothing is to be kept because the secret in use is
   * not the one the keys were opened with (see below), which also means
   * the space is not worth remembering yet. Call it once `opened`.
   */
  keepSecret(): boolean {
    const { share, crypto, synced } = this.s;
    if (!share || !crypto) return false;
    const key = this.currentKey();
    // Still the keys of the link before a rotation: saving their secret
    // would put the old key over the new one that was just kept.
    if (key && !crypto.matches(key)) return false;
    // Only now is the key likely to fit, but local data is stored in plain
    // text, so loading it proves nothing about the key. A view key that
    // reaches this point did not match the stored edit secret (see
    // openCrypto), and letting it replace that secret would let any crafted
    // link take edit access away from this browser for good. The same goes
    // for any other key replacing a stored one: until the server's records
    // decrypted with it, it may just be a wrong link, and saving it would
    // lose the working key.
    const secret = crypto.editSecret ?? crypto.viewSecret;
    const stored = loadSpaceKey(share.spaceId);
    const proven = synced || stored === null || stored === secret;
    if (proven && (crypto.editSecret || !stored || !isEditSecret(stored))) {
      saveSpaceKey(share.spaceId, secret);
    }
    return true;
  }

  private currentKey(): string | null {
    const { share } = this.s;
    return (
      // A newer kind of secret goes through too, so importing it can say why
      // it does not open.
      this.linkKey && secretKind(this.linkKey)
        ? this.linkKey
        : share
          ? loadSpaceKey(share.spaceId)
          : null
    );
  }

  private set(patch: Partial<State>): void {
    let diff = false;
    for (const k of Object.keys(patch) as (keyof State)[]) {
      if (!Object.is(this.s[k], patch[k])) diff = true;
    }
    if (!diff) return;
    Object.assign(this.s, patch);
    this.changed();
  }

  /** Brings the running parts in line with the state, then tells listeners. */
  private changed(): void {
    // Opening a connection or group sets state of its own.
    if (!this.reconciling) {
      this.reconciling = true;
      try {
        this.ensureMls();
        if (this.running) {
          this.reconcileMls();
          this.bindKeys();
          this.reconcileConnection();
        }
      } finally {
        this.reconciling = false;
      }
    }
    this.snap = this.build();
    for (const listener of [...this.listeners]) listener();
  }

  private resolve(attempt = 0): void {
    this.resolving?.abort();
    this.cancelRetry?.();
    this.cancelRetry = null;
    const abort = new AbortController();
    this.resolving = abort;
    const token = this.token;
    const cached = loadShare(token);
    resolveShare(token, { signal: abort.signal }).then(
      (info) => {
        if (info) rememberShare(token, info);
        else forgetShare(token);
        this.set({
          share: sameShare(this.s.share, info) ? this.s.share : info,
          unreachable: false,
        });
      },
      (err) => {
        if (abort.signal.aborted) return;
        // Local data would open, but the socket is refused just the same,
        // so working on would only pile up edits that never sync.
        if (err instanceof OutdatedClientError) {
          this.set({ error: RELOAD_MESSAGE });
          return;
        }
        // Offline with a space seen before: carry on from local data.
        if (cached) return;
        console.error(err);
        this.set({ unreachable: true });
        this.retryResolve(attempt);
      },
    );
  }

  /**
   * Without a share nothing else in the session moves, and the directory
   * service never restarts its session, so a lookup that failed once would
   * otherwise leave it in the error phase until the page reloads.
   */
  private retryResolve(attempt: number): void {
    const delay = Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS);
    const again = () => {
      cancel();
      if (this.running) this.resolve(attempt + 1);
    };
    const timer = setTimeout(again, delay);
    // Coming back online is the likely fix, so it need not wait out the
    // backoff.
    const online = typeof window !== "undefined" ? window : null;
    online?.addEventListener("online", again);
    const cancel = () => {
      clearTimeout(timer);
      online?.removeEventListener("online", again);
      if (this.cancelRetry === cancel) this.cancelRetry = null;
    };
    this.cancelRetry = cancel;
  }

  private ensureMls(): void {
    const spaceId = this.s.share?.spaceId;
    if (!spaceId) return;
    if (this.s.mls && this.mlsSpaceId === spaceId) return;
    this.s.mls?.stop();
    this.unwatchMls?.();
    const mls = new MlsSession({
      spaceId,
      backend: {
        loadMls: async (id) => (await defaultBackend()).loadMls(id),
        saveMls: async (id, record) =>
          (await defaultBackend()).saveMls(id, record),
      },
      fetchBootstrap: (t) => fetchMlsBootstrap(t),
      identity: () => this.identity,
      localIdentity: async () => localIdentity(await defaultBackend()),
      mergeGraph: async (graph) => mergeOwnGraph(await defaultBackend(), graph),
      // Keep the new links before anything else: they are the only way
      // back into the space, and nothing else holds them.
      onRotated: (rotation) => {
        storeRotation(spaceId, rotation);
        this.opts.onRotated?.(rotation, spaceId, this.token);
        this.rotated = true;
        this.set({
          followed: { token: rotation.token, link: rotation.link },
        });
      },
      onKeyring: (keyring) => saveKeyring(spaceId, keyring),
      onError: (err) => console.warn("group:", err),
    });
    this.mlsSpaceId = spaceId;
    this.unwatchMls = mls.subscribe(() =>
      this.set({ mlsSnapshot: mls.getSnapshot() }),
    );
    this.s.mls = mls;
    this.s.mlsSnapshot = mls.getSnapshot();
    this.mlsStarted = null;
  }

  private reconcileMls(): void {
    const { mls } = this.s;
    const key = this.currentKey();
    if (!mls || !key) return;
    const started = this.mlsStarted;
    if (
      started?.mls === mls &&
      started.token === this.token &&
      started.key === key
    )
      return;
    this.mlsStarted = { mls, token: this.token, key };
    const run = ++this.mlsRun;
    const token = this.token;
    loadWasm()
      .then(() =>
        run === this.mlsRun ? mls.start({ token, link: key }) : undefined,
      )
      .catch((err: unknown) => console.warn("group:", err));
  }

  // Records, presence and blobs use the group's keys from the moment it is
  // joined, and again after every epoch and rotation.
  private bindKeys(): void {
    const { mls, crypto } = this.s;
    if (!mls || !crypto) return;
    if (this.keysBound?.mls === mls && this.keysBound.crypto === crypto) return;
    this.unbindKeys?.();
    this.keysBound = { mls, crypto };
    const apply = (keys: GroupKeys) => {
      crypto.setGroupKeys(keys.docKeys, keys.signer, keys.presenceKey);
    };
    const now = mls.keys();
    if (now) apply(now);
    this.unbindKeys = mls.onKeys(apply);
  }

  private reconcileConnection(): void {
    const { share } = this.s;
    const key = this.currentKey();
    const spaceId = share?.spaceId;
    const permission = share?.permission;
    const retired = share?.retired === true;
    const sig =
      spaceId && permission && key
        ? [spaceId, permission, retired, key, this.token].join("\0")
        : "";
    if (sig === this.opened) return;
    this.teardown?.();
    this.teardown = null;
    this.opened = sig;
    if (!sig || !spaceId || !permission || !key) return;
    this.teardown = this.open({
      spaceId,
      permission,
      retired,
      key,
      token: this.token,
    });
  }

  private open(target: {
    spaceId: string;
    permission: ShareInfo["permission"];
    retired: boolean;
    key: string;
    token: string;
  }): () => void {
    const { spaceId, permission, retired, key, token } = target;
    const { doc, ephemeral } = this.opts;
    let active = true;
    // Stopping the connection fails the pending join too, which must not
    // replace the reload message with a vaguer one.
    let outdated = false;
    let local: LocalDocStore | null = null;
    const persist = this.opts.persist !== false;
    let close: (() => void) | null = null;

    (async () => {
      const [crypto, backend] = await Promise.all([
        openCrypto(token, spaceId, key),
        defaultBackend(),
      ]);
      // Torn down while the keys opened: going on would connect a socket
      // that nothing closes any more.
      if (!active) return;
      let found = !persist;
      if (persist) {
        local = new LocalDocStore(spaceId, doc, backend);
        found = await local.load();
        if (!active) return;
        local.start();
      }
      this.set({
        crypto,
        loadedLocally: found ? true : this.s.loadedLocally,
      });

      // The server refuses a replaced token, so there is nothing to sync;
      // the local copy stays open while the group looks for the new links.
      if (retired) return;

      const compactOnJoin = this.rotated;
      this.rotated = false;
      const conn = connectSpace({
        spaceId,
        token,
        crypto,
        canWrite: permission === "write" && crypto.canWrite,
        compactOnJoin: compactOnJoin && permission === "write",
        doc,
        ephemeral,
        accept: this.opts.accept,
        onRefused: () => {
          if (!active) return;
          this.set({
            error: this.opts.refusedMessage ?? "This link does not open here.",
          });
          this.opts.onRefused?.();
        },
        // A StrictMode remount closes the first socket mid-join; that is noise.
        onError: (err) => {
          if (active) console.warn("sync:", err);
        },
        onDecryptError: (err) => {
          console.error(err);
          if (active)
            this.set({
              error: err instanceof NewerVersionError ? TOO_NEW : WRONG_KEY,
            });
        },
        // The group rotated; its new links are what open these records.
        onUnknownGeneration: () => this.s.mls?.catchUp(),
        onUpdateRefused: (reason) => {
          if (active) this.set({ syncProblem: refusedText(reason) });
        },
        checkRetired: async () => (await resolveShare(token))?.retired === true,
        onRetired: () => this.s.mls?.catchUp(),
        onOutdated: () => {
          outdated = true;
          if (active) this.set({ error: RELOAD_MESSAGE });
        },
      });
      const stopStatus = conn.subscribe((status) => this.set({ status }));
      const store = local;
      this.flushAndSync = async () => {
        await store?.flush();
        return conn.syncNow();
      };
      const slowTimer = setTimeout(
        () => this.set({ slow: true }),
        SLOW_SYNC_MS,
      );
      conn.synced.then(
        () => {
          clearTimeout(slowTimer);
          if (active) this.set({ synced: true });
        },
        (err: unknown) => {
          console.error(err);
          if (active && !outdated)
            this.set({ error: "The server refused to open this project." });
        },
      );
      close = () => {
        clearTimeout(slowTimer);
        stopStatus();
        conn.close();
      };
    })().catch((err: unknown) => {
      console.error(err);
      // A replaced token has no keyring to fetch; the notice about the
      // replaced link says it better.
      if (active && !(retired && err instanceof NoKeyringError))
        this.set({ error: openError(err) });
    });

    return () => {
      active = false;
      this.flushAndSync = null;
      // Said of this connection; the next one gets to try again.
      this.s.syncProblem = null;
      close?.();
      void local?.stop();
    };
  }

  private build(): SpaceSnapshot {
    const { share, error, unreachable, crypto, loadedLocally, synced } = this.s;
    const { slow, status, syncProblem } = this.s;
    const { followed, mls, mlsSnapshot } = this.s;
    const key = this.currentKey();
    const opened = synced || loadedLocally;
    const retired = share?.retired === true;

    let phase: SpacePhase;
    // Before the error: a removed device's sockets are refused, which would
    // otherwise read as the server failing.
    if (mlsSnapshot.phase === "removed") phase = { phase: "removed" };
    else if (error) phase = { phase: "error", message: error };
    else if (
      mlsSnapshot.phase === "lost" ||
      (retired && mlsSnapshot.phase === "unavailable")
    )
      phase = { phase: "error", message: LINK_REPLACED };
    else if (unreachable) phase = { phase: "error", message: UNREACHABLE };
    else if (share === undefined) phase = { phase: "resolving" };
    else if (share === null) phase = { phase: "not-found" };
    else if (!key) phase = { phase: "missing-key" };
    else if (!opened || !crypto) phase = { phase: "syncing", share, slow };
    else phase = { phase: "opened", share, crypto, synced };

    return {
      phase,
      share,
      crypto,
      opened,
      synced,
      slow,
      status,
      syncProblem,
      followed,
      mls,
    };
  }
}
