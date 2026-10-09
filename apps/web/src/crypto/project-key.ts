// End-to-end encryption key of a project. The raw key travels only in the
// URL fragment of share links (browsers never send fragments to the server)
// and in this browser's storage, so the server only ever sees ciphertext.

/** AES-256-GCM key bytes, base64url without padding (43 characters). */
const RAW_KEY_BYTES = 32;
const IV_BYTES = 12;

export interface ProjectKey {
  /** The shareable form, as it appears in the URL fragment. */
  readonly raw: string;
  /**
   * Short fingerprint sent in clear with every encrypted doc record. It lets
   * a client tell "this link carries the wrong key" apart from corrupted
   * data without revealing anything about the key itself.
   */
  readonly keyId: string;
  readonly key: CryptoKey;
}

export class KeyMismatchError extends Error {
  constructor(keyId: string) {
    super(
      `data is encrypted with key ${keyId}, which this link does not carry`,
    );
    this.name = "KeyMismatchError";
  }
}

/**
 * WebCrypto, fetch and Blob only take views backed by a plain ArrayBuffer,
 * while Loro and friends are typed as handing out any ArrayBufferLike.
 */
export function ownBuffer(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return view.buffer instanceof ArrayBuffer
    ? (view as Uint8Array<ArrayBuffer>)
    : new Uint8Array(view);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function isRawProjectKey(raw: string): boolean {
  return fromBase64Url(raw)?.length === RAW_KEY_BYTES;
}

export function generateRawProjectKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(RAW_KEY_BYTES)));
}

/** Rejects anything that is not exactly a base64url AES-256 key. */
export async function importProjectKey(raw: string): Promise<ProjectKey> {
  const bytes = fromBase64Url(raw);
  if (bytes?.length !== RAW_KEY_BYTES) throw new Error("malformed project key");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // Non-extractable: page code can encrypt with it but not read it back out
  // of the CryptoKey (the raw string still exists, but only where we put it).
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { raw, keyId: toBase64Url(digest.slice(0, 9)), key };
}

/**
 * Seals `plaintext` as `iv || ciphertext+tag`. `context` is bound in as
 * associated data so a blob can never be passed off as presence or vice
 * versa, even though both use the same key.
 */
export async function seal(
  key: ProjectKey,
  plaintext: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(context),
      },
      key.key,
      ownBuffer(plaintext),
    ),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

/** Inverse of `seal`; throws when the key or context does not match. */
export async function open(
  key: ProjectKey,
  sealed: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  if (sealed.length < IV_BYTES) throw new Error("sealed data is truncated");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownBuffer(sealed.subarray(0, IV_BYTES)),
        additionalData: new TextEncoder().encode(context),
      },
      key.key,
      ownBuffer(sealed.subarray(IV_BYTES)),
    ),
  );
}

export const BLOB_CONTEXT = "typstry:blob:v1";
export const PRESENCE_CONTEXT = "typstry:presence:v1";

/** Bytes `seal` adds: the IV and the GCM tag. */
export const SEAL_OVERHEAD = 12 + 16;
