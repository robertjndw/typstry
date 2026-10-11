// Per-browser memory of projects: a "recent" list for the home page, the
// share links of projects created here, the encryption key of every project
// opened here, the sealed keyring the server last gave us for it, and what
// each share token resolved to (so a project opens offline).
import { fromBase64, toBase64 } from "@/crypto/bytes";
import { isProjectSecret } from "@/crypto/secret";
import { getStorage, readJson, writeJson } from "@/lib/storage";
import { parseShareInfo, type ShareInfo } from "@/sync/api";

export const RECENT_KEY = "typstry:recent";
const LINKS_PREFIX = "typstry:links:";
const KEY_PREFIX = "typstry:key:";
const KEYRING_PREFIX = "typstry:keyring:";
const SHARE_PREFIX = "typstry:share:";
const MAX_RECENT = 12;

export interface RecentProject {
  projectId: string;
  /** The token this browser opens the project with. */
  token: string;
  title: string;
  visitedAt: number;
}

export interface ShareLinks {
  editToken: string;
  viewToken: string;
}

function isRecent(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.projectId === "string" &&
    typeof v.token === "string" &&
    typeof v.title === "string" &&
    typeof v.visitedAt === "number"
  );
}

export function loadRecent(
  storage: Storage | null = getStorage(),
): RecentProject[] {
  const value = readJson(RECENT_KEY, storage);
  return Array.isArray(value) ? value.filter(isRecent) : [];
}

/**
 * Moves the project to the top. A creator who opens the view link (to check
 * what others see) keeps the edit link in the list.
 */
export function rememberProject(
  entry: Omit<RecentProject, "visitedAt">,
  storage: Storage | null = getStorage(),
  now = Date.now(),
): void {
  const list = loadRecent(storage);
  const token =
    loadShareLinks(entry.projectId, storage)?.editToken ?? entry.token;
  const next: RecentProject[] = [
    { ...entry, token, visitedAt: now },
    ...list.filter((p) => p.projectId !== entry.projectId),
  ].slice(0, MAX_RECENT);
  writeJson(RECENT_KEY, next, storage);
}

/**
 * Follows a rename (ours or a collaborator's) without bumping the project
 * to the top, which only a visit does.
 */
export function updateRecentTitle(
  projectId: string,
  title: string,
  storage: Storage | null = getStorage(),
): void {
  const list = loadRecent(storage);
  const entry = list.find((p) => p.projectId === projectId);
  if (!entry || entry.title === title) return;
  entry.title = title;
  writeJson(RECENT_KEY, list, storage);
}

export function saveShareLinks(
  projectId: string,
  links: ShareLinks,
  storage: Storage | null = getStorage(),
): void {
  writeJson(LINKS_PREFIX + projectId, links, storage);
}

/** For a member who is no longer sent the edit link by a rotation. */
export function clearShareLinks(
  projectId: string,
  storage: Storage | null = getStorage(),
): void {
  try {
    storage?.removeItem(LINKS_PREFIX + projectId);
  } catch {
    // Best effort, like every other storage access here.
  }
}

export function loadShareLinks(
  projectId: string,
  storage: Storage | null = getStorage(),
): ShareLinks | null {
  const value = readJson(
    LINKS_PREFIX + projectId,
    storage,
  ) as Partial<ShareLinks> | null;
  if (
    typeof value?.editToken !== "string" ||
    typeof value.viewToken !== "string"
  )
    return null;
  return { editToken: value.editToken, viewToken: value.viewToken };
}

/**
 * The secret rides in the fragment, which browsers never send to the
 * server, so a share link carries everything needed to decrypt the project.
 * Edit links carry the edit secret, view links only the view secret.
 */
export function projectUrl(
  token: string,
  key: string,
  origin = window.location.origin,
) {
  return `${origin}/p/${encodeURIComponent(token)}#${key}`;
}

export function saveProjectKey(
  projectId: string,
  key: string,
  storage: Storage | null = getStorage(),
): void {
  writeJson(KEY_PREFIX + projectId, key, storage);
}

export function loadProjectKey(
  projectId: string,
  storage: Storage | null = getStorage(),
): string | null {
  const value = readJson(KEY_PREFIX + projectId, storage);
  return typeof value === "string" && isProjectSecret(value) ? value : null;
}

/**
 * The signed, sealed keyring as the server stores it, kept so a project
 * opens offline. It is only readable with the link, which this browser
 * stores next to it anyway.
 */
export function saveKeyring(
  projectId: string,
  keyring: Uint8Array,
  storage: Storage | null = getStorage(),
): void {
  writeJson(KEYRING_PREFIX + projectId, toBase64(keyring), storage);
}

export function loadKeyring(
  projectId: string,
  storage: Storage | null = getStorage(),
): Uint8Array | null {
  const value = readJson(KEYRING_PREFIX + projectId, storage);
  return typeof value === "string" ? fromBase64(value) : null;
}

export function rememberShare(
  token: string,
  share: ShareInfo,
  storage: Storage | null = getStorage(),
): void {
  writeJson(SHARE_PREFIX + token, share, storage);
}

/** What `token` resolved to the last time this browser was online. */
export function loadShare(
  token: string,
  storage: Storage | null = getStorage(),
): ShareInfo | null {
  return parseShareInfo(readJson(SHARE_PREFIX + token, storage));
}

export function forgetShare(
  token: string,
  storage: Storage | null = getStorage(),
): void {
  try {
    storage?.removeItem(SHARE_PREFIX + token);
  } catch {
    // Same as every other storage access here: best effort.
  }
}

/** Drops the project's recent entry, links, key and cached share lookups. */
export function forgetProject(
  projectId: string,
  storage: Storage | null = getStorage(),
): void {
  writeJson(
    RECENT_KEY,
    loadRecent(storage).filter((p) => p.projectId !== projectId),
    storage,
  );
  const shares: string[] = [];
  try {
    if (!storage) return;
    storage.removeItem(LINKS_PREFIX + projectId);
    storage.removeItem(KEY_PREFIX + projectId);
    storage.removeItem(KEYRING_PREFIX + projectId);
    // Removing while iterating would shift the indices.
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(SHARE_PREFIX)) continue;
      const token = key.slice(SHARE_PREFIX.length);
      if (loadShare(token, storage)?.projectId === projectId)
        shares.push(token);
    }
  } catch {
    // Best effort, like every other storage access here.
  }
  for (const token of shares) forgetShare(token, storage);
}
