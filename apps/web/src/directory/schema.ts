// Names must stay in sync with crates/typstry-doc/src/directory.rs, which
// models the same containers in Rust. Everything lives in flat root maps of
// plain values: a child container per entry would conflict whenever two
// devices create the same one at once.

/**
 * Bumped when an older client writing into the directory would corrupt it,
 * same rules as SCHEMA_VERSION of a project. Must match
 * DIRECTORY_SCHEMA_VERSION in crates/typstry-doc.
 */
export const DIRECTORY_SCHEMA_VERSION = 1;

export const ROOT = {
  /** Shared with projects: `kind` and `schema`. */
  meta: "meta",
  /** Share token -> link. */
  links: "links",
  /** Share token -> unix ms when it was seen retired. */
  retired: "retired",
  /** Project id -> title. */
  titles: "titles",
  /** Project id -> unix ms of the last open. */
  opened: "opened",
  /** Project id -> status. */
  status: "status",
  /** `"<projectId>/<owner public key hex>"` -> `{secret, addedAt}`. */
  ownerKeys: "ownerKeys",
} as const;

export const LINK = {
  projectId: "projectId",
  secret: "secret",
  edit: "edit",
  addedAt: "addedAt",
  /** Stored and parsed for compatibility, never used for ranking. */
  generation: "generation",
} as const;

export const STATUS = {
  state: "state",
  at: "at",
  token: "token",
} as const;

export const OWNER_KEY = {
  /** The 32 byte owner secret, base64url without padding. */
  secret: "secret",
  addedAt: "addedAt",
} as const;

/** Owner keys kept per project: every rotation adds one. */
export const OWNER_KEYS_KEEP = 8;

export const STATES = ["listed", "forgotten", "removed", "gone"] as const;
export type State = (typeof STATES)[number];

/** touchOpened skips a write unless the old one is at least this old. */
export const OPENED_REFRESH_MS = 60 * 60 * 1000;

/** How long a retired link is kept before pruneRetired drops it. */
export const RETIRED_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Entries dated further than this past `now` are ignored on read, so a
 * device that is later revoked cannot plant a far-future `addedAt` to win
 * every ranking for good. A day covers honest clock skew.
 */
export const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
