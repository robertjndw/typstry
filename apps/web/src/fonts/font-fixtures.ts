// Builds tiny sfnt binaries (name, OS/2 and head only) so tests can cover
// font parsing without checking in font files.

export interface NameSpec {
  id: number;
  text: string;
  platform?: number;
  encoding?: number;
  language?: number;
}

export interface FontSpec {
  magic?: number;
  names: NameSpec[];
  /** Omit for a font without an OS/2 table. */
  os2?: { weight: number; width: number; selection: number };
  macStyle?: number;
}

function utf16be(text: string): number[] {
  return [...text].flatMap((c) => {
    const code = c.charCodeAt(0);
    return [code >> 8, code & 255];
  });
}

function nameTable(names: NameSpec[]): number[] {
  const strings: number[] = [];
  const records: number[] = [];
  const u16 = (out: number[], n: number) => out.push(n >> 8, n & 255);
  for (const n of names) {
    const platform = n.platform ?? 3;
    const bytes =
      platform === 1
        ? [...n.text].map((c) => c.charCodeAt(0))
        : utf16be(n.text);
    u16(records, platform);
    u16(records, n.encoding ?? (platform === 3 ? 1 : 0));
    u16(records, n.language ?? (platform === 3 ? 0x409 : 0));
    u16(records, n.id);
    u16(records, bytes.length);
    u16(records, strings.length);
    strings.push(...bytes);
  }
  const header: number[] = [];
  u16(header, 0);
  u16(header, names.length);
  u16(header, 6 + records.length);
  return [...header, ...records, ...strings];
}

function os2Table(os2: NonNullable<FontSpec["os2"]>): number[] {
  const out = new Array<number>(78).fill(0);
  const put = (at: number, n: number) => {
    out[at] = n >> 8;
    out[at + 1] = n & 255;
  };
  put(4, os2.weight);
  put(6, os2.width);
  put(62, os2.selection);
  return out;
}

function headTable(macStyle: number): number[] {
  const out = new Array<number>(54).fill(0);
  out[44] = macStyle >> 8;
  out[45] = macStyle & 255;
  return out;
}

/** An sfnt that expects to live `base` bytes into its file (for TTC members). */
export function buildSfnt(spec: FontSpec, base = 0): Uint8Array {
  const tables: [string, number[]][] = [["name", nameTable(spec.names)]];
  if (spec.os2) tables.push(["OS/2", os2Table(spec.os2)]);
  tables.push(["head", headTable(spec.macStyle ?? 0)]);

  const out: number[] = [];
  const u16 = (n: number) => out.push(n >> 8, n & 255);
  const u32 = (n: number) =>
    out.push(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  u32(spec.magic ?? 0x00010000);
  u16(tables.length);
  u16(0);
  u16(0);
  u16(0);
  let offset = base + 12 + tables.length * 16;
  for (const [tag, data] of tables) {
    out.push(...[...tag].map((c) => c.charCodeAt(0)));
    u32(0);
    u32(offset);
    u32(data.length);
    offset += data.length;
  }
  for (const [, data] of tables) out.push(...data);
  return Uint8Array.from(out);
}

export function buildTtc(specs: FontSpec[]): Uint8Array {
  const headerSize = 12 + specs.length * 4;
  const members: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = headerSize;
  for (const spec of specs) {
    const member = buildSfnt(spec, at);
    offsets.push(at);
    members.push(member);
    at += member.length;
  }
  const out: number[] = [0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0];
  const u32 = (n: number) =>
    out.push(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  u32(specs.length);
  offsets.forEach(u32);
  for (const m of members) out.push(...m);
  return Uint8Array.from(out);
}
