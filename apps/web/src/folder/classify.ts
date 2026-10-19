import { mimeOf } from "@/assets/file-types";
import { MAX_TEXT_BYTES } from "@/assets/upload";
import { basename } from "@/doc/names";
import { contentHash } from "@/typst/asset-cache";

/**
 * The text of a file that can be a text node: valid UTF-8, no NUL bytes
 * (which no text format has, but many binaries that happen to decode do),
 * and at most MAX_TEXT_BYTES. Same as the CLI's `as_text`. Line endings and
 * a BOM are kept, so a file round-trips byte for byte and other tools see
 * no spurious changes.
 */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/** `sha256:<hex>` of the bytes, the same name the blob store uses. */
export const digest = contentHash;

/** Mime type by extension. A leading dot does not start one. */
export function mimeForPath(path: string): string {
  return mimeOf({ name: basename(path), type: "" });
}

export { mimeOf };
