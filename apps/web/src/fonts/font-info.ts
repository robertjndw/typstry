import { extensionOf } from "@/doc/names";

import { typographicFamily } from "./typst-family";

export interface FontFaceInfo {
  /** Position inside a collection; 0 for a single font. */
  index: number;
  /** Name to show: the typographic family (ID 16), else the family (ID 1). */
  family: string;
  /** The family name Typst files this face under, for `#set text(font: ...)`. */
  typstFamily: string;
  style: string;
  fullName: string;
  postscriptName: string;
  /** 1 to 1000, 400 is regular. */
  weight: number;
  /** Italic or oblique. */
  italic: boolean;
  /** Width as a ratio of normal, from 0.5 (ultra condensed) to 2. */
  stretch: number;
}

export class FontParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontParseError";
  }
}

export class WoffError extends FontParseError {
  constructor() {
    super(
      "Typst can't read WOFF or WOFF2 fonts; convert to TTF or OTF first, e.g. `fonttools ttLib.woff2 decompress font.woff2`",
    );
    this.name = "WoffError";
  }
}

const TAG_TTC = 0x74746366; // "ttcf"
const TAG_OTTO = 0x4f54544f;
const TAG_TRUE = 0x74727565;
const TAG_TRUETYPE = 0x00010000;
const TAG_WOFF = 0x774f4646; // "wOFF"
const TAG_WOFF2 = 0x774f4632; // "wOF2"

// A real collection has a handful of faces; the cap keeps a corrupt count
// from looping for billions of iterations.
const MAX_COLLECTION_FACES = 1024;

const FAMILY = 1;
const SUBFAMILY = 2;
const FULL_NAME = 4;
const POSTSCRIPT_NAME = 6;
const TYPOGRAPHIC_FAMILY = 16;
const TYPOGRAPHIC_SUBFAMILY = 17;

// The 128 characters above ASCII in Mac OS Roman, as Typst decodes them.
// Code points, because some of them are easy to mangle as literals.
const MAC_ROMAN_HIGH = String.fromCodePoint(
  0x00c4,
  0x00c5,
  0x00c7,
  0x00c9,
  0x00d1,
  0x00d6,
  0x00dc,
  0x00e1,
  0x00e0,
  0x00e2,
  0x00e4,
  0x00e3,
  0x00e5,
  0x00e7,
  0x00e9,
  0x00e8,
  0x00ea,
  0x00eb,
  0x00ed,
  0x00ec,
  0x00ee,
  0x00ef,
  0x00f1,
  0x00f3,
  0x00f2,
  0x00f4,
  0x00f6,
  0x00f5,
  0x00fa,
  0x00f9,
  0x00fb,
  0x00fc,
  0x2020,
  0x00b0,
  0x00a2,
  0x00a3,
  0x00a7,
  0x2022,
  0x00b6,
  0x00df,
  0x00ae,
  0x00a9,
  0x2122,
  0x00b4,
  0x00a8,
  0x2260,
  0x00c6,
  0x00d8,
  0x221e,
  0x00b1,
  0x2264,
  0x2265,
  0x00a5,
  0x00b5,
  0x2202,
  0x2211,
  0x220f,
  0x03c0,
  0x222b,
  0x00aa,
  0x00ba,
  0x03a9,
  0x00e6,
  0x00f8,
  0x00bf,
  0x00a1,
  0x00ac,
  0x221a,
  0x0192,
  0x2248,
  0x2206,
  0x00ab,
  0x00bb,
  0x2026,
  0x00a0,
  0x00c0,
  0x00c3,
  0x00d5,
  0x0152,
  0x0153,
  0x2013,
  0x2014,
  0x201c,
  0x201d,
  0x2018,
  0x2019,
  0x00f7,
  0x25ca,
  0x00ff,
  0x0178,
  0x2044,
  0x20ac,
  0x2039,
  0x203a,
  0xfb01,
  0xfb02,
  0x2021,
  0x00b7,
  0x201a,
  0x201e,
  0x2030,
  0x00c2,
  0x00ca,
  0x00c1,
  0x00cb,
  0x00c8,
  0x00cd,
  0x00ce,
  0x00cf,
  0x00cc,
  0x00d3,
  0x00d4,
  0xf8ff,
  0x00d2,
  0x00da,
  0x00db,
  0x00d9,
  0x0131,
  0x02c6,
  0x02dc,
  0x00af,
  0x02d8,
  0x02d9,
  0x02da,
  0x00b8,
  0x02dd,
  0x02db,
  0x02c7,
);

// usWidthClass 1..9 as the ratios Typst uses.
const STRETCH_BY_WIDTH_CLASS = [
  0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 2,
];

export function isWoff(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const tag = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return tag === TAG_WOFF || tag === TAG_WOFF2;
}

export function isWoffPath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "woff" || ext === "woff2";
}

/** Reads with explicit bounds so a truncated file throws our error. */
class Reader {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private check(offset: number, size: number): void {
    if (!(offset >= 0 && size >= 0 && offset + size <= this.bytes.length)) {
      throw new FontParseError("The font file is truncated or corrupt");
    }
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset);
  }

  slice(offset: number, length: number): Uint8Array {
    this.check(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }
}

interface Table {
  offset: number;
  length: number;
}

function readTables(r: Reader, faceOffset: number): Map<string, Table> {
  const magic = r.u32(faceOffset);
  if (magic === TAG_WOFF || magic === TAG_WOFF2) throw new WoffError();
  if (magic !== TAG_TRUETYPE && magic !== TAG_OTTO && magic !== TAG_TRUE) {
    throw new FontParseError("Not a TrueType or OpenType font");
  }
  const count = r.u16(faceOffset + 4);
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const record = faceOffset + 12 + i * 16;
    const tag = String.fromCharCode(...r.slice(record, 4));
    const offset = r.u32(record + 8);
    const length = r.u32(record + 12);
    // Only the tables we read get validated; other tables may be damaged
    // without affecting names.
    if (tag === "name" || tag === "OS/2" || tag === "head") {
      r.slice(offset, length);
      tables.set(tag, { offset, length });
    }
  }
  return tables;
}

function decodeUtf16be(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return out;
}

function decodeMacRoman(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes)
    out += b < 128 ? String.fromCharCode(b) : MAC_ROMAN_HIGH[b - 128];
  return out;
}

/** Lower is better; null for encodings we cannot decode. */
function nameRank(platform: number, encoding: number, language: number) {
  if (platform === 3) {
    if (encoding === 1 || encoding === 10) return language === 0x409 ? 0 : 1;
    return encoding === 0 ? 1 : null;
  }
  if (platform === 0) return 2;
  if (platform === 1 && encoding === 0) return 3;
  return null;
}

function readNames(r: Reader, table: Table): Map<number, string> {
  const base = table.offset;
  const count = r.u16(base + 2);
  const stringsAt = base + r.u16(base + 4);
  const best = new Map<number, { rank: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const record = base + 6 + i * 12;
    if (record + 12 > base + table.length) break;
    const platform = r.u16(record);
    const rank = nameRank(platform, r.u16(record + 2), r.u16(record + 4));
    const id = r.u16(record + 6);
    if (rank === null || (best.get(id)?.rank ?? Infinity) <= rank) continue;
    const length = r.u16(record + 8);
    const start = stringsAt + r.u16(record + 10);
    // A bad string offset costs us that one name, not the whole font.
    if (start + length > base + table.length) continue;
    const raw = r.slice(start, length);
    const text = platform === 1 ? decodeMacRoman(raw) : decodeUtf16be(raw);
    best.set(id, { rank, text });
  }
  return new Map([...best].map(([id, { text }]) => [id, text]));
}

function parseFace(r: Reader, faceOffset: number, index: number): FontFaceInfo {
  const tables = readTables(r, faceOffset);
  const nameTable = tables.get("name");
  if (!nameTable) throw new FontParseError("The font has no name table");
  const names = readNames(r, nameTable);

  // Typst files fonts by ID 1, not 16: ID 16 can lump together families
  // that Typst needs to address separately (e.g. Noto Sans Display).
  const legacyFamily = names.get(FAMILY) ?? names.get(TYPOGRAPHIC_FAMILY);
  if (!legacyFamily) throw new FontParseError("The font has no family name");
  const family = names.get(TYPOGRAPHIC_FAMILY) ?? legacyFamily;
  const style = names.get(TYPOGRAPHIC_SUBFAMILY) ?? names.get(SUBFAMILY) ?? "";
  const fullName =
    names.get(FULL_NAME) ?? (style ? `${family} ${style}` : family);

  let weight = 400;
  let stretch = 1;
  let italic = false;
  let oblique = false;
  let hasStyleBits = false;

  const os2 = tables.get("OS/2");
  // fsSelection sits at byte 62, so shorter (damaged) tables are skipped.
  if (os2 && os2.length >= 64) {
    weight = r.u16(os2.offset + 4) || 400;
    stretch = STRETCH_BY_WIDTH_CLASS[r.u16(os2.offset + 6) - 1] ?? 1;
    const selection = r.u16(os2.offset + 62);
    italic = (selection & 1) !== 0;
    oblique = (selection & (1 << 9)) !== 0;
    hasStyleBits = true;
  }

  const head = tables.get("head");
  if (head && head.length >= 46) {
    const mac = r.u16(head.offset + 44);
    if (!hasStyleBits) {
      italic = (mac & 2) !== 0;
      if ((mac & 1) !== 0) weight = 700;
    }
  }

  // Some fonts leave the bits unset, so Typst also trusts the full name.
  const lowerName = fullName.toLowerCase();
  italic ||= lowerName.includes("italic");
  oblique ||= lowerName.includes("oblique") || lowerName.includes("slanted");

  return {
    index,
    family,
    typstFamily: typographicFamily(legacyFamily),
    style,
    fullName,
    postscriptName: names.get(POSTSCRIPT_NAME) ?? "",
    weight: Math.min(Math.max(weight, 1), 1000),
    italic: italic || oblique,
    stretch,
  };
}

/**
 * The faces in a TTF, OTF or TTC/OTC file. Throws WoffError for web fonts,
 * which Typst cannot load, and FontParseError for anything damaged.
 */
export function parseFontFaces(bytes: Uint8Array): FontFaceInfo[] {
  const r = new Reader(bytes);
  const magic = r.u32(0);
  if (magic === TAG_WOFF || magic === TAG_WOFF2) throw new WoffError();
  if (magic !== TAG_TTC) return [parseFace(r, 0, 0)];

  const count = r.u32(8);
  if (count === 0 || count > MAX_COLLECTION_FACES) {
    throw new FontParseError("The font collection is corrupt");
  }
  const faces: FontFaceInfo[] = [];
  for (let i = 0; i < count; i++) {
    faces.push(parseFace(r, r.u32(12 + i * 4), i));
  }
  return faces;
}
