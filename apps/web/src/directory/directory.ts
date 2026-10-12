// Same operations and rules as crates/typstry-doc/src/directory.rs; keep
// them in lock step. Reads treat the doc as untrusted, since any device of
// the person may have written junk: an entry that does not validate is
// skipped, never an error. Writes are no-ops when they would change nothing,
// so reopening a project does not pile up ops.
import type { LoroDoc, LoroMap } from "loro-crdt";

import { fromBase64Url, toBase64Url, toHex } from "@/crypto/bytes";
import { secretKind } from "@/crypto/secret";
import { ownerPublicKeyOf } from "@/crypto/wasm";
import { CHANGE_MERGE_INTERVAL_S, DOC_KIND, META } from "@/doc/schema";

import {
  DIRECTORY_SCHEMA_VERSION,
  FUTURE_SLACK_MS,
  LINK,
  OPENED_REFRESH_MS,
  OWNER_KEY,
  OWNER_KEYS_KEEP,
  RETIRED_KEEP_MS,
  ROOT,
  STATES,
  STATUS,
  type State,
} from "./schema";

export interface LinkRef {
  token: string;
  secret: string;
  edit: boolean;
  /**
   * Seen retired. Only the best link of a project whose links are all
   * retired comes back like this, so a caller can still try to catch up.
   */
  retired: boolean;
}

export interface Entry {
  projectId: string;
  title: string | null;
  link: LinkRef;
  state: State;
  openedAt: number | null;
  /** When the project's first link was learned. */
  addedAt: number;
}

export interface NewLink {
  token: string;
  projectId: string;
  secret: string;
  edit: boolean;
  addedAt: number;
  generation?: number;
}

export interface OwnerKeyRef {
  /** Hex of the public owner key, as the server names it. */
  publicKey: string;
  /** The bare 32 secret bytes, what `withOwnerSecrets` takes. */
  secret: Uint8Array;
}

export type Unsupported =
  | { reason: "not-directory"; found: string }
  | { reason: "too-new"; found: number; supported: number };

interface Parsed {
  token: string;
  projectId: string;
  secret: string;
  edit: boolean;
  addedAt: number;
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integers and doubles read the same; Rust truncates the same way. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function validToken(token: string): boolean {
  return /^[0-9A-Za-z]{22}$/.test(token);
}

/** Why a candidate link is unusable, or null. */
function linkProblem(
  token: string,
  projectId: string,
  secret: string,
  edit: boolean,
): string | null {
  if (!validToken(token)) return "token";
  if (!projectId) return "project id";
  const kind = secretKind(secret);
  if (kind !== "edit" && kind !== "view") return "secret";
  if (edit && kind !== "edit") return "edit flag on a view secret";
  return null;
}

function parseLink(token: string, value: unknown): Parsed | null {
  if (!isPlain(value)) return null;
  const { projectId, secret, edit } = value;
  if (
    typeof projectId !== "string" ||
    typeof secret !== "string" ||
    typeof edit !== "boolean" ||
    linkProblem(token, projectId, secret, edit)
  )
    return null;
  const addedAt = num(value[LINK.addedAt]);
  if (addedAt === null) return null;
  return {
    token,
    projectId,
    secret,
    edit,
    addedAt,
  };
}

function notFuture(addedAt: number, now: number): boolean {
  return addedAt <= now + FUTURE_SLACK_MS;
}

const OWNER_SECRET_BYTES = 32;

/** The bare secret of an `ownerKeys` value if it derives `publicKey`. */
function ownerSecretOf(value: unknown, publicKey: string): Uint8Array | null {
  const text = isPlain(value) ? value[OWNER_KEY.secret] : null;
  if (typeof text !== "string") return null;
  const secret = fromBase64Url(text);
  // The length check keeps junk from reaching the wasm, which throws on it;
  // a wasm that is not loaded yet should still fail loudly.
  if (secret?.length !== OWNER_SECRET_BYTES) return null;
  return toHex(ownerPublicKeyOf(secret)) === publicKey ? secret : null;
}

/** Descending, so `a` sorts first when it is greater. */
function desc(a: number | boolean, b: number | boolean): number {
  return Number(b) - Number(a);
}

/**
 * Picks the link to open a project with among its valid `links`. A link
 * that is not retired always beats one that is. Among live links an edit
 * link wins, then the newest, then the smaller token so the choice is
 * total. If every link is retired the newest one is picked, so the caller
 * can still try to catch up. `generation` is not ranked on: an attacker
 * could set any value.
 */
function pick(links: Parsed[], retired: Map<string, number>): Parsed | null {
  const byToken = (a: Parsed, b: Parsed) =>
    a.token < b.token ? -1 : a.token > b.token ? 1 : 0;
  const live = links.filter((l) => !retired.has(l.token));
  if (live.length > 0)
    return [...live].sort(
      (a, b) =>
        desc(a.edit, b.edit) || desc(a.addedAt, b.addedAt) || byToken(a, b),
    )[0]!;
  return (
    [...links].sort(
      (a, b) =>
        desc(a.addedAt, b.addedAt) || desc(a.edit, b.edit) || byToken(a, b),
    )[0] ?? null
  );
}

function groupByProject(links: Parsed[]): Map<string, Parsed[]> {
  const out = new Map<string, Parsed[]>();
  for (const l of links) {
    const mine = out.get(l.projectId);
    if (mine) mine.push(l);
    else out.set(l.projectId, [l]);
  }
  return out;
}

function linkRef(l: Parsed, retired: Map<string, number>): LinkRef {
  return {
    token: l.token,
    secret: l.secret,
    edit: l.edit,
    retired: retired.has(l.token),
  };
}

/** Typed view over a person's directory LoroDoc. Holds no state besides it. */
export class Directory {
  readonly doc: LoroDoc;
  private batching = false;

  constructor(doc: LoroDoc) {
    this.doc = doc;
    // Local settings, not synced; every wrapper sets them like ProjectDoc.
    doc.setRecordTimestamp(true);
    doc.setChangeMergeInterval(CHANGE_MERGE_INTERVAL_S);
  }

  private map(name: string): LoroMap {
    return this.doc.getMap(name);
  }

  private commit(message: string): void {
    if (!this.batching) this.doc.commit({ message });
  }

  /**
   * Runs the writes `fn` makes as one commit, so a caller that records
   * several facts at once wakes the subscribers and the sync only once.
   * Reads inside `fn` already see the earlier writes.
   */
  batch<T>(message: string, fn: () => T): T {
    if (this.batching) return fn();
    this.batching = true;
    try {
      return fn();
    } finally {
      this.batching = false;
      this.doc.commit({ message });
    }
  }

  /** The doc's `meta.kind`, or null while it is unset or not a string. */
  get kind(): string | null {
    const value = this.map(ROOT.meta).get(META.kind);
    return typeof value === "string" ? value : null;
  }

  get schemaVersion(): number | null {
    const value = this.map(ROOT.meta).get(META.schema);
    return typeof value === "number" ? value : null;
  }

  /**
   * Why this doc must not be used as a directory: some other kind, or a
   * layout newer than this build. A doc without a kind or schema yet (still
   * syncing) passes.
   */
  unsupported(): Unsupported | null {
    const kind = this.kind;
    if (kind !== null && kind !== DOC_KIND.directory)
      return { reason: "not-directory", found: kind };
    const found = this.schemaVersion;
    if (found !== null && found > DIRECTORY_SCHEMA_VERSION)
      return { reason: "too-new", found, supported: DIRECTORY_SCHEMA_VERSION };
    return null;
  }

  /**
   * Marks an empty doc as a directory. Does nothing once the doc carries a
   * kind or schema. Deterministic, so two devices doing it at once write
   * the same values and merge into one.
   */
  init(): void {
    if (this.kind !== null || this.schemaVersion !== null) return;
    const meta = this.map(ROOT.meta);
    meta.set(META.kind, DOC_KIND.directory);
    meta.set(META.schema, DIRECTORY_SCHEMA_VERSION);
    this.commit("init directory");
  }

  /** Valid links, skipping ones dated in the future. */
  private validLinks(now: number): Parsed[] {
    const out: Parsed[] = [];
    for (const [token, value] of Object.entries(
      this.map(ROOT.links).toJSON(),
    )) {
      const parsed = parseLink(token, value);
      if (parsed && notFuture(parsed.addedAt, now)) out.push(parsed);
    }
    return out;
  }

  private retiredMap(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [token, value] of Object.entries(
      this.map(ROOT.retired).toJSON(),
    )) {
      const at = num(value);
      if (at !== null) out.set(token, at);
    }
    return out;
  }

  /** The best link of a project, see `pick` for the order. */
  bestLink(projectId: string, now: number): LinkRef | null {
    const retired = this.retiredMap();
    const best = pick(
      this.validLinks(now).filter((l) => l.projectId === projectId),
      retired,
    );
    return best && linkRef(best, retired);
  }

  /** The project a share token belongs to, if its link entry is valid. */
  projectOfToken(token: string, now: number): string | null {
    const parsed = parseLink(token, this.map(ROOT.links).get(token));
    return parsed && notFuture(parsed.addedAt, now) ? parsed.projectId : null;
  }

  private status(
    projectId: string,
  ): { state: State; token: string | null } | null {
    const value = this.map(ROOT.status).get(projectId);
    if (!isPlain(value)) return null;
    const state = STATES.find((s) => s === value[STATUS.state]);
    if (!state) return null;
    const token = value[STATUS.token];
    return { state, token: typeof token === "string" ? token : null };
  }

  /**
   * Every project with at least one valid link, most recently opened first,
   * then the most recently learned, then by id. Forgotten ones are
   * included; callers filter.
   */
  list(now: number): Entry[] {
    const retired = this.retiredMap();
    const entries: Entry[] = [];
    for (const [projectId, mine] of groupByProject(this.validLinks(now))) {
      const entry = this.entryOf(projectId, mine, retired);
      if (entry) entries.push(entry);
    }
    return entries.sort(
      (a, b) =>
        // Never opened sorts last, like None in Rust.
        desc(a.openedAt ?? -Infinity, b.openedAt ?? -Infinity) ||
        desc(a.addedAt, b.addedAt) ||
        (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0),
    );
  }

  /** One project as `list` would show it, or null without a valid link. */
  entry(projectId: string, now: number): Entry | null {
    return this.entryOf(
      projectId,
      this.validLinks(now).filter((l) => l.projectId === projectId),
      this.retiredMap(),
    );
  }

  private entryOf(
    projectId: string,
    mine: Parsed[],
    retired: Map<string, number>,
  ): Entry | null {
    const best = pick(mine, retired);
    if (!best) return null;
    const title = this.map(ROOT.titles).get(projectId);
    const status = this.status(projectId);
    let state: State = "listed";
    if (status?.state === "forgotten") state = "forgotten";
    // A newer link learned later supersedes what an older one saw.
    else if (
      (status?.state === "removed" || status?.state === "gone") &&
      status.token === best.token
    )
      state = status.state;
    return {
      projectId,
      title: typeof title === "string" && title.trim() ? title.trim() : null,
      link: linkRef(best, retired),
      state,
      openedAt: num(this.map(ROOT.opened).get(projectId)),
      addedAt: Math.min(...mine.map((l) => l.addedAt)),
    };
  }

  /**
   * Records a link. Facts about a token never change: a token already
   * present only gets its `generation` filled in if it had none. Returns
   * whether anything was written; throws on a link that would not validate
   * on read.
   */
  addLink(link: NewLink): boolean {
    const problem = linkProblem(
      link.token,
      link.projectId,
      link.secret,
      link.edit,
    );
    if (problem) throw new Error(`not a valid link: ${problem}`);
    const links = this.map(ROOT.links);
    const existing = links.get(link.token);
    let value: Plain;
    if (parseLink(link.token, existing)) {
      if (
        link.generation === undefined ||
        num((existing as Plain)[LINK.generation]) !== null
      )
        return false;
      value = { ...(existing as Plain), [LINK.generation]: link.generation };
    } else {
      // Replacing a junk entry keeps whatever unknown keys it had.
      value = {
        ...(isPlain(existing) ? existing : {}),
        [LINK.projectId]: link.projectId,
        [LINK.secret]: link.secret,
        [LINK.edit]: link.edit,
        [LINK.addedAt]: link.addedAt,
        ...(link.generation === undefined
          ? {}
          : { [LINK.generation]: link.generation }),
      };
    }
    links.set(link.token, value);
    this.commit("add link");
    return true;
  }

  /**
   * Moves a valid link to `projectId`, keeping its secret, edit flag and
   * `addedAt`. For a token the server resolves to another project than the
   * directory filed it under: the token is fine, only the filing was wrong,
   * so retiring it would lose a working link. False when the token has no
   * valid entry or is already filed there.
   */
  refileLink(token: string, projectId: string): boolean {
    if (!projectId) return false;
    const links = this.map(ROOT.links);
    const existing = links.get(token);
    const parsed = parseLink(token, existing);
    if (!parsed || parsed.projectId === projectId) return false;
    links.set(token, { ...(existing as Plain), [LINK.projectId]: projectId });
    this.commit("refile link");
    return true;
  }

  /** Marks a token retired at `now` unless it already is. */
  retire(token: string, now: number): boolean {
    const retired = this.map(ROOT.retired);
    if (num(retired.get(token)) !== null) return false;
    retired.set(token, now);
    this.commit("retire link");
    return true;
  }

  /** Sets the title the person sees, trimmed. Empty titles are ignored. */
  setTitle(projectId: string, title: string): boolean {
    const next = title.trim();
    const titles = this.map(ROOT.titles);
    if (!next || titles.get(projectId) === next) return false;
    titles.set(projectId, next);
    this.commit("set title");
    return true;
  }

  /** Records that the project was opened, at most once per OPENED_REFRESH_MS. */
  touchOpened(projectId: string, now: number): boolean {
    const opened = this.map(ROOT.opened);
    const old = num(opened.get(projectId));
    if (old !== null && now < old + OPENED_REFRESH_MS) return false;
    opened.set(projectId, now);
    this.commit("open project");
    return true;
  }

  /**
   * Sets what is known about a project's standing. `token` names the link
   * that saw it, which "removed" and "gone" need to stay scoped to.
   */
  setStatus(
    projectId: string,
    state: State,
    now: number,
    token?: string,
  ): boolean {
    const current = this.status(projectId);
    if (current && current.state === state && current.token === (token ?? null))
      return false;
    const map = this.map(ROOT.status);
    const existing = map.get(projectId);
    // A stale token must not outlive the state it belonged to.
    const rest: Plain = { ...(isPlain(existing) ? existing : {}) };
    delete rest[STATUS.token];
    map.set(projectId, {
      ...rest,
      [STATUS.state]: state,
      [STATUS.at]: now,
      ...(token === undefined ? {} : { [STATUS.token]: token }),
    });
    this.commit("set status");
    return true;
  }

  private validOwnerKeys(
    projectId: string,
  ): (OwnerKeyRef & { id: string; addedAt: number })[] {
    const out: (OwnerKeyRef & { id: string; addedAt: number })[] = [];
    for (const [id, value] of Object.entries(
      this.map(ROOT.ownerKeys).toJSON(),
    )) {
      const slash = id.lastIndexOf("/");
      if (slash <= 0 || id.slice(0, slash) !== projectId) continue;
      const publicKey = id.slice(slash + 1);
      const addedAt = isPlain(value) ? num(value[OWNER_KEY.addedAt]) : null;
      if (addedAt === null) continue;
      const secret = ownerSecretOf(value, publicKey);
      if (secret) out.push({ id, publicKey, secret, addedAt });
    }
    return out.sort(
      (a, b) =>
        desc(a.addedAt, b.addedAt) ||
        (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0),
    );
  }

  /**
   * Records an owner key secret of a project (the bare 32 bytes) so the
   * person's other devices can rotate its links. One entry per secret,
   * never overwritten. Returns whether anything was written. Needs the wasm
   * loaded, like `ownerKeys`.
   *
   * Clients record only the owner key the server currently names (the
   * group's current owner secret, or the record's), never the whole set they
   * hold, so an old key cannot be re-planted after pruning.
   */
  addOwnerKey(projectId: string, secret: Uint8Array, now: number): boolean {
    const id = `${projectId}/${toHex(ownerPublicKeyOf(secret))}`;
    const map = this.map(ROOT.ownerKeys);
    const existing = map.get(id);
    if (ownerSecretOf(existing, id.slice(id.lastIndexOf("/") + 1)) !== null)
      return false;
    // Replacing a junk entry keeps whatever unknown keys it had.
    map.set(id, {
      ...(isPlain(existing) ? existing : {}),
      [OWNER_KEY.secret]: toBase64Url(secret),
      [OWNER_KEY.addedAt]: now,
    });
    this.commit("add owner key");
    return true;
  }

  /**
   * A project's owner keys whose secret derives the key they are filed
   * under, newest first, skipping ones dated in the future. Needs the wasm
   * loaded (`loadWasm`) to check them.
   */
  ownerKeys(projectId: string, now: number): OwnerKeyRef[] {
    return this.validOwnerKeys(projectId)
      .filter((k) => notFuture(k.addedAt, now))
      .map(({ publicKey, secret }) => ({
        publicKey,
        secret,
      }));
  }

  /**
   * Keeps the newest `keep` owner keys of a project and deletes the rest.
   * Future-dated entries count as the oldest, so planting them cannot push
   * real keys out. Returns how many it removed.
   */
  pruneOwnerKeys(
    projectId: string,
    now: number,
    keep = OWNER_KEYS_KEEP,
  ): number {
    const all = this.validOwnerKeys(projectId);
    const doomed = [
      ...all.filter((k) => notFuture(k.addedAt, now)),
      ...all.filter((k) => !notFuture(k.addedAt, now)),
    ].slice(keep);
    if (doomed.length === 0) return 0;
    for (const { id } of doomed) this.map(ROOT.ownerKeys).delete(id);
    this.commit("prune owner keys");
    return doomed.length;
  }

  /**
   * Drops links retired more than RETIRED_KEEP_MS ago, along with their
   * `retired` marks, except that a project always keeps one link (its best
   * among the old ones). Returns how many links it removed.
   */
  pruneRetired(now: number): number {
    const retired = this.retiredMap();
    const old = (l: Parsed) => {
      const at = retired.get(l.token);
      return at !== undefined && now - at > RETIRED_KEEP_MS;
    };
    const doomed: string[] = [];
    for (const mine of groupByProject(this.validLinks(now)).values()) {
      let prunable = mine.filter(old);
      if (prunable.length === mine.length) {
        const keep = pick(prunable, retired);
        prunable = prunable.filter((l) => l !== keep);
      }
      doomed.push(...prunable.map((l) => l.token));
    }
    if (doomed.length === 0) return 0;
    for (const token of doomed) {
      this.map(ROOT.links).delete(token);
      this.map(ROOT.retired).delete(token);
    }
    this.commit("prune retired links");
    return doomed.length;
  }
}
