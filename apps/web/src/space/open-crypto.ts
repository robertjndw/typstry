import {
  NewerVersionError,
  SpaceCrypto,
  viewSecretOf,
} from "@/crypto/space-crypto";
import { isEditSecret, secretKind } from "@/crypto/secret";
import { loadWasm } from "@/crypto/wasm";
import { fetchMlsBootstrap } from "@/sync/api";

import { loadKeyring, loadSpaceKey, saveKeyring } from "./space-links";

export const NO_KEYS =
  "The server has no encryption keys for this project, so it cannot be opened.";

/** The server holds no group, and so no keyring, for the space. */
export class NoKeyringError extends Error {
  constructor() {
    super(NO_KEYS);
    this.name = "NoKeyringError";
  }
}

/**
 * Opens the space's keys from the link's secret and the sealed keyring the
 * server stores (or the copy this browser kept, so a space opens offline).
 * A creator who opens their own view link (to check what others see) keeps
 * the edit secret this browser already holds, instead of being downgraded to
 * read-only for good.
 */
export async function openCrypto(
  token: string,
  spaceId: string,
  raw: string,
): Promise<SpaceCrypto> {
  await loadWasm();
  let secret = raw;
  if (secretKind(raw) === "view") {
    const stored = loadSpaceKey(spaceId);
    if (
      stored &&
      isEditSecret(stored) &&
      viewSecretOf(stored) === viewSecretOf(raw)
    )
      secret = stored;
  }
  const cached = loadKeyring(spaceId);
  if (cached) {
    try {
      return SpaceCrypto.open(secret, cached);
    } catch (error) {
      // A copy from before a rotation, say; the server's is checked next.
      if (error instanceof NewerVersionError) throw error;
    }
  }
  const bootstrap = await fetchMlsBootstrap(token);
  if (!bootstrap) throw new NoKeyringError();
  const crypto = SpaceCrypto.open(secret, bootstrap.keyring);
  saveKeyring(spaceId, bootstrap.keyring);
  return crypto;
}
