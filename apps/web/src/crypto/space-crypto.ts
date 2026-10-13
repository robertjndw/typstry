// A project's end-to-end encryption, as far as the web app is concerned: a
// thin typed wrapper around the wasm build of crates/typstry-wire/src/crypto
// (see wasm.ts). The format, the keys and the rules live in Rust and are the
// same ones the CLI runs; nothing is reimplemented here.
//
// The secrets travel only in the URL fragment of share links (browsers never
// send fragments to the server) and in this browser's storage, so the server
// only ever sees ciphertext. Doc content is sealed under per-generation doc
// keys from the keyring the server stores (sealed under the link, signed by
// the link's attestation key). Every record is signed by the author's device
// key and carries an editor's attestation of that key, which is why a viewer
// stays read-only even if the server lets their writes through.
import { PeerSigners } from "@/mls/peer-signers";

import {
  DocKeys,
  Keyring,
  LinkSecret,
  Signer,
  type DecryptedRecord,
  type PresenceKey,
} from "./wasm";

export type { DecryptedRecord } from "./wasm";

/** Bytes a sealed blob adds to its plaintext. */
export const BLOB_OVERHEAD = 1 + 4 + 16 + 12 + 16;

/** Anything the wasm threw, with the `kind` it was thrown under. */
export class CryptoError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CryptoError";
    this.kind = kind;
  }
}

/** The data is sealed under a key this link does not carry. */
export class KeyMismatchError extends CryptoError {
  constructor(
    message = "data is encrypted with a key this link does not carry",
  ) {
    super("KeyMismatch", message);
    this.name = "KeyMismatchError";
  }
}

/** The version or kind byte is one this build does not know. */
export class NewerVersionError extends CryptoError {
  readonly version: number;

  constructor(version: number, message?: string) {
    super(
      "NewerVersion",
      message ??
        `made by a newer version of typstry (format ${version}); reload to update`,
    );
    this.name = "NewerVersionError";
    this.version = version;
  }
}

/** A signature does not match its author's key. */
export class BadSignatureError extends CryptoError {
  constructor(message = "signature does not verify") {
    super("BadSignature", message);
    this.name = "BadSignatureError";
  }
}

/**
 * Sealed under a key generation the keyring does not reach: the group
 * rotated, so fetch the keyring again.
 */
export class UnknownGenerationError extends CryptoError {
  readonly generation: number;

  constructor(generation: number, message?: string) {
    super(
      "UnknownGeneration",
      message ??
        `data is from key generation ${generation}, which this keyring does not have`,
    );
    this.name = "UnknownGenerationError";
    this.generation = generation;
  }
}

/** Written by someone who can read the project but is not an editor. */
export class NotEditorError extends CryptoError {
  constructor(message = "record author is not an editor of this project") {
    super("NotEditor", message);
    this.name = "NotEditorError";
  }
}

/** Turns what the wasm threw into one of the classes above. */
function toCryptoError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { kind, version, generation } = error as Error & {
    kind?: unknown;
    version?: unknown;
    generation?: unknown;
  };
  if (typeof kind !== "string") return error;
  switch (kind) {
    case "KeyMismatch":
      return new KeyMismatchError(error.message);
    case "NewerVersion":
      return new NewerVersionError(Number(version), error.message);
    case "BadSignature":
      return new BadSignatureError(error.message);
    case "UnknownGeneration":
      return new UnknownGenerationError(Number(generation), error.message);
    case "NotEditor":
      return new NotEditorError(error.message);
    default:
      return new CryptoError(kind, error.message);
  }
}

/** Runs `fn`, throwing the typed form of whatever the wasm throws. */
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toCryptoError(error);
  }
}

/** The view secret of `secret`, which may be either kind of link. */
export function viewSecretOf(secret: string): string {
  return guard(() => {
    const link = LinkSecret.parse(secret);
    try {
      return link.viewSecret();
    } finally {
      link.free();
    }
  });
}

/** Presence errors that mean "stale, drop it", by whether a group key opened it. */
const STALE_GROUP_PRESENCE = new Set<unknown>([
  "WrongEpoch",
  "BadSignature",
  "Decrypt",
]);
const STALE_EARLY_PRESENCE = new Set<unknown>([
  "WrongEpoch",
  "UnknownGeneration",
]);

export interface Span {
  peer: string;
  start: number;
  end: number;
}

export type VersionEntries = { peer: string; counter: number }[];

/**
 * The keys, link and signer of one open project. Holds wasm objects, so it
 * exists only after `loadWasm()`.
 *
 * Keys change underneath a session: the group's keys replace the starting
 * ones once it is joined, and the presence key follows the MLS epoch.
 * Readers that cached anything derived from them subscribe with `onChange`.
 * A rotation hands out a new link, so it is a new `SpaceCrypto`, never new
 * keys under this one.
 */
export class SpaceCrypto {
  readonly link: LinkSecret;
  private keys: DocKeys;
  private signer: Signer | null;
  private presence: PresenceKey | null = null;
  private readonly listeners = new Set<() => void>();
  /**
   * Which device key signed what each Loro peer wrote, learned from the
   * records that decrypted.
   */
  readonly signers = new PeerSigners();

  /**
   * `signer` is whatever signs records: a group member's leaf key once the
   * MLS session exists. Without one, an edit link gets a fresh device key
   * that it attests itself.
   */
  constructor(link: LinkSecret, keys: DocKeys, signer?: Signer | null) {
    this.link = link;
    this.keys = keys;
    this.signer = signer ?? this.throwawaySigner();
  }

  /**
   * Opens a project from the secret in a link and the sealed keyring the
   * server stores. Throws a `KeyMismatchError`, `BadSignatureError` or
   * `NewerVersionError` when the link does not belong to the keyring.
   */
  static open(secret: string, signedKeyring: Uint8Array): SpaceCrypto {
    return guard(() => {
      const link = LinkSecret.parse(secret);
      let keyring: Keyring | null = null;
      try {
        keyring = Keyring.openVerified(link, signedKeyring);
        // DocKeys copies what it needs out of the keyring.
        return new SpaceCrypto(link, new DocKeys(keyring));
      } catch (error) {
        link.free();
        throw error;
      } finally {
        keyring?.free();
      }
    });
  }

  private throwawaySigner(): Signer | null {
    return this.link.canAttest()
      ? Signer.attested(this.link, this.keys.generation)
      : null;
  }

  /** The shareable edit secret, when this came from an edit link. */
  get editSecret(): string | null {
    return this.link.canAttest() ? this.link.toBase64url() : null;
  }

  /**
   * Whether `secret` is a link to the same keys as this one. False once the
   * project rotated away from the link this was opened with.
   */
  matches(secret: string): boolean {
    try {
      return viewSecretOf(secret) === this.viewSecret;
    } catch {
      return false;
    }
  }

  /** The shareable view secret, which every link can produce. */
  get viewSecret(): string {
    return this.link.viewSecret();
  }

  get generation(): number {
    return this.keys.generation;
  }

  /** Whether this device can write records of the current generation. */
  get canWrite(): boolean {
    return this.signer?.canWrite(this.keys.generation) ?? false;
  }

  /** Records are signed with this device's leaf key, not a stand-in. */
  get grouped(): boolean {
    return this.presence !== null;
  }

  /**
   * Switches to the keys of the member group as of one epoch, in one step:
   * what listeners react to (a new generation, presence sealed under a new
   * epoch) then sees all of it at once.
   */
  setGroupKeys(keys: DocKeys, signer: Signer, presence: PresenceKey): void {
    // Only this object holds the ones replaced: the group hands out fresh
    // copies on every call.
    const old = [this.keys, this.signer, this.presence];
    this.keys = keys;
    this.signer = signer;
    this.presence = presence;
    for (const item of old) {
      if (item && item !== keys && item !== signer && item !== presence)
        item.free();
    }
    this.emit();
  }

  /** Frees the wasm objects, the link included. Unusable afterwards. */
  free(): void {
    this.keys.free();
    this.signer?.free();
    this.presence?.free();
    this.link.free();
    this.signer = null;
    this.presence = null;
  }

  /** Calls `listener` whenever keys, signer or presence key change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Encrypts and signs the Loro updates for ops `[start, end)` of `peer`. */
  encryptDelta(span: Span, plaintext: Uint8Array): Uint8Array {
    return guard(() =>
      this.keys.encryptDelta(
        this.requireSigner(),
        span.peer,
        span.start,
        span.end,
        plaintext,
      ),
    );
  }

  /** Encrypts and signs a Loro snapshot covering `vv`. */
  encryptSnapshot(vv: VersionEntries, plaintext: Uint8Array): Uint8Array {
    return guard(() =>
      this.keys.encryptSnapshot(this.requireSigner(), vv, plaintext),
    );
  }

  /**
   * Parses, verifies and decrypts one record. The attestation and signature
   * are checked first, so a record by a viewer is refused whatever it
   * decrypts to.
   */
  decryptRecord(record: Uint8Array): DecryptedRecord {
    const out = guard(() => this.keys.decryptRecord(record));
    if (out.kind === "delta") this.signers.record(out.peer, out.signer);
    return out;
  }

  sealBlob(plaintext: Uint8Array): Uint8Array {
    return guard(() => this.keys.sealBlob(plaintext));
  }

  openBlob(sealed: Uint8Array): Uint8Array {
    return guard(() => this.keys.openBlob(sealed));
  }

  /** Seals one presence update. */
  sealPresence(plaintext: Uint8Array): Uint8Array {
    return guard(() =>
      this.presence
        ? this.presence.seal(plaintext)
        : this.keys.sealPresence(plaintext),
    );
  }

  /**
   * Opens a presence update. `null` for one from another epoch, which is
   * stale (or from a member that is gone) and to be dropped. `onSigner`
   * gets the device key that signed it, when the update came from a group
   * member (the group-less fallback has no such key).
   */
  openPresence(
    sealed: Uint8Array,
    onSigner?: (signer: Uint8Array) => void,
  ): Uint8Array | null {
    try {
      if (!this.presence) return this.keys.openPresence(sealed);
      const opened = this.presence.open(sealed);
      onSigner?.(opened.signer);
      return opened.plaintext;
    } catch (error) {
      const kind = (error as { kind?: unknown } | null)?.kind;
      // From another epoch, or from a device the roster does not have (yet):
      // either side may be ahead of the other for a moment around a join,
      // and both resend once their keys change. Before this device has
      // joined the group, what members send reads as a blob of an unknown
      // generation. Nothing to open for now.
      const dropped = this.presence
        ? STALE_GROUP_PRESENCE
        : STALE_EARLY_PRESENCE;
      if (dropped.has(kind)) return null;
      throw toCryptoError(error);
    }
  }

  private requireSigner(): Signer {
    if (!this.signer)
      throw new CryptoError("ReadOnly", "this link is read-only");
    return this.signer;
  }
}
