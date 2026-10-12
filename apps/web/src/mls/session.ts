// One browser's membership in a project's MLS group: it joins the group,
// follows its commits, and makes the commits this device makes itself
// (removing members, resetting the links, refreshing its profile). The CLI
// does the same in crates/typstry-cli/src/engine/membership.rs, by the same
// rules: rejoin when the log no longer reaches us, refetch the keyring only
// after the last commit, retry lost races with jitter, and save a commit
// before sending it so the log can settle it when the reply is lost.
//
// Doc sync never waits for any of this. Until the join completes, records
// are signed by a throwaway device key (see ProjectCrypto), and a stalled
// group only costs rotations.
//
// Several tabs of a project share one group state in IndexedDB. Every
// change to it runs under a Web Lock: load the state, apply, store it. Each
// tab still receives every commit on its own socket, so the first tab to
// get the lock applies it and the others find it `alreadyApplied` (or
// older than their state) and move on. A BroadcastChannel tells the rest to
// reload.
import { toHex } from "@/crypto/bytes";
import {
  Device,
  LinkSecret,
  ProjectGroup,
  type DocKeys,
  type Outcome,
  type PresenceKey,
  type Rotation,
  type Signer,
  type SubmitMessage,
  type Unsent,
} from "@/crypto/wasm";
import { toError } from "@/lib/errors";
import {
  type DocBackend,
  type MlsRecord,
  type StoredRotation,
} from "@/persist/local-doc-store";
import { encodeProfile, type Identity } from "@/presence/identity";
import type { MlsBootstrap } from "@/sync/api";

import {
  DsClient,
  DsDisconnectedError,
  type DsClientOptions,
  type Hello,
  type ReadyMessage,
  type Reply,
} from "./ds-client";
import { rosterOf, type RosterMember } from "./members";

export type MlsPhase =
  /** Nothing started yet, or the saved group is still being read. */
  | "idle"
  /** No group state on this device yet; joining. */
  | "joining"
  | "active"
  /** The group removed this device. */
  | "removed"
  /** The server has no group for this project. */
  | "unavailable"
  /**
   * The token is retired and nothing says where the project moved. The
   * link has to be asked for again.
   */
  | "lost"
  /** Joining failed for a reason retrying does not fix (a wrong key). */
  | "failed";

export interface MlsSnapshot {
  phase: MlsPhase;
  members: readonly RosterMember[];
  /** An editor on a link the server lets commit: may remove and reset. */
  canCommit: boolean;
  /** The group met a commit it refuses; an editor has to reset it. */
  stalled: boolean;
  /** Why `failed`. */
  error: string | null;
}

/** The group's keys as of one epoch, ready to hand to `ProjectCrypto`. */
export interface GroupKeys {
  docKeys: DocKeys;
  signer: Signer;
  presenceKey: PresenceKey;
  generation: number;
}

type Locker = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** The part of `DsClient` the session uses, so tests can stand in for it. */
export type DsConnection = Pick<
  DsClient,
  "start" | "stop" | "restart" | "request" | "fetch" | "ready"
>;

export interface MlsSessionOptions {
  projectId: string;
  backend: Pick<DocBackend, "loadMls" | "saveMls">;
  fetchBootstrap: (token: string) => Promise<MlsBootstrap | null>;
  /** The profile to put in this device's leaf, read when one is needed. */
  identity: () => Identity;
  /**
   * The links moved on; keep them durably, they are the only way back in.
   * For a rotation this device made it is called before the new group state
   * is stored, so a crash in between replays it. For one read from the log
   * it is called once the server accepts the new token: a device that was
   * away across several rotations passes through tokens that are retired
   * already, and only the one that works is worth moving the page to. The
   * stored rotation replays it after a crash on the way.
   */
  onRotated?: (rotation: StoredRotation) => void;
  /** The sealed keyring of a new generation, to keep for offline opens. */
  onKeyring?: (keyring: Uint8Array) => void;
  onError?: (error: Error) => void;
  ds?: Pick<
    DsClientOptions,
    "url" | "createSocket" | "retry" | "keepaliveMs" | "readyTimeoutMs"
  >;
  /** Replaceable for tests; defaults to a `DsClient` on the page's origin. */
  createDs?: (options: DsClientOptions) => DsConnection;
  /** Replaceable for tests; defaults to `navigator.locks`. */
  locks?: Locker;
  /** Replaceable for tests; defaults to `BroadcastChannel`. */
  createChannel?: (name: string) => BroadcastChannel | null;
  /** Lost races wait this long, growing with each one. */
  jitter?: (attempt: number) => number;
  /** How long the server may go quiet while it owes us commits. */
  silenceMs?: number;
  /** Profile changes are batched for this long. */
  profileDelayMs?: number;
  /** How long a commit of ours waits for the log to confirm or drop it. */
  settleMs?: number;
}

/** Tries at a commit of our own, or at a join, before giving up. */
const ATTEMPTS = 5;

/**
 * A log that was pruned past our epoch never sends the commits we are
 * missing; silence is the cue to rejoin instead.
 */
const SILENCE_MS = 8_000;
const PROFILE_DELAY_MS = 1_000;
const SETTLE_MS = 10_000;

/** The snapshot of a session that has not started, or of no session. */
export const IDLE: MlsSnapshot = {
  phase: "idle",
  members: [],
  canCommit: false,
  stalled: false,
  error: null,
};

function defaultJitter(attempt: number): number {
  return 50 * attempt + Math.random() * 250;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serializes callers within a page when there is no Web Locks API. */
const pageLocks = new Map<string, Promise<unknown>>();
const pageLock: Locker = (name, fn) => {
  const run = (pageLocks.get(name) ?? Promise.resolve()).then(fn, fn);
  pageLocks.set(
    name,
    run.catch(() => undefined),
  );
  return run;
};

function defaultLocker(): Locker {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return (name, fn) => navigator.locks.request(name, fn);
  }
  return pageLock;
}

function kindOf(error: unknown): string | undefined {
  return (error as { kind?: unknown } | null)?.kind as string | undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function storedOf(rotation: Rotation): StoredRotation {
  const { tokens } = rotation;
  return {
    link: rotation.link,
    token: tokens.edit ?? tokens.view,
    viewToken: tokens.edit ? tokens.view : null,
    canEdit: rotation.canEdit,
  };
}

function sameRoster(
  a: readonly RosterMember[],
  b: readonly RosterMember[],
): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const n = b[i]!;
      return (
        m.leaf === n.leaf &&
        m.role === n.role &&
        m.name === n.name &&
        m.color === n.color &&
        m.isSelf === n.isSelf &&
        m.signer === n.signer &&
        m.anonymous === n.anonymous
      );
    })
  );
}

function deviceOf(group: ProjectGroup): Uint8Array {
  const device = group.device();
  try {
    return device.export();
  } finally {
    device.free();
  }
}

function emptyRecord(): MlsRecord {
  return { state: null, device: null, removed: false, rotation: null };
}

/** What a locked section works on: the stored group and its record. */
interface Tx {
  group: ProjectGroup | null;
  record: MlsRecord;
  /**
   * Stores the group's state and `patch`. A commit still waiting for the
   * server is part of the state, which is the point: see `commitIn`.
   */
  save(patch?: Partial<MlsRecord>): Promise<void>;
}

type CommitResult = { type: "done" } | { type: "unsettled" };

/** A commit of ours that went to the server, and what became of it. */
interface Sent {
  commit: Uint8Array;
  state: "pending" | "confirmed" | "discarded";
}

export class MlsSession {
  private readonly opts: MlsSessionOptions;
  private readonly lock: Locker;
  private ds: DsConnection | null = null;
  private channel: BroadcastChannel | null = null;
  private running = false;
  private token = "";
  private link = "";
  /** This tab's reading of the stored group, for rendering. */
  private group: ProjectGroup | null = null;
  private record: MlsRecord = emptyRecord();
  private snapshot: MlsSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly keyListeners = new Set<(keys: GroupKeys) => void>();
  private keyId = "";
  /** The permission the server gave the current socket. */
  private permission: ReadyMessage["permission"] | null = null;
  /**
   * The epoch the group has to reach before it is up to date: the head, or
   * for a retired token the epoch its rotation leads to, since that is as
   * far as it can read.
   */
  private target = 0;
  /** The commit this tab sent last, which the log may still settle. */
  private sent: Sent | null = null;
  private readonly settleListeners = new Set<() => void>();
  /** Waiting for the socket to say what this token may do again. */
  private readonly permissionListeners = new Set<() => void>();
  /** A rotation read from the log, held back until its token works. */
  private unannounced: StoredRotation | null = null;
  private stalled = false;
  /** Why the group is not coming: set by the states that end the join. */
  private terminal: { phase: MlsPhase; error: string | null } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private inbox: {
    epoch: number;
    commit: Uint8Array;
    envelope?: Uint8Array;
  }[] = [];
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private profileTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;

  constructor(opts: MlsSessionOptions) {
    this.opts = opts;
    this.lock = opts.locks ?? defaultLocker();
  }

  // --- What the UI reads ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MlsSnapshot => this.snapshot;

  /**
   * The keys of the group as it is now. Null before the group is joined,
   * after this device was removed, and while a rotation's keyring has not
   * arrived: the keys would not match what the signer attests.
   */
  keys(): GroupKeys | null {
    const group = this.group;
    if (!group?.isActive || group.needsKeyring()) return null;
    return {
      docKeys: group.docKeys(),
      signer: group.signer(),
      presenceKey: group.presenceKey(),
      generation: group.generation,
    };
  }

  /** Calls `listener` whenever `keys()` has something new to give. */
  onKeys(listener: (keys: GroupKeys) => void): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  // --- Lifecycle ---

  /**
   * Starts following the group with `token`, whose link carries `link`.
   * Resolves once the saved group state is read, so `keys()` is usable
   * right away for a device that joined before. Calling it again with the
   * same token does nothing; with another one (after a rotation) the
   * socket moves over.
   */
  async start(target: { token: string; link: string }): Promise<void> {
    if (
      this.running &&
      target.token === this.token &&
      target.link === this.link
    )
      return;
    this.token = target.token;
    this.link = target.link;
    if (this.terminal?.phase === "lost") this.terminal = null;
    if (this.running) {
      // A device removed during this session has no socket any more; a new
      // link may be its way back in.
      if (this.ds) this.ds.restart();
      else this.openSocket();
      return;
    }
    this.running = true;
    this.openChannel();
    await this.loadLocal();
    if (this.running) this.openSocket();
  }

  private openSocket(): void {
    this.ds = (this.opts.createDs ?? ((o) => new DsClient(o)))({
      ...this.opts.ds,
      token: () => this.token,
      hello: () => this.hello(),
      onReady: (ready) => {
        const token = this.token;
        this.background(async () => {
          // A rotation moved us on while this was queued.
          if (token === this.token) await this.reconcile(ready);
        });
      },
      onMessage: (message) => this.onMessage(message),
      onDown: () => {
        this.permission = null;
        this.clearSilence();
      },
      onFatal: () => {
        // Behind whatever commits arrived first: they may carry the
        // rotation that explains why the token is gone.
        const token = this.token;
        this.background(async () => {
          if (token !== this.token || !this.running) return;
          if (this.group?.isActive || this.record.rotation) return this.lose();
          this.end("unavailable");
        });
      },
      onError: (error) => this.opts.onError?.(error),
    });
    this.ds.start();
  }

  stop(): void {
    this.running = false;
    this.ds?.stop();
    this.ds = null;
    this.channel?.close();
    this.channel = null;
    this.clearSilence();
    if (this.profileTimer !== null) clearTimeout(this.profileTimer);
    this.profileTimer = null;
    this.inbox = [];
    this.group?.free();
    this.group = null;
    this.keyId = "";
    this.permission = null;
    this.snapshot = IDLE;
    this.record = emptyRecord();
    this.terminal = null;
    this.stalled = false;
    this.sent = null;
    this.unannounced = null;
    this.settleListeners.clear();
    for (const listener of [...this.permissionListeners]) listener();
  }

  /**
   * Asks the server for the commits again. For when the doc socket was
   * closed because the token was replaced: the group's socket usually finds
   * out by itself, this covers the times it doesn't.
   */
  catchUp(): void {
    if (!this.running) return;
    if (this.ds?.ready) this.ds.fetch(this.group?.epoch ?? 0);
    else this.ds?.restart();
  }

  // --- Reading the stored group ---

  private openChannel(): void {
    const name = `typstry:mls:${this.opts.projectId}`;
    const channel =
      this.opts.createChannel?.(name) ??
      (typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(name));
    this.channel = channel;
    if (channel) {
      channel.onmessage = () => this.background(() => this.refresh());
    }
  }

  private async readStored(): Promise<{
    record: MlsRecord;
    group: ProjectGroup | null;
  }> {
    const record =
      (await this.opts.backend.loadMls(this.opts.projectId)) ?? emptyRecord();
    let group: ProjectGroup | null = null;
    if (record.state && !record.removed) {
      try {
        group = ProjectGroup.importState(record.state);
      } catch (error) {
        // Unreadable state is a lost group: the device is still ours, so
        // joining again replaces its old leaf. A newer build's state is
        // not ours to throw away.
        if (kindOf(error) === "NewerVersion") throw error;
        console.warn("discarding unreadable group state:", error);
      }
    }
    return { record, group };
  }

  private async loadLocal(): Promise<void> {
    try {
      const { record, group } = await this.readStored();
      this.adopt(group, record);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Reloads what another tab stored. */
  private async refresh(): Promise<void> {
    if (!this.running) return;
    const { record, group } = await this.readStored();
    this.adopt(group, record);
    const rotation = record.rotation;
    if (rotation && !this.isCurrent(rotation)) this.follow(rotation);
  }

  /** Whether `rotation` is the links this session is on already. */
  private isCurrent(rotation: StoredRotation): boolean {
    return (
      this.token === rotation.token ||
      (rotation.viewToken !== null && this.token === rotation.viewToken)
    );
  }

  /** Moves to `rotation`, which callers checked is not `isCurrent`. */
  private follow(rotation: StoredRotation): void {
    this.moveTo(rotation);
    this.unannounced = rotation;
  }

  // --- State ---

  /** Takes `group` (a fresh import, or the result of an operation) as the current one. */
  private adopt(group: ProjectGroup | null, record: MlsRecord): void {
    if (this.group && this.group !== group) this.group.free();
    this.group = group;
    this.record = record;
    this.publish();
    this.emitKeys();
  }

  private phase(): MlsPhase {
    if (this.record.removed || (this.group && !this.group.isActive))
      return "removed";
    // Before "active": a member whose links were replaced and who has no way
    // to learn the new ones still has a group, but nothing syncs for it.
    if (this.terminal?.phase === "lost") return "lost";
    if (this.group) return "active";
    return this.terminal?.phase ?? (this.running ? "joining" : "idle");
  }

  /** Ends the join with `phase`; a later successful join clears it. */
  private end(phase: MlsPhase, error: string | null = null): void {
    this.terminal = { phase, error };
    this.publish();
  }

  private publish(): void {
    const group = this.group;
    const active = group?.isActive ?? false;
    const roster = active ? rosterOf(group!.members()) : [];
    const prev = this.snapshot;
    // Most publishes change nothing the UI shows; keeping the old objects
    // spares every subscriber a re-render.
    const members = sameRoster(prev.members, roster) ? prev.members : roster;
    const me = members.find((m) => m.isSelf);
    const next: MlsSnapshot = {
      phase: this.phase(),
      members,
      canCommit: me?.role === "editor" && this.permission === "write",
      stalled: this.stalled,
      error: this.terminal?.error ?? null,
    };
    if (
      next.members === prev.members &&
      next.phase === prev.phase &&
      next.canCommit === prev.canCommit &&
      next.stalled === prev.stalled &&
      next.error === prev.error
    )
      return;
    this.snapshot = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private emitKeys(): void {
    const group = this.group;
    if (!group?.isActive || group.needsKeyring()) return;
    const link = group.link();
    let id: string;
    try {
      id = `${group.incarnation}:${group.epoch}:${group.generation}:${link.toBase64url()}`;
    } finally {
      link.free();
    }
    if (id === this.keyId) return;
    this.keyId = id;
    const keys = this.keys();
    if (keys) for (const listener of [...this.keyListeners]) listener(keys);
  }

  /**
   * For work nobody awaits. A dropped socket is not worth reporting: the
   * reconnect picks the work up again. `fail` also ends the join.
   */
  private report(error: unknown, fail = false): void {
    if (!this.running || error instanceof DsDisconnectedError) return;
    if (fail) this.fail(error);
    else this.opts.onError?.(toError(error));
  }

  private fail(error: unknown): void {
    const e = toError(error);
    this.opts.onError?.(e);
    this.end("failed", e.message);
  }

  // --- Serialized work ---

  /** Runs `task` after everything queued before it. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private background(task: () => Promise<void>): void {
    this.enqueue(task).catch((error: unknown) => this.report(error, true));
  }

  /**
   * Runs `fn` on the stored group while holding the project's lock, then
   * makes whatever it left in the transaction this tab's current state and
   * tells the other tabs.
   */
  private async locked<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const { projectId, backend } = this.opts;
    return this.lock(`typstry:mls:${projectId}`, async () => {
      const stored = await this.readStored();
      let changed = false;
      const tx: Tx = {
        group: stored.group,
        record: stored.record,
        save: async (patch = {}) => {
          const { group, record } = tx;
          tx.record = {
            ...record,
            ...patch,
            state: group ? group.exportState() : record.state,
            // The device never changes once joined, a reset included.
            device: record.device ?? (group ? deviceOf(group) : null),
          };
          await backend.saveMls(projectId, tx.record);
          changed = true;
        },
      };
      try {
        const result = await fn(tx);
        this.adopt(tx.group, tx.record);
        if (changed) this.channel?.postMessage("changed");
        return result;
      } catch (error) {
        if (changed) {
          // What was stored before the failure is the truth now, e.g. a
          // commit waiting for an answer that never came.
          this.adopt(tx.group, tx.record);
          this.channel?.postMessage("changed");
        } else if (tx.group && tx.group !== this.group) {
          tx.group.free();
        }
        throw error;
      }
    });
  }

  // --- What the server tells us ---

  private async hello(): Promise<Hello | null> {
    const group = this.group;
    if (group?.isActive)
      return { incarnation: group.incarnation, sinceEpoch: group.epoch };
    if (group) return null;
    const boot = await this.opts.fetchBootstrap(this.token);
    if (!boot) {
      this.end("unavailable");
      // A removed device only comes back with a live link; its old one never
      // will, so there is no point in asking again and again.
      if (this.record.removed) queueMicrotask(() => this.ds?.stop());
      return null;
    }
    return { incarnation: boot.incarnation, sinceEpoch: boot.epoch };
  }

  private onMessage(
    message: Parameters<DsClientOptions["onMessage"]>[0],
  ): void {
    switch (message.type) {
      case "commit":
        this.target = Math.max(this.target, message.epoch + 1);
        this.inbox.push({
          epoch: message.epoch,
          commit: message.commit,
          envelope: message.envelope,
        });
        this.background(() => this.drain());
        return;
      case "reinitialized":
        this.background(() =>
          this.rejoinIfBehindIncarnation(message.incarnation),
        );
        return;
      default:
        return;
    }
  }

  /** The socket is up: bring the group in line with what the server says. */
  private async reconcile(ready: ReadyMessage): Promise<void> {
    this.permission = ready.permission;
    for (const listener of [...this.permissionListeners]) listener();
    if (ready.permission !== "retired" && this.unannounced) {
      const rotation = this.unannounced;
      this.unannounced = null;
      this.opts.onRotated?.(rotation);
    }
    this.target =
      ready.permission === "retired" && ready.retired !== undefined
        ? ready.retired + 1
        : ready.head;
    this.stalled = false;
    let ended = false;
    await this.locked(async (tx) => {
      const group = tx.group;
      if (group && !group.isActive) {
        await tx.save({ removed: true });
        return;
      }
      const needsJoin =
        !group ||
        group.incarnation !== ready.incarnation ||
        this.wantsUpgrade(group);
      if (!needsJoin) return;
      if (ready.permission === "retired") {
        ended = true;
        return;
      }
      await this.join(tx);
    });
    if (ended) return this.lose();
    this.publish();
    await this.settle();
    // The name may have changed while the join was under way.
    this.updateProfile();
  }

  private async rejoinIfBehindIncarnation(incarnation: number): Promise<void> {
    if (this.group?.isActive && this.group.incarnation === incarnation) return;
    if (this.permission === "retired") return this.lose();
    await this.locked((tx) => this.join(tx));
    await this.settle();
  }

  /**
   * An edit link opened on a device that holds a viewer's group: the same
   * device joins again, this time as an editor.
   */
  private wantsUpgrade(group: ProjectGroup): boolean {
    let link: LinkSecret | null = null;
    let held: LinkSecret | null = null;
    try {
      link = LinkSecret.parse(this.link);
      if (!link.canAttest()) return false;
      held = group.link();
      return !held.canAttest();
    } catch {
      return false;
    } finally {
      link?.free();
      held?.free();
    }
  }

  /** Applies the commits that came in, all under one lock. */
  private async drain(): Promise<void> {
    const batch = this.inbox.splice(0);
    if (batch.length === 0) return;

    const result = await this.locked(async (tx) => {
      const found = {
        gap: false,
        removed: false,
        invalid: null as string | null,
        rotation: null as StoredRotation | null,
        /** The rotation is the one this device made, so its tokens work. */
        mine: false,
        keyring: null as Uint8Array | null,
      };
      const group = tx.group;
      if (!group?.isActive) return found;
      let changed = false;
      for (const { epoch, commit, envelope } of batch) {
        // Another tab applied it already.
        if (epoch < group.epoch) continue;
        if (epoch > group.epoch) {
          found.gap = true;
          break;
        }
        // A commit of ours waiting for its answer is settled by this one:
        // confirmed when the log echoes it, dropped when another won.
        const waiting = group.pendingSubmit();
        let outcome: Outcome | null = null;
        let failure: unknown = null;
        try {
          outcome = group.processCommit(epoch, commit, envelope);
        } catch (error) {
          failure = error;
        }
        const own = waiting && sameBytes(waiting.commit, commit);
        if (waiting && !group.hasPendingSubmit) {
          changed = true;
          this.markSent(waiting.commit, own ? "confirmed" : "discarded");
        }
        if (failure) {
          const kind = kindOf(failure);
          if (kind === "NotActive") {
            found.removed = true;
            break;
          }
          // The commits in between were pruned from the log.
          if (kind === "Epoch") {
            found.gap = true;
            break;
          }
          // Anything else is a commit this device cannot process, which is
          // the same for every member: the group is stalled, not behind.
          found.invalid = toError(failure).message;
          break;
        }
        if (outcome!.type === "invalid") {
          found.invalid = outcome!.reason;
          break;
        }
        changed = true;
        if (outcome!.type === "rotated") {
          found.rotation = storedOf(outcome!);
          found.mine = !!own;
          if (own) found.keyring = waiting.keyring ?? null;
        } else if (outcome!.type === "removed") {
          found.removed = true;
          break;
        }
      }
      if (found.rotation && found.mine) this.opts.onRotated?.(found.rotation);
      if (found.keyring) this.opts.onKeyring?.(found.keyring);
      if (found.removed) await tx.save({ removed: true });
      else if (changed)
        await tx.save(found.rotation ? { rotation: found.rotation } : {});
      return found;
    });

    if (result.removed) {
      this.ds?.stop();
      this.ds = null;
      this.publish();
      return;
    }
    if (result.rotation) {
      this.moveTo(result.rotation);
      if (!result.mine) this.unannounced = result.rotation;
    }
    if (result.invalid !== null) {
      this.stalled = true;
      this.publish();
      console.warn(`the project's member group is stalled: ${result.invalid}`);
      this.recover();
      return;
    }
    if (result.gap) {
      if (this.permission === "retired") return this.lose();
      await this.locked((tx) => this.join(tx));
    }
    this.publish();
    await this.settle();
  }

  /**
   * Switches to the links of a rotation. The socket moves to the new token
   * before anything is fetched with it: the old one is retired and can
   * read nothing but the log.
   */
  private moveTo(rotation: StoredRotation): void {
    this.token = rotation.token;
    this.link = rotation.link;
    this.permission = null;
    this.target = 0;
    if (this.terminal?.phase === "lost") this.terminal = null;
    this.ds?.restart();
  }

  /**
   * After a round of commits: fetch the keyring once the last rotation is
   * in (earlier steps would not agree with the one the server holds), see
   * whether a retired token has answered what it came for, and watch for a
   * log that stopped short.
   */
  private async settle(): Promise<void> {
    const group = this.group;
    if (!group?.isActive) return this.clearSilence();
    if (group.epoch < this.target) return this.armSilence();
    this.clearSilence();
    if (this.permission === "retired") return this.lose();
    // A retired token has no keyring to fetch, and a socket that is moving
    // to new links has no permission yet.
    if (this.permission === null) return;
    if (group.needsKeyring()) await this.refreshKeyring();
    // Read again: storing the keyring replaced the group object.
    if (this.group?.hasPendingSubmit && this.permission === "write") {
      try {
        await this.locked((tx) => this.resubmit(tx));
      } catch (error) {
        // A refusal of an old commit is no reason to give up on the group.
        if (error instanceof DsDisconnectedError) throw error;
        this.opts.onError?.(toError(error));
      }
    }
  }

  /**
   * The token is replaced. If this device already knows where the project
   * moved, it goes there; otherwise nothing will ever sync for these links,
   * which has to be said instead of left as a socket that quietly stopped.
   */
  private lose(): void {
    if (this.record.removed) return;
    const rotation = this.record.rotation;
    if (rotation && !this.isCurrent(rotation)) return this.follow(rotation);
    this.end("lost");
  }

  private armSilence(): void {
    this.clearSilence();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      const group = this.group;
      if (!this.running || !group?.isActive || group.epoch >= this.target)
        return;
      if (this.permission === "retired") return this.lose();
      this.background(async () => {
        await this.locked((tx) => this.join(tx));
        await this.settle();
      });
    }, this.opts.silenceMs ?? SILENCE_MS);
  }

  private clearSilence(): void {
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private async refreshKeyring(): Promise<void> {
    await this.locked(async (tx) => {
      const group = tx.group;
      if (!group?.isActive || !group.needsKeyring()) return;
      const boot = await this.opts.fetchBootstrap(this.token);
      if (!boot) return;
      try {
        group.setKeyring(boot.keyring);
      } catch {
        // The server holds the keyring of a generation this device has not
        // reached yet. Following the group's commits fixes that.
        return;
      }
      await tx.save();
      this.opts.onKeyring?.(boot.keyring);
    });
  }

  // --- Joining ---

  /**
   * An external join, as this device if it was in the group before (the
   * new leaf then replaces the old one instead of joining it). Retries
   * when another member's commit wins the epoch.
   */
  private async join(tx: Tx): Promise<void> {
    const ds = this.ds;
    if (!ds) return;
    if (this.permission === "retired") return;
    const device = tx.record.device
      ? Device.import(tx.record.device)
      : (tx.group?.device() ?? Device.generate());
    try {
      if (!tx.record.device) {
        // Stored before the join so a refused attempt or a crash keeps the
        // identity for the next one.
        tx.record = { ...tx.record, device: device.export() };
        await this.opts.backend.saveMls(this.opts.projectId, tx.record);
      }
      const link = LinkSecret.parse(this.link);
      const profile = encodeProfile(this.opts.identity());
      const jitter = this.opts.jitter ?? defaultJitter;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const boot = await this.opts.fetchBootstrap(this.token);
        if (!boot) {
          this.end("unavailable");
          return;
        }
        let joined;
        try {
          joined = ProjectGroup.joinExternalAs(
            device,
            link,
            boot.groupInfo,
            boot.keyring,
            profile,
          );
        } catch (error) {
          // The sealed parts only open with the project's keys, so this
          // is where a truncated or wrong link shows.
          const kind = kindOf(error);
          if (kind === "KeyMismatch" || kind === "Mismatch")
            return this.fail(
              new Error("This link's key does not match the project."),
            );
          throw error;
        }
        const { group, message } = joined;
        let reply: Reply;
        try {
          reply = await ds.request(message);
        } catch (error) {
          group.free();
          throw error;
        }
        if (reply.type === "accepted") {
          group.confirmPending();
          if (tx.group) tx.group.free();
          tx.group = group;
          // Whatever the old group had waiting died with it.
          if (this.sent?.state === "pending")
            this.markSent(this.sent.commit, "discarded");
          // A device that was removed and holds a live link again is a
          // member again.
          await tx.save({ removed: false, rotation: null });
          this.stalled = false;
          this.terminal = null;
          return;
        }
        // Nothing of the attempt exists on the server.
        group.free();
        if (reply.type === "refused" && reply.code !== "wrongIncarnation") {
          throw new Error(`joining the project's group: ${reply.code}`);
        }
        if (attempt < ATTEMPTS) await sleep(jitter(attempt));
      }
      throw new Error(
        "could not join the project's group: other members kept changing it",
      );
    } finally {
      device.free();
    }
  }

  // --- Commits of our own ---

  /**
   * Removes the members with the device keys `signers` (hex, as the roster
   * has them) and rotates the links, so what they hold stops working. The
   * members are looked up again right before the commit is built: a leaf
   * index the roster showed may belong to somebody else by then. Resolves
   * once the server took it; the new links reach the app through
   * `onRotated`.
   */
  removeMembers(signers: string[]): Promise<void> {
    return this.commit((group) => {
      const members = group.members();
      const leaves = signers.map((signer) => {
        const member = members.find((m) => toHex(m.sigPub) === signer);
        if (!member || member.isSelf)
          throw new Error("That member is no longer in the project.");
        return member.leaf;
      });
      return group.removeAndRotate(Uint32Array.from(leaves));
    });
  }

  /** Replaces the links without removing anyone. */
  resetLinks(): Promise<void> {
    return this.commit((group) => group.resetLinks());
  }

  /**
   * Puts a changed name or color into this device's leaf, shortly after
   * the last change. Editors commit it; a viewer cannot, so it joins again
   * as the same device with the new profile.
   */
  updateProfile(): void {
    if (this.profileTimer !== null) clearTimeout(this.profileTimer);
    this.profileTimer = setTimeout(() => {
      this.profileTimer = null;
      // Not through the queue: committing queues its own turns.
      this.syncProfile().catch((error: unknown) => this.report(error));
    }, this.opts.profileDelayMs ?? PROFILE_DELAY_MS);
  }

  private async syncProfile(): Promise<void> {
    if (!this.running || !this.group?.isActive) return;
    const me = this.snapshot.members.find((m) => m.isSelf);
    const want = this.opts.identity();
    if (!me || (me.name === want.name && me.color === want.color)) return;
    if (this.permission === "retired" || this.permission === null) return;
    if (me.role === "editor" && this.permission === "write") {
      await this.commit((group) => group.selfUpdate(encodeProfile(want)));
    } else {
      await this.enqueue(() => this.locked((tx) => this.join(tx)));
    }
  }

  private async commit(
    build: (group: ProjectGroup) => Unsent<SubmitMessage>,
  ): Promise<void> {
    const jitter = this.opts.jitter ?? defaultJitter;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      // Each try is its own turn of the queue, so the commit that beat us
      // is applied before we build on the epoch it made.
      let result: CommitResult;
      // What an earlier commit became is no answer for this one.
      if (this.sent?.state !== "pending") this.sent = null;
      try {
        result = await this.enqueue(() =>
          this.locked((tx) => this.commitIn(tx, build)),
        );
      } catch (error) {
        if (!(error instanceof DsDisconnectedError)) throw error;
        // The socket went down with the commit in flight. It is saved, so
        // whether the server took it shows in the log after the reconnect.
        result = { type: "unsettled" };
      }
      if (result.type === "done") {
        this.publish();
        return;
      }
      const sent = this.sent;
      if (!sent) {
        // Nothing went out: the socket is moving to new links. A jitter is
        // shorter than a reconnect, so waiting on that instead keeps the
        // attempts for real races.
        await this.untilPermission();
        continue;
      }
      if ((await this.untilSettled(sent)) === "confirmed") {
        this.publish();
        return;
      }
      await sleep(jitter(attempt));
    }
    throw new Error("other members kept changing the project; try again");
  }

  /**
   * Builds, stores and sends one commit. It is stored before it is sent,
   * with the links it would rotate to: the reply can get lost, and then the
   * log is the only thing that says whether the commit landed. Discarding
   * it on a lost reply would throw away the only copy of the new links of a
   * rotation that did land.
   */
  private async commitIn(
    tx: Tx,
    build: (group: ProjectGroup) => Unsent<SubmitMessage>,
  ): Promise<CommitResult> {
    const group = tx.group;
    const ds = this.ds;
    if (!group?.isActive || !ds) throw new Error("you are not a member");
    // Moving to new links: the socket has no permission until it is back.
    if (this.permission === null) return { type: "unsettled" };
    if (this.permission !== "write")
      throw new Error("only editors can do that");
    // A group with a commit waiting cannot build another one.
    if (group.hasPendingSubmit && (await this.resubmit(tx)) === "waiting")
      return { type: "unsettled" };
    const message = build(group);
    this.sent = { commit: message.commit, state: "pending" };
    await tx.save();
    return this.answered(tx, ds, message, await ds.request(message));
  }

  /**
   * Sends the commit that is still waiting again, after a lost reply or a
   * reconnect. The server answers `conflict` when it already landed, or when
   * another one did; in both cases the log settles it, so this only asks for
   * it again.
   */
  private async resubmit(tx: Tx): Promise<"settled" | "waiting"> {
    const group = tx.group;
    const ds = this.ds;
    const message = group?.pendingSubmit();
    if (!group?.isActive || !ds || !message || this.permission !== "write")
      return "settled";
    if (!this.sent || !sameBytes(this.sent.commit, message.commit))
      this.sent = { commit: message.commit, state: "pending" };
    const result = await this.answered(
      tx,
      ds,
      message,
      await ds.request(message),
    );
    return result.type === "done" ? "settled" : "waiting";
  }

  private async answered(
    tx: Tx,
    ds: DsConnection,
    message: Unsent<SubmitMessage>,
    reply: Reply,
  ): Promise<CommitResult> {
    const group = tx.group!;
    if (reply.type === "conflict") {
      // Not a verdict on our commit. process_commit decides when the log
      // reaches us: our own commit confirms, another one drops ours.
      this.target = Math.max(this.target, reply.head);
      ds.fetch(group.epoch);
      return { type: "unsettled" };
    }
    if (reply.type === "refused") {
      group.discardPending();
      this.markSent(message.commit, "discarded");
      await tx.save();
      throw new Error(`the server refused the change: ${reply.code}`);
    }
    const rotation = group.confirmPending();
    this.markSent(message.commit, "confirmed");
    const stored = rotation ? storedOf(rotation) : null;
    if (stored) {
      // Before the group state is stored, so a crash in between replays the
      // rotation instead of losing the new link.
      this.opts.onRotated?.(stored);
      if (message.keyring) this.opts.onKeyring?.(message.keyring);
    }
    await tx.save(stored ? { rotation: stored } : {});
    if (stored) this.moveTo(stored);
    return { type: "done" };
  }

  private markSent(commit: Uint8Array, state: "confirmed" | "discarded"): void {
    if (this.sent && sameBytes(this.sent.commit, commit)) {
      this.sent.state = state;
      for (const listener of [...this.settleListeners]) listener();
    }
  }

  /**
   * Waits for the log to say what became of `sent`: confirmed when it
   * echoes it, discarded when another commit took the epoch.
   */
  private untilSettled(sent: Sent | null): Promise<Sent["state"]> {
    if (!sent || sent.state !== "pending")
      return Promise.resolve(sent?.state ?? "discarded");
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.settleListeners.delete(check);
        resolve(sent.state);
      };
      const check = () => {
        if (sent.state !== "pending") done();
      };
      const timer = setTimeout(done, this.opts.settleMs ?? SETTLE_MS);
      this.settleListeners.add(check);
    });
  }

  /** Resolves once the socket is ready again, or after `settleMs`. */
  private untilPermission(): Promise<void> {
    if (this.permission !== null || !this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.permissionListeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.opts.settleMs ?? SETTLE_MS);
      this.permissionListeners.add(done);
    });
  }

  // --- A stalled group ---

  /**
   * Starts the group over when it met a commit it refuses. Every editor
   * that sees the stall tries after a random wait; the first reset wins and
   * the others find a new incarnation to join. The wait happens off the
   * queue: everything else, doc keys included, goes through it.
   */
  private recover(): void {
    if (this.recovering) return;
    this.recovering = true;
    this.startRecovery()
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.recovering = false;
      });
  }

  private async startRecovery(): Promise<void> {
    if (!this.snapshot.canCommit) return;
    await sleep(500 + Math.random() * 2000);
    if (!this.stalled || !this.running) return;
    await this.enqueue(() =>
      this.locked(async (tx) => {
        const group = tx.group;
        const ds = this.ds;
        if (!group?.isActive || !ds) return;
        const { group: next, message } = group.reset(
          encodeProfile(this.opts.identity()),
        );
        let reply: Reply;
        try {
          reply = await ds.request(message);
        } catch (error) {
          next.free();
          throw error;
        }
        if (reply.type !== "accepted") {
          next.free();
          return;
        }
        group.free();
        tx.group = next;
        await tx.save();
        this.stalled = false;
      }),
    );
    this.publish();
  }
}
