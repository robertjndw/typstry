// HTTP helpers for the space endpoints served by crates/typstry-server.
// The server never sees plaintext: these calls carry tokens and ciphertext only.
import { fromBase64, ownBuffer } from "@/crypto/bytes";
import { toError } from "@/lib/errors";

import { PROTOCOL_HEADER, PROTOCOL_VERSION, RELOAD_MESSAGE } from "./protocol";

export interface CreatedSpace {
  spaceId: string;
  editToken: string;
  viewToken: string;
}

export type SharePermission = "write" | "read";

export interface ShareInfo {
  spaceId: string;
  permission: SharePermission;
  /** Only present for edit tokens; view tokens never learn the edit link. */
  viewToken?: string;
  /**
   * The token was replaced when the links rotated. It still names the
   * project, but only the group's commit log can be read with it: that is
   * how a member finds the new links.
   */
  retired?: boolean;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** 426: the server no longer serves this build of the page. */
export class OutdatedClientError extends ApiError {
  constructor() {
    super(426, RELOAD_MESSAGE);
    this.name = "OutdatedClientError";
  }
}

/** fetch with the protocol header, turning a 426 into OutdatedClientError. */
export async function apiFetch(
  url: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
  const res = await fetchFn(url, { ...init, headers });
  if (res.status === 426) throw new OutdatedClientError();
  return res;
}

export const RATE_LIMITED_MESSAGE = "Too many requests. Try again in a moment.";

/** 429 that outlasted the retries in `apiFetchRetrying`. */
export class RateLimitedError extends ApiError {
  constructor() {
    super(429, RATE_LIMITED_MESSAGE);
    this.name = "RateLimitedError";
  }
}

/** How often a 429 is retried before the caller sees it. */
export const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 1000;
// A Retry-After can ask for minutes (a proxy's rate limit may refill
// slowly). Waiting that long behind a spinner is worse than telling the
// user and letting them retry.
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * What a Retry-After header asks for, in ms, or null when there is none
 * or it cannot be read. Traefik's rate limiter sends seconds; other proxies
 * may send a date.
 */
export function retryAfterMs(
  res: Response,
  now: number = Date.now(),
): number | null {
  const value = res.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(toError(signal.reason));
    const onAbort = () => {
      clearTimeout(timer);
      reject(toError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `apiFetch` for calls the reverse proxy in front of the server may rate
 * limit per address (the provided compose.prod.yaml does): a 429 is tried
 * again a few times, backing off or waiting as long as Retry-After says,
 * and then thrown as RateLimitedError. Only for requests that are safe to
 * send twice; a 429 means the first one was turned away before it did
 * anything.
 */
export async function apiFetchRetrying(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await apiFetch(url, init);
    if (res.status !== 429) return res;
    if (attempt >= RATE_LIMIT_RETRIES) throw new RateLimitedError();
    const backoff = RATE_LIMIT_BASE_MS * 2 ** attempt;
    await sleep(
      Math.min(retryAfterMs(res) ?? backoff, MAX_RETRY_AFTER_MS),
      init.signal,
    );
  }
}

export interface ApiOptions {
  /** Origin to talk to; empty means same origin (the Vite proxy in dev). */
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Registers an empty space. The title and starter files are content, so
 * the creator seeds the doc locally and it reaches the server encrypted.
 */
export async function createSpace(
  opts: ApiOptions = {},
): Promise<CreatedSpace> {
  const res = await apiFetchRetrying(`${opts.baseUrl ?? ""}/api/spaces`, {
    method: "POST",
    signal: opts.signal,
  });
  if (!res.ok)
    throw new ApiError(res.status, `creating project failed: ${res.status}`);
  return (await res.json()) as CreatedSpace;
}

/** Looks up a share token. Returns null when the token is unknown. */
export async function resolveShare(
  token: string,
  opts: ApiOptions = {},
): Promise<ShareInfo | null> {
  const res = await apiFetch(
    `${opts.baseUrl ?? ""}/api/share/${encodeURIComponent(token)}`,
    { signal: opts.signal },
  );
  if (res.status === 404) return null;
  if (!res.ok)
    throw new ApiError(res.status, `resolving share failed: ${res.status}`);
  const share = parseShareInfo(await res.json());
  if (!share)
    throw new ApiError(res.status, "resolving share returned a malformed body");
  return share;
}

/** A starting point an admin offers: a repository, optionally a ref and folder. */
export interface GitTemplate {
  name: string;
  description?: string;
  url: string;
  ref?: string;
  path?: string;
}

export interface TemplateInfo {
  /** Whether the server relays Git traffic at all. */
  gitImport: boolean;
  templates: GitTemplate[];
}

/**
 * What the server offers for starting from Git. Any failure reads as "not
 * offered": the start page works without it.
 */
export async function fetchTemplates(
  opts: ApiOptions = {},
): Promise<TemplateInfo> {
  const off: TemplateInfo = { gitImport: false, templates: [] };
  try {
    const res = await apiFetch(`${opts.baseUrl ?? ""}/api/templates`, {
      signal: opts.signal,
    });
    if (!res.ok) return off;
    const body = (await res.json()) as Record<string, unknown>;
    if (body.gitImport !== true) return off;
    const list = Array.isArray(body.templates) ? body.templates : [];
    const templates = list.flatMap((t): GitTemplate[] => {
      const item = t as Record<string, unknown> | null;
      if (typeof item?.name !== "string" || typeof item.url !== "string")
        return [];
      const optional = (v: unknown) => (typeof v === "string" ? v : undefined);
      return [
        {
          name: item.name,
          url: item.url,
          description: optional(item.description),
          ref: optional(item.ref),
          path: optional(item.path),
        },
      ];
    });
    return { gitImport: true, templates };
  } catch {
    return off;
  }
}

/** What a newcomer needs to open a project and join its MLS group. */
export interface MlsBootstrap {
  incarnation: number;
  /** The epoch the GroupInfo describes; it can trail the group's head. */
  epoch: number;
  /** Sealed under the link; opens only with it. */
  groupInfo: Uint8Array;
  /** Sealed under the link and signed by an editor. */
  keyring: Uint8Array;
  /**
   * The public owner key the server holds, 32 bytes: which owner key
   * secret is the current one, which the group itself cannot tell.
   */
  ownerKey: Uint8Array;
}

/**
 * The sealed GroupInfo and keyring of a project. Null when the token is
 * unknown or the project has no group, which only a project that was never
 * opened by its creator can lack.
 */
export async function fetchMlsBootstrap(
  token: string,
  opts: ApiOptions = {},
): Promise<MlsBootstrap | null> {
  const res = await apiFetch(
    `${opts.baseUrl ?? ""}/api/s/${encodeURIComponent(token)}/mls`,
    { signal: opts.signal, cache: "no-store" },
  );
  if (res.status === 404) return null;
  if (!res.ok)
    throw new ApiError(
      res.status,
      `fetching the keyring failed: ${res.status}`,
    );
  const body = (await res.json()) as Record<string, unknown>;
  const groupInfo =
    typeof body.groupInfo === "string" ? fromBase64(body.groupInfo) : null;
  const keyring =
    typeof body.keyring === "string" ? fromBase64(body.keyring) : null;
  const ownerKey =
    typeof body.ownerKey === "string" ? fromBase64(body.ownerKey) : null;
  if (
    !groupInfo ||
    !keyring ||
    ownerKey?.length !== 32 ||
    typeof body.incarnation !== "number" ||
    typeof body.epoch !== "number"
  )
    throw new ApiError(res.status, "the keyring response was malformed");
  return {
    incarnation: body.incarnation,
    epoch: body.epoch,
    groupInfo,
    keyring,
    ownerKey,
  };
}

/**
 * Checks an untrusted value (a response body, a cached copy) against the
 * `ShareInfo` shape, dropping fields of the wrong type.
 */
export function parseShareInfo(value: unknown): ShareInfo | null {
  const v = value as Partial<ShareInfo> | null;
  if (
    typeof v?.spaceId !== "string" ||
    (v.permission !== "write" && v.permission !== "read")
  )
    return null;
  const share: ShareInfo = { spaceId: v.spaceId, permission: v.permission };
  if (typeof v.viewToken === "string") share.viewToken = v.viewToken;
  if (v.retired === true) share.retired = true;
  return share;
}

/** Upload limit enforced by the server (413 above it). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Not retried: the quota only grows back if the server operator raises it.
export const STORAGE_FULL_MESSAGE = "This project's storage is full";

export interface StoredBlob {
  /** `sha256:<hex>` of the uploaded (encrypted) bytes. */
  hash: string;
  size: number;
}

/**
 * Stores already encrypted bytes in the project's blob store. The caller
 * still has to create the asset node in the doc; until then nobody sees the
 * upload. `name` only shapes error messages; it is not sent.
 */
export async function uploadBlob(
  token: string,
  sealed: Uint8Array,
  name: string,
  opts: ApiOptions = {},
): Promise<StoredBlob> {
  const res = await apiFetchRetrying(
    `${opts.baseUrl ?? ""}/api/s/${encodeURIComponent(token)}/assets`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: ownBuffer(sealed),
      signal: opts.signal,
    },
  );
  if (!res.ok) {
    const reason =
      res.status === 413
        ? `${name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`
        : res.status === 507
          ? STORAGE_FULL_MESSAGE
          : res.status === 403
            ? "This link is read-only"
            : `uploading ${name} failed: ${res.status}`;
    throw new ApiError(res.status, reason);
  }
  return (await res.json()) as StoredBlob;
}

export function blobUrl(
  token: string,
  hash: string,
  opts: Pick<ApiOptions, "baseUrl"> = {},
): string {
  return `${opts.baseUrl ?? ""}/api/s/${encodeURIComponent(token)}/blobs/${encodeURIComponent(hash)}`;
}
