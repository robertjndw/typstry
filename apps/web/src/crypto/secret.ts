// What a link fragment looks like, without the crypto. The home screen and
// the recent list have to tell usable secrets from junk synchronously and
// without loading the wasm, so this only looks at the shape. Whether a
// secret really parses (the view key's public half is a valid point, say)
// is the wasm's call when the project opens; space-crypto.test.ts keeps
// the two in agreement.
import { fromBase64Url } from "./bytes";

/** First byte of an edit secret, followed by 32 key bytes. */
const SECRET_EDIT_V1 = 1;
/** First byte of a view secret, followed by the view key and public key. */
const SECRET_VIEW_V1 = 2;

const SECRET_BYTES = 32;
const VIEW_KEY_BYTES = 64;

export type SecretKind = "edit" | "view" | "newer";

/**
 * What a link fragment holds: an edit or view secret, one of a kind only a
 * newer typstry knows, or nothing usable.
 */
export function secretKind(raw: string): SecretKind | null {
  const bytes = fromBase64Url(raw);
  if (!bytes?.length) return null;
  const keyLength = bytes.length - 1;
  if (bytes[0] === SECRET_EDIT_V1)
    return keyLength === SECRET_BYTES ? "edit" : null;
  if (bytes[0] === SECRET_VIEW_V1)
    return keyLength === VIEW_KEY_BYTES ? "view" : null;
  // No kind was ever 0, so this is a corrupt key, not a newer one.
  if (bytes[0] === 0) return null;
  // Too short to carry a key, so a truncated link rather than a newer one.
  if (bytes.length <= SECRET_BYTES || bytes.length === VIEW_KEY_BYTES)
    return null;
  return "newer";
}

/** An edit or view secret this build can use, as found in a link fragment. */
export function isProjectSecret(raw: string): boolean {
  const kind = secretKind(raw);
  return kind === "edit" || kind === "view";
}

export function isEditSecret(raw: string): boolean {
  return secretKind(raw) === "edit";
}
