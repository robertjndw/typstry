import { inflateSync } from "node:zlib";

/**
 * Just enough of a PDF reader to check what Typst exported: the page count,
 * the images and the text. Typst writes text as two-byte glyph ids in fonts
 * subset per document, so it only reads back through each font's ToUnicode
 * map. Not a general PDF parser: it assumes Typst's uncompressed object
 * layout (no object streams).
 */
export function readPdf(bytes: Buffer) {
  // latin1 maps every byte to one char and back, so binary stream data
  // survives the trip through a string.
  const source = bytes.toString("latin1");
  const objects = new Map<string, { dict: string; data?: string }>();
  const object =
    /(\d+) 0 obj\b([\s\S]*?)(?:stream\r?\n([\s\S]*?)\r?\nendstream\s*)?endobj/g;
  for (const [, id, dict, data] of source.matchAll(object)) {
    objects.set(id!, { dict: dict!, data });
  }

  // Decoded on demand: only content streams and ToUnicode maps are read, so
  // there is no point inflating font programs and image data.
  const stream = (dict: string, key: string) => {
    const { dict: own, data } = objects.get(
      new RegExp(`/${key}\\s*(\\d+) 0 R`).exec(dict)![1]!,
    )!;
    const raw = Buffer.from(data!, "latin1");
    return (own.includes("/FlateDecode") ? inflateSync(raw) : raw).toString(
      "latin1",
    );
  };
  const pages = [...objects.values()].filter((o) =>
    /\/Type\s*\/Page\b/.test(o.dict),
  );

  let text = "";
  for (const page of pages) {
    // Typst 0.15 points every page at one shared dictionary instead.
    const shared = /\/Resources\s*(\d+) 0 R/.exec(page.dict)?.[1];
    const resources = shared ? objects.get(shared)!.dict : page.dict;
    const fonts = new Map(
      [
        ...(/\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "").matchAll(
          /\/(\w+)\s*(\d+) 0 R/g,
        ),
      ].map(([, name, id]) => [
        name!,
        parseCMap(stream(objects.get(id!)!.dict, "ToUnicode")),
      ]),
    );
    let font: Map<number, string> | undefined;
    const show = (glyphs: Buffer) => {
      for (let i = 0; i + 1 < glyphs.length; i += 2) {
        text += font?.get(glyphs.readUInt16BE(i)) ?? "\uFFFD";
      }
    };
    const content = stream(page.dict, "Contents");
    // pdf-writer doesn't escape balanced parentheses, and glyph ids 40 and
    // 41 are exactly those, so literal strings can't be matched by a regex.
    // Past 127 glyphs it writes hex strings instead.
    const tokens = /\/(\w+) [\d.]+ Tf|(\()|<([\da-fA-F\s]*)>|\bET\b/g;
    for (let match; (match = tokens.exec(content));) {
      const [, fontName, open, hex] = match;
      if (fontName) font = fonts.get(fontName);
      else if (open) {
        const literal = readLiteral(content, tokens.lastIndex);
        tokens.lastIndex = literal.end;
        show(literal.bytes);
      } else if (hex !== undefined) {
        show(Buffer.from(hex.replace(/\s/g, ""), "hex"));
      } else text += " ";
    }
  }

  return {
    pages: pages.length,
    images: [...objects.values()].filter((o) =>
      /\/Subtype\s*\/Image\b/.test(o.dict),
    ).length,
    // Lines and blocks are drawn separately, so the spacing between them is
    // normalized away.
    text: text.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Reads a literal string whose opening parenthesis ends right before
 * `start`, returning its bytes and the index just past its closing one.
 */
function readLiteral(content: string, start: number) {
  const escapes: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
  };
  let out = "";
  let depth = 1;
  let i = start;
  while (i < content.length) {
    const char = content[i++]!;
    if (char === "\\") {
      const octal = /^[0-7]{1,3}/.exec(content.slice(i, i + 3))?.[0];
      if (octal) {
        out += String.fromCharCode(parseInt(octal, 8));
        i += octal.length;
      } else {
        const escaped = content[i++]!;
        out += escapes[escaped] ?? escaped;
      }
    } else if (char === ")" && --depth === 0) break;
    else {
      if (char === "(") depth++;
      out += char;
    }
  }
  return { bytes: Buffer.from(out, "latin1"), end: i };
}

function parseCMap(cmap: string) {
  const map = new Map<number, string>();
  const utf16 = new TextDecoder("utf-16be");
  // pdf-writer only ever writes bfchar entries, never bfrange.
  for (const [, block] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, from, to] of block!.matchAll(/<(\w+)>\s*<(\w+)>/g)) {
      map.set(parseInt(from!, 16), utf16.decode(Buffer.from(to!, "hex")));
    }
  }
  return map;
}
