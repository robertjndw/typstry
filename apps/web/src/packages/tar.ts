import { concatBytes } from "@/crypto/bytes";

import { PackageError } from "./errors";

const BLOCK = 512;
// Long names and PAX records are tiny; a header claiming more is corrupt.
const MAX_META_BYTES = 64 * 1024;

export interface TarLimits {
  /** Most file entries, checked as they are read. */
  maxEntries: number;
  /** Most bytes of file content, checked before a file is copied. */
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: TarLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 512 * 1024 * 1024,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A path as it may be stored: no leading "./", no empty or "." segments.
 * Null if it could escape the package or confuse another tool, which is
 * the only thing a hostile archive can do with a name. Empty for the
 * archive root itself.
 */
export function normalizeArchivePath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    return null;
  }
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  return segments.join("/");
}

function isZero(block: Uint8Array): boolean {
  return block.every((b) => b === 0);
}

function readString(block: Uint8Array, start: number, length: number) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end);
}

function readOctal(block: Uint8Array, start: number, length: number): number {
  const text = decoder
    .decode(readString(block, start, length))
    .replace(/ +$/, "")
    .trim();
  if (!/^[0-7]*$/.test(text))
    throw new PackageError("The tar file is corrupt.");
  return text === "" ? 0 : parseInt(text, 8);
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // The checksum field counts as spaces while it is being computed.
    sum += i >= 148 && i < 156 ? 32 : block[i]!;
  }
  return sum;
}

function decodePath(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new PackageError("The tar file has a file name that is not UTF-8.");
  }
}

/** The `path` of a PAX extended header; other keys do not matter here. */
function parsePaxPath(data: Uint8Array): string | undefined {
  let path: string | undefined;
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const length = Number(decoder.decode(data.subarray(pos, space)));
    if (!Number.isInteger(length) || length <= space - pos + 1) {
      throw new PackageError("The tar file is corrupt.");
    }
    const record = decodePath(data.subarray(space + 1, pos + length - 1));
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    pos += length;
  }
  return path;
}

/**
 * Reads the files of a ustar archive, with PAX and GNU long names. Anything
 * that is not a plain file or folder is refused instead of skipped: links
 * and devices have no business in a package, and ignoring them would hide
 * that the archive is not what the author packed.
 */
export function readTar(
  tar: Uint8Array,
  limits: Partial<TarLimits> = {},
): Map<string, Uint8Array> {
  const { maxEntries, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const files = new Map<string, Uint8Array>();
  let entries = 0;
  let total = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;

  const take = (offset: number, size: number): Uint8Array => {
    if (offset + size > tar.length) {
      throw new PackageError("The tar file is cut off.");
    }
    return tar.subarray(offset, offset + size);
  };

  let offset = 0;
  while (offset < tar.length) {
    const header = take(offset, BLOCK);
    if (isZero(header)) break;
    if (readOctal(header, 148, 8) !== checksum(header)) {
      throw new PackageError("The tar file is corrupt (bad header checksum).");
    }
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const dataStart = offset + BLOCK;
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "L" || type === "g" || type === "K") {
      if (size > MAX_META_BYTES) {
        throw new PackageError("The tar file is corrupt.");
      }
      const data = take(dataStart, size);
      if (type === "x") paxPath = parsePaxPath(data);
      else if (type === "L") longName = decodePath(readString(data, 0, size));
      continue;
    }

    let name = decodePath(readString(header, 0, 100));
    const isUstar = decoder.decode(header.subarray(257, 262)) === "ustar";
    const prefix = isUstar ? decodePath(readString(header, 345, 155)) : "";
    if (prefix) name = `${prefix}/${name}`;
    const raw = paxPath ?? longName ?? name;
    paxPath = longName = undefined;

    const path = normalizeArchivePath(raw);
    if (path === null) {
      throw new PackageError(`The tar file has an unsafe path: ${raw}`);
    }

    if (type === "5") continue;
    if (type === "1" || type === "2") {
      throw new PackageError(
        `${raw} is a link, which packages cannot contain.`,
      );
    }
    if (type !== "0" && type !== "\0") {
      throw new PackageError(`${raw} is not a regular file.`);
    }
    if (path === "")
      throw new PackageError("The tar file has an unnamed file.");

    if (++entries > maxEntries) {
      throw new PackageError(`The package has more than ${maxEntries} files.`);
    }
    total += size;
    if (total > maxTotalBytes) {
      throw new PackageError(
        "The package unpacks to more than the size limit.",
      );
    }
    // Copied, so the entry does not keep the whole archive alive.
    files.set(path, take(dataStart, size).slice());
  }
  return files;
}

function putString(block: Uint8Array, start: number, bytes: Uint8Array) {
  block.set(bytes, start);
}

function putOctal(block: Uint8Array, start: number, length: number, n: number) {
  const text = n.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) {
    throw new PackageError("A file is too large for the tar format.");
  }
  putString(block, start, encoder.encode(text));
}

function header(
  name: Uint8Array,
  prefix: Uint8Array,
  size: number,
  type: string,
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  putString(block, 0, name);
  putOctal(block, 100, 8, 0o644);
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  putOctal(block, 124, 12, size);
  putOctal(block, 136, 12, 0);
  block[156] = type.charCodeAt(0);
  putString(block, 257, encoder.encode("ustar\0" + "00"));
  putString(block, 345, prefix);
  // Six digits, NUL, space: the layout every tar implementation writes.
  putString(
    block,
    148,
    encoder.encode(checksum(block).toString(8).padStart(6, "0") + "\0 "),
  );
  return block;
}

function paxRecord(key: string, value: string): Uint8Array {
  const rest = ` ${key}=${value}\n`;
  const restBytes = encoder.encode(rest).length;
  // The length counts its own digits, so settle on a fixed point.
  let length = restBytes + 1;
  while (String(length).length + restBytes !== length) length++;
  return encoder.encode(`${length}${rest}`);
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
}

// eslint-disable-next-line no-control-regex
const ASCII = /^[\x01-\x7f]*$/;

/** Splits a long path at a "/" into ustar's prefix and name fields. */
function splitPath(path: string): { prefix: string; name: string } | null {
  if (!ASCII.test(path)) return null;
  if (path.length <= 100) return { prefix: "", name: path };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    if (i <= 155 && path.length - i - 1 <= 100) {
      return { prefix: path.slice(0, i), name: path.slice(i + 1) };
    }
  }
  return null;
}

/**
 * Writes `files` as a ustar archive. The output depends only on the
 * contents: entries sorted, and mode, owner and mtime fixed, so the same
 * package always gets the same bytes (and the same blob hash).
 */
export function writeTar(files: Map<string, Uint8Array>): Uint8Array {
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks: Uint8Array[] = [];
  for (const [raw, data] of sorted) {
    const path = normalizeArchivePath(raw);
    if (!path) throw new PackageError(`Cannot pack the path ${raw}`);
    const split = splitPath(path);
    if (split) {
      chunks.push(
        header(
          encoder.encode(split.name),
          encoder.encode(split.prefix),
          data.length,
          "0",
        ),
      );
    } else {
      // Readers that predate PAX see this ASCII stand-in instead of the path.
      const stand = path
        .split("/")
        .at(-1)!
        .replace(/[^\x20-\x7e]/g, "_")
        .slice(0, 80);
      const pax = paxRecord("path", path);
      chunks.push(
        header(
          encoder.encode(`PaxHeaders/${stand}`),
          new Uint8Array(),
          pax.length,
          "x",
        ),
        padded(pax),
        header(encoder.encode(stand), new Uint8Array(), data.length, "0"),
      );
    }
    chunks.push(padded(data));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  return concatBytes(chunks);
}
