// HTTP helpers for the project endpoints served by crates/typstry-server.
// Nothing sent here is readable by the server: project content only ever
// travels encrypted, so these calls carry tokens and ciphertext alone.
import { ownBuffer } from "@/crypto/project-key";

import { PROTOCOL_HEADER, PROTOCOL_VERSION, RELOAD_MESSAGE } from "./protocol";

export interface CreatedProject {
  projectId: string;
  editToken: string;
  viewToken: string;
}

export type SharePermission = "write" | "read";

export interface ShareInfo {
  projectId: string;
  permission: SharePermission;
  /** Only present for edit tokens; view tokens never learn the edit link. */
  viewToken?: string;
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

export interface ApiOptions {
  /** Origin to talk to; empty means same origin (the Vite proxy in dev). */
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Registers an empty project. The title and starter files are content, so
 * the creator seeds the doc locally and it reaches the server encrypted.
 */
export async function createProject(
  opts: ApiOptions = {},
): Promise<CreatedProject> {
  const res = await apiFetch(`${opts.baseUrl ?? ""}/api/projects`, {
    method: "POST",
    signal: opts.signal,
  });
  if (!res.ok)
    throw new ApiError(res.status, `creating project failed: ${res.status}`);
  return (await res.json()) as CreatedProject;
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

/**
 * Checks an untrusted value (a response body, a cached copy) against the
 * `ShareInfo` shape, dropping fields of the wrong type.
 */
export function parseShareInfo(value: unknown): ShareInfo | null {
  const v = value as Partial<ShareInfo> | null;
  if (
    typeof v?.projectId !== "string" ||
    (v.permission !== "write" && v.permission !== "read")
  )
    return null;
  const share: ShareInfo = { projectId: v.projectId, permission: v.permission };
  if (typeof v.viewToken === "string") share.viewToken = v.viewToken;
  return share;
}

/** Upload limit enforced by the server (413 above it). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
  const res = await apiFetch(
    `${opts.baseUrl ?? ""}/api/p/${encodeURIComponent(token)}/assets`,
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
  return `${opts.baseUrl ?? ""}/api/p/${encodeURIComponent(token)}/blobs/${encodeURIComponent(hash)}`;
}
