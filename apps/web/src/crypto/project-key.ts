// End-to-end encryption of a project, mirroring
// crates/typstry-wire/src/crypto.rs. The secrets travel only in the URL
// fragment of share links (browsers never send fragments to the server) and
// in this browser's storage, so the server only ever sees ciphertext.
//
// An edit link carries a 32-byte edit secret. HKDF-SHA256 derives two keys
// from it: the read key, which encrypts everything, and an Ed25519 signing
// key. A view link carries the read key and the public key, so viewers can
// decrypt and verify doc records but not write ones others accept, however
// the server behaves.
//
// Nothing is encrypted under the read key directly: every message draws a
// random 16-byte salt and uses AES-256-GCM under HKDF(read key, salt,
// purpose). That lifts the limit of about 2^32 random nonces per GCM key
// and keeps blobs, presence and doc records under separate keys.
//
// Every format starts with a version byte (secrets with a kind byte), which
// is authenticated with the rest. A byte this build does not know means a
// newer typstry wrote the data, and throws NewerVersionError instead of a
// plain decryption failure.
import {
  BytesWriter,
  EloRecordKind,
  parseEloRecordHeader,
  type EloDeltaHeader,
  type EloSnapshotHeader,
  type EloSnapshotVVEntry,
} from "loro-protocol";

/** First byte of a sealed blob or presence update. */
export const SEAL_VERSION = 1;
/** First byte of a doc record's ciphertext field. */
export const RECORD_VERSION = 1;
/** First byte of an edit secret, followed by 32 key bytes. */
export const SECRET_EDIT_V1 = 1;
/** First byte of a view secret, followed by the read and public keys. */
export const SECRET_VIEW_V1 = 2;

const SECRET_BYTES = 32;
/** The read key followed by the public key. */
const VIEW_KEY_BYTES = 64;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const SIGNATURE_BYTES = 64;
const KEY_ID_BYTES = 9;

export const BLOB_CONTEXT = "typstry:v2:blob";
export const PRESENCE_CONTEXT = "typstry:v2:presence";
const RECORD_CONTEXT = "typstry:v2:record";
const SIGNATURE_CONTEXT = "typstry:v2:record-signature";
const READ_INFO = "typstry:v2:read";
const SIGN_INFO = "typstry:v2:sign";
const KEY_ID_INFO = "typstry:v2:key-id";

/** Bytes `seal` adds: the version, the salt, the IV and the GCM tag. */
export const SEAL_OVERHEAD = 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;

// PKCS #8 wrapping of a raw Ed25519 seed (RFC 8410), the only way
// WebCrypto takes one.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

export interface ProjectKey {
  /**
   * Short fingerprint sent in clear with every encrypted doc record. It lets
   * a client tell "this link carries the wrong key" apart from corrupted
   * data without revealing anything about the key itself.
   */
  readonly keyId: string;
  /** The shareable edit secret, when this key came from an edit link. */
  readonly editSecret: string | null;
  /** The shareable view secret, which every key can produce. */
  readonly viewSecret: string;
  /** HKDF base key every message key is derived from. */
  readonly read: CryptoKey;
  readonly verify: CryptoKey;
  /** Only edit secrets carry it. */
  readonly sign: CryptoKey | null;
}

export class KeyMismatchError extends Error {
  constructor(keyId: string) {
    super(
      `data is encrypted with key ${keyId}, which this link does not carry`,
    );
    this.name = "KeyMismatchError";
  }
}

/** The version or kind byte is one this build does not know. */
export class NewerVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `made by a newer version of typstry (format ${version}); reload to update`,
    );
    this.name = "NewerVersionError";
    this.version = version;
  }
}

/** Written by someone who can read the project but holds no edit link. */
export class BadSignatureError extends Error {
  constructor() {
    super("record is not signed with the project's edit key");
    this.name = "BadSignatureError";
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

/**
 * What a link fragment holds: an edit or view secret, one of a kind only a
 * newer typstry knows, or nothing usable.
 */
export function secretKind(raw: string): "edit" | "view" | "newer" | null {
  const bytes = fromBase64Url(raw);
  if (!bytes?.length) return null;
  const kind = bytes[0];
  const keyLength = bytes.length - 1;
  if (kind === SECRET_EDIT_V1)
    return keyLength === SECRET_BYTES ? "edit" : null;
  if (kind === SECRET_VIEW_V1)
    return keyLength === VIEW_KEY_BYTES ? "view" : null;
  // Too short to carry a key, so a truncated link rather than a newer one.
  // Secrets from before the kind byte were 32 or 64 bytes; their first byte
  // is random and must not read as a version either.
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

export function generateEditSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(1 + SECRET_BYTES));
  bytes[0] = SECRET_EDIT_V1;
  return toBase64Url(bytes);
}

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hkdfParams(salt: Uint8Array, info: Uint8Array): HkdfParams {
  return {
    name: "HKDF",
    hash: "SHA-256",
    salt: ownBuffer(salt),
    info: ownBuffer(info),
  };
}

async function hkdfBits(
  base: CryptoKey,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      hkdfParams(new Uint8Array(), info),
      base,
      bytes * 8,
    ),
  );
}

function importHkdf(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ownBuffer(bytes), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
}

/**
 * Rejects anything that is not exactly an edit or view secret, with a
 * NewerVersionError for a kind only a newer typstry knows.
 */
export async function importProjectKey(raw: string): Promise<ProjectKey> {
  const kind = secretKind(raw);
  const bytes = fromBase64Url(raw);
  let readBytes: Uint8Array<ArrayBuffer>;
  let publicBytes: Uint8Array<ArrayBuffer>;
  let sign: CryptoKey | null = null;
  if (!bytes || kind === null) throw new Error("malformed project key");
  if (kind === "newer") throw new NewerVersionError(bytes[0]!);
  if (kind === "edit") {
    const edit = await importHkdf(bytes.subarray(1));
    readBytes = await hkdfBits(edit, encoder.encode(READ_INFO), SECRET_BYTES);
    const seed = await hkdfBits(edit, encoder.encode(SIGN_INFO), SECRET_BYTES);
    const pkcs8 = concat(ED25519_PKCS8_PREFIX, seed);
    // WebCrypto cannot derive a public key, but its JWK export of the
    // private key includes it. Only this throwaway copy is extractable.
    const exportable = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      "Ed25519",
      true,
      ["sign"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", exportable);
    const x = jwk.x ? fromBase64Url(jwk.x) : null;
    if (x?.length !== 32) throw new Error("Ed25519 public key unavailable");
    publicBytes = x;
    sign = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, [
      "sign",
    ]);
  } else {
    readBytes = bytes.slice(1, 1 + SECRET_BYTES);
    publicBytes = bytes.slice(1 + SECRET_BYTES);
  }
  // Non-extractable: page code can use these but not read them back out.
  // The secret strings still exist, but only where we put them.
  const [read, verify] = await Promise.all([
    importHkdf(readBytes),
    crypto.subtle
      .importKey("raw", publicBytes, "Ed25519", false, ["verify"])
      .catch(() => {
        throw new Error("malformed project key");
      }),
  ]);
  // Covers the public key too, so a view link whose halves come from
  // different projects shows up as a key mismatch.
  const keyId = toBase64Url(
    await hkdfBits(
      read,
      concat(encoder.encode(KEY_ID_INFO), publicBytes),
      KEY_ID_BYTES,
    ),
  );
  return {
    keyId,
    editSecret: sign ? raw : null,
    viewSecret: toBase64Url(
      concat(Uint8Array.of(SECRET_VIEW_V1), readBytes, publicBytes),
    ),
    read,
    verify,
    sign,
  };
}

function messageKey(
  key: ProjectKey,
  salt: Uint8Array,
  context: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    hkdfParams(salt, encoder.encode(context)),
    key.read,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

async function gcmEncrypt(
  key: ProjectKey,
  salt: Uint8Array,
  iv: Uint8Array,
  context: string,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownBuffer(iv),
        additionalData: ownBuffer(aad),
      },
      await messageKey(key, salt, context, "encrypt"),
      ownBuffer(plaintext),
    ),
  );
}

async function gcmDecrypt(
  key: ProjectKey,
  salt: Uint8Array,
  iv: Uint8Array,
  context: string,
  ct: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownBuffer(iv),
        additionalData: ownBuffer(aad),
      },
      await messageKey(key, salt, context, "decrypt"),
      ownBuffer(ct),
    ),
  );
}

/** Bound into the AEAD so data cannot be relabelled as another version. */
function versionedAad(version: number, aad: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(version), aad);
}

/**
 * Seals `plaintext` as `version || salt || iv || ciphertext+tag`.
 * `context` picks the message key and is bound in as associated data, so a
 * blob can never be passed off as presence or vice versa.
 */
export async function seal(
  key: ProjectKey,
  plaintext: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aad = versionedAad(SEAL_VERSION, encoder.encode(context));
  return concat(
    Uint8Array.of(SEAL_VERSION),
    salt,
    iv,
    await gcmEncrypt(key, salt, iv, context, plaintext, aad),
  );
}

/**
 * Inverse of `seal`; throws when the key or context does not match, and a
 * NewerVersionError for data a newer typstry sealed.
 */
export async function open(
  key: ProjectKey,
  sealed: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  if (sealed.length === 0) throw new Error("sealed data is truncated");
  const version = sealed[0]!;
  if (version !== SEAL_VERSION) throw new NewerVersionError(version);
  if (sealed.length < SEAL_OVERHEAD)
    throw new Error("sealed data is truncated");
  const ivAt = 1 + SALT_BYTES;
  return gcmDecrypt(
    key,
    sealed.subarray(1, ivAt),
    sealed.subarray(ivAt, ivAt + IV_BYTES),
    context,
    sealed.subarray(ivAt + IV_BYTES),
    versionedAad(version, encoder.encode(context)),
  );
}

// loro-protocol only exports encoders that encrypt with the key directly,
// so the headers are built here, byte for byte like its own.
function deltaHeader(
  peer: string,
  start: number,
  end: number,
  keyId: string,
  iv: Uint8Array,
): Uint8Array {
  const w = new BytesWriter();
  w.pushByte(EloRecordKind.DeltaSpan);
  w.pushVarBytes(encoder.encode(peer));
  w.pushUleb128(start);
  w.pushUleb128(end);
  w.pushVarString(keyId);
  w.pushVarBytes(iv);
  return w.finalize();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function snapshotHeader(
  vv: EloSnapshotVVEntry[],
  keyId: string,
  iv: Uint8Array,
): Uint8Array {
  // Parsers reject entries not sorted by the peer id's bytes. That is not
  // numeric order: "10" sorts before "9".
  const sorted = [...vv].sort((a, b) => compareBytes(a.peerId, b.peerId));
  const w = new BytesWriter();
  w.pushByte(EloRecordKind.Snapshot);
  w.pushUleb128(sorted.length);
  for (const { peerId, counter } of sorted) {
    w.pushVarBytes(peerId);
    w.pushUleb128(counter);
  }
  w.pushVarString(keyId);
  w.pushVarBytes(iv);
  return w.finalize();
}

/** Fixed nonces, for tests that need byte-stable records only. */
export interface RecordNonces {
  iv: Uint8Array;
  salt: Uint8Array;
}

function freshNonces(): RecordNonces {
  return {
    iv: crypto.getRandomValues(new Uint8Array(IV_BYTES)),
    salt: crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
  };
}

/**
 * A record's ciphertext field is `version || salt || ciphertext+tag ||
 * signature`, the signature covering the header and everything before it.
 * The header itself is fixed by loro-protocol and read by the server, so
 * the version cannot go there.
 */
async function sealRecord(
  key: ProjectKey,
  header: Uint8Array,
  { iv, salt }: RecordNonces,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (!key.sign) throw new Error("a view-only key cannot sign records");
  const ct = await gcmEncrypt(
    key,
    salt,
    iv,
    RECORD_CONTEXT,
    plaintext,
    versionedAad(RECORD_VERSION, header),
  );
  const body = concat(Uint8Array.of(RECORD_VERSION), salt, ct);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key.sign,
      concat(encoder.encode(SIGNATURE_CONTEXT), header, body),
    ),
  );
  const w = new BytesWriter();
  w.pushBytes(header);
  w.pushVarBytes(concat(body, signature));
  return w.finalize();
}

/** Encrypts and signs the Loro updates for ops `[start, end)` of `peer`. */
export function encryptDelta(
  key: ProjectKey,
  span: { peer: string; start: number; end: number },
  plaintext: Uint8Array,
  nonces: RecordNonces = freshNonces(),
): Promise<Uint8Array> {
  if (!(span.end > span.start))
    throw new Error(`delta span ${span.start}..${span.end} is empty`);
  const header = deltaHeader(
    span.peer,
    span.start,
    span.end,
    key.keyId,
    nonces.iv,
  );
  return sealRecord(key, header, nonces, plaintext);
}

/** Encrypts and signs a Loro snapshot covering `vv`. */
export function encryptSnapshot(
  key: ProjectKey,
  vv: EloSnapshotVVEntry[],
  plaintext: Uint8Array,
  nonces: RecordNonces = freshNonces(),
): Promise<Uint8Array> {
  return sealRecord(
    key,
    snapshotHeader(vv, key.keyId, nonces.iv),
    nonces,
    plaintext,
  );
}

export type DecryptedRecord =
  | {
      kind: typeof EloRecordKind.DeltaSpan;
      header: EloDeltaHeader;
      plaintext: Uint8Array;
    }
  | {
      kind: typeof EloRecordKind.Snapshot;
      header: EloSnapshotHeader;
      plaintext: Uint8Array;
    };

/**
 * Parses, verifies and decrypts one record. The signature is checked
 * first, so a record a viewer forged is refused whatever it decrypts to.
 * Throws a NewerVersionError for a record a newer typstry wrote.
 */
export async function decryptRecord(
  key: ProjectKey,
  record: Uint8Array,
): Promise<DecryptedRecord> {
  const parsed = parseEloRecordHeader(record);
  if (parsed.keyId !== key.keyId) throw new KeyMismatchError(parsed.keyId);
  const { ct: field, aad } = parsed;
  if (field.length === 0) throw new Error("record is truncated");
  const version = field[0]!;
  // Before the signature: a newer version may well sign differently.
  if (version !== RECORD_VERSION) throw new NewerVersionError(version);
  if (field.length < 1 + SALT_BYTES + TAG_BYTES + SIGNATURE_BYTES)
    throw new Error("record is truncated");
  const body = field.subarray(0, field.length - SIGNATURE_BYTES);
  const signature = field.subarray(field.length - SIGNATURE_BYTES);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key.verify,
    ownBuffer(signature),
    concat(encoder.encode(SIGNATURE_CONTEXT), aad, body),
  );
  if (!valid) throw new BadSignatureError();
  const plaintext = await gcmDecrypt(
    key,
    body.subarray(1, 1 + SALT_BYTES),
    parsed.iv,
    RECORD_CONTEXT,
    body.subarray(1 + SALT_BYTES),
    versionedAad(version, aad),
  );
  return parsed.header.kind === EloRecordKind.DeltaSpan
    ? { kind: EloRecordKind.DeltaSpan, header: parsed.header, plaintext }
    : {
        kind: EloRecordKind.Snapshot,
        header: parsed.header as EloSnapshotHeader,
        plaintext,
      };
}
