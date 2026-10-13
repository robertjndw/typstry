// The directory has to accept exactly the links the CLI accepts, or the two
// pick different best links from the same doc. The CLI parses secrets with
// LinkSecret::from_base64url, which on top of the shape that `secretKind`
// checks also decompresses a view secret's attestation key. The wasm does
// that too, but the home screen lists projects without loading it, so the
// one extra check is done here.
import { fromBase64Url } from "@/crypto/bytes";
import { secretKind, type SecretKind } from "@/crypto/secret";

const P = 2n ** 255n - 19n;
// -121665 / 121666 mod p, the Edwards curve constant of Ed25519.
const D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = base % P;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

/**
 * Whether curve25519-dalek decompresses these 32 bytes to a point. It masks
 * the sign bit, reduces y mod p without insisting on a canonical encoding,
 * and accepts any sign for x = 0, so the only way to fail is x² = (y² - 1) /
 * (d y² + 1) having no root. The denominator is never 0 (d is not a square),
 * and u / v is a square exactly when u v is, which Euler's criterion
 * answers.
 */
export function isEdwardsPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y = (y & ((1n << 255n) - 1n)) % P;
  const yy = (y * y) % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy + 1n) % P;
  return modPow(u * v, (P - 1n) / 2n) !== P - 1n;
}

// Directory reads re-check every link on each change, and the point check
// is a 255-bit modPow. Secrets never change, so each is checked once.
const viewSecretOk = new Map<string, boolean>();

/** `secretKind`, except that a view secret must also parse in Rust. */
export function linkSecretKind(raw: string): SecretKind | null {
  const kind = secretKind(raw);
  if (kind !== "view") return kind;
  let ok = viewSecretOk.get(raw);
  if (ok === undefined) {
    // A view secret is the kind byte, the 32 byte view key and the key.
    ok = isEdwardsPoint(fromBase64Url(raw)!.subarray(33));
    viewSecretOk.set(raw, ok);
  }
  return ok ? kind : null;
}
