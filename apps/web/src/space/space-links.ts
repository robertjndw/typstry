// Per-browser memory of a space (the generic half of what a browser keeps
// about a project or a personal directory): its share links, the encryption
// key of every space opened here, the sealed keyring the server last gave us
// for it, and what each share token resolved to (so a space opens offline).
import { fromBase64, toBase64 } from "@/crypto/bytes";
import { isProjectSecret } from "@/crypto/secret";
import { getStorage, readJson, removeKey, writeJson } from "@/lib/storage";
import type { StoredRotation } from "@/persist/local-doc-store";
import { parseShareInfo, type ShareInfo } from "@/sync/api";

// The values predate the rename to "space" and name what is already stored.
const LINKS_PREFIX = "typstry:links:";
const KEY_PREFIX = "typstry:key:";
const KEYRING_PREFIX = "typstry:keyring:";
const SHARE_PREFIX = "typstry:share:";

export interface ShareLinks {
  editToken: string;
  viewToken: string;
}

export function saveShareLinks(
  spaceId: string,
  links: ShareLinks,
  storage: Storage | null = getStorage(),
): void {
  writeJson(LINKS_PREFIX + spaceId, links, storage);
}

/** For a member who is no longer sent the edit link by a rotation. */
export function clearShareLinks(
  spaceId: string,
  storage: Storage | null = getStorage(),
): void {
  removeKey(LINKS_PREFIX + spaceId, storage);
}

export function loadShareLinks(
  spaceId: string,
  storage: Storage | null = getStorage(),
): ShareLinks | null {
  const value = readJson(
    LINKS_PREFIX + spaceId,
    storage,
  ) as Partial<ShareLinks> | null;
  if (
    typeof value?.editToken !== "string" ||
    typeof value.viewToken !== "string"
  )
    return null;
  return { editToken: value.editToken, viewToken: value.viewToken };
}

export function saveSpaceKey(
  spaceId: string,
  key: string,
  storage: Storage | null = getStorage(),
): void {
  writeJson(KEY_PREFIX + spaceId, key, storage);
}

export function loadSpaceKey(
  spaceId: string,
  storage: Storage | null = getStorage(),
): string | null {
  const value = readJson(KEY_PREFIX + spaceId, storage);
  return typeof value === "string" && isProjectSecret(value) ? value : null;
}

/**
 * The signed, sealed keyring as the server stores it, kept so a space
 * opens offline. It is only readable with the link, which this browser
 * stores next to it anyway.
 */
export function saveKeyring(
  spaceId: string,
  keyring: Uint8Array,
  storage: Storage | null = getStorage(),
): void {
  writeJson(KEYRING_PREFIX + spaceId, toBase64(keyring), storage);
}

export function loadKeyring(
  spaceId: string,
  storage: Storage | null = getStorage(),
): Uint8Array | null {
  const value = readJson(KEYRING_PREFIX + spaceId, storage);
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
  removeKey(SHARE_PREFIX + token, storage);
}

/** Drops the space's links, key, keyring and cached share lookups. */
export function forgetSpace(
  spaceId: string,
  storage: Storage | null = getStorage(),
): void {
  const shares: string[] = [];
  try {
    if (!storage) return;
    storage.removeItem(LINKS_PREFIX + spaceId);
    storage.removeItem(KEY_PREFIX + spaceId);
    storage.removeItem(KEYRING_PREFIX + spaceId);
    // Removing while iterating would shift the indices.
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(SHARE_PREFIX)) continue;
      const token = key.slice(SHARE_PREFIX.length);
      if (loadShare(token, storage)?.spaceId === spaceId) shares.push(token);
    }
  } catch {
    // Best effort, like every other storage access here.
  }
  for (const token of shares) forgetShare(token, storage);
}

/** Everything a space this browser just created needs to open again. */
export function rememberCreatedSpace(
  created: ShareLinks & { spaceId: string },
  key: string,
  storage: Storage | null = getStorage(),
): void {
  const { spaceId, editToken, viewToken } = created;
  saveShareLinks(spaceId, { editToken, viewToken }, storage);
  saveSpaceKey(spaceId, key, storage);
  rememberShare(editToken, { spaceId, permission: "write" }, storage);
  rememberShare(viewToken, { spaceId, permission: "read" }, storage);
}

/**
 * Stores the links of a rotation where the next visit finds them: the key
 * for the fragment and the tokens.
 */
export function storeRotation(
  spaceId: string,
  rotation: StoredRotation,
  storage: Storage | null = getStorage(),
): void {
  saveSpaceKey(spaceId, rotation.link, storage);
  if (rotation.canEdit && rotation.viewToken) {
    saveShareLinks(
      spaceId,
      { editToken: rotation.token, viewToken: rotation.viewToken },
      storage,
    );
    rememberShare(
      rotation.token,
      { spaceId, permission: "write", viewToken: rotation.viewToken },
      storage,
    );
    rememberShare(rotation.viewToken, { spaceId, permission: "read" }, storage);
  } else {
    // Not sent the edit link, e.g. a viewer: there is no other token.
    clearShareLinks(spaceId, storage);
    rememberShare(rotation.token, { spaceId, permission: "read" }, storage);
  }
}
