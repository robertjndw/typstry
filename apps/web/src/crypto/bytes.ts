/**
 * WebCrypto, fetch and Blob only take views backed by a plain ArrayBuffer,
 * while Loro and friends are typed as handing out any ArrayBufferLike.
 */
export function ownBuffer(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return view.buffer instanceof ArrayBuffer
    ? (view as Uint8Array<ArrayBuffer>)
    : new Uint8Array(view);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** `chunks` joined into one array; `total` is their summed length. */
export function concatBytes(
  chunks: readonly Uint8Array[],
  total = chunks.reduce((n, c) => n + c.length, 0),
): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
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

/** Standard base64 with padding, as the server's JSON carries bytes. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode with a large view overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
