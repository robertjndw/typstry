import {
  isWoff,
  isWoffPath,
  FontParseError,
  parseFontFaces,
  WoffError,
} from "./font-info";
import { buildSfnt, buildTtc, type FontSpec } from "./font-fixtures";

const REGULAR_OS2 = { weight: 400, width: 5, selection: 0 };

function spec(overrides: Partial<FontSpec> = {}): FontSpec {
  return {
    names: [
      { id: 1, text: "Test Sans" },
      { id: 2, text: "Regular" },
      { id: 4, text: "Test Sans Regular" },
      { id: 6, text: "TestSans-Regular" },
    ],
    os2: REGULAR_OS2,
    ...overrides,
  };
}

describe("parseFontFaces", () => {
  it("reads the names and metrics of a TrueType font", () => {
    const [face] = parseFontFaces(buildSfnt(spec()));
    expect(face).toEqual({
      index: 0,
      family: "Test Sans",
      typstFamily: "Test Sans",
      style: "Regular",
      fullName: "Test Sans Regular",
      postscriptName: "TestSans-Regular",
      weight: 400,
      italic: false,
      stretch: 1,
    });
  });

  it("accepts OpenType CFF and 'true' magic", () => {
    expect(parseFontFaces(buildSfnt(spec({ magic: 0x4f54544f })))).toHaveLength(
      1,
    );
    expect(parseFontFaces(buildSfnt(spec({ magic: 0x74727565 })))).toHaveLength(
      1,
    );
  });

  it("shows the typographic family but files it under ID 1 like Typst", () => {
    const [face] = parseFontFaces(
      buildSfnt(
        spec({
          names: [
            { id: 1, text: "Test Sans Light" },
            { id: 2, text: "Regular" },
            { id: 16, text: "Test Sans" },
            { id: 17, text: "Light" },
          ],
          os2: { weight: 300, width: 5, selection: 0 },
        }),
      ),
    );
    expect(face).toMatchObject({
      family: "Test Sans",
      style: "Light",
      typstFamily: "Test Sans",
      weight: 300,
    });
  });

  it("does not let ID 16 replace ID 1 in the Typst family", () => {
    const [face] = parseFontFaces(
      buildSfnt(
        spec({
          names: [
            { id: 1, text: "Test Display" },
            { id: 16, text: "Test" },
          ],
        }),
      ),
    );
    expect(face!.family).toBe("Test");
    expect(face!.typstFamily).toBe("Test Display");
  });

  it("prefers Windows English over other platforms", () => {
    const [face] = parseFontFaces(
      buildSfnt(
        spec({
          names: [
            { id: 1, text: "Mac Name", platform: 1 },
            { id: 1, text: "Unicode Name", platform: 0 },
            { id: 1, text: "Deutsch", platform: 3, language: 0x407 },
            { id: 1, text: "English", platform: 3, language: 0x409 },
          ],
        }),
      ),
    );
    expect(face!.family).toBe("English");
  });

  it("falls back from other Windows languages to Unicode to Mac Roman", () => {
    const names = (list: FontSpec["names"]) =>
      parseFontFaces(buildSfnt(spec({ names: list })))[0]!.family;
    expect(
      names([
        { id: 1, text: "Mac", platform: 1 },
        { id: 1, text: "Uni", platform: 0 },
        { id: 1, text: "Deutsch", platform: 3, language: 0x407 },
      ]),
    ).toBe("Deutsch");
    expect(
      names([
        { id: 1, text: "Mac", platform: 1 },
        { id: 1, text: "Uni", platform: 0 },
      ]),
    ).toBe("Uni");
    expect(names([{ id: 1, text: "Mac", platform: 1 }])).toBe("Mac");
  });

  it("decodes Mac Roman bytes above ASCII", () => {
    // 0x8A is a-umlaut and 0xA5 the bullet in Mac Roman.
    const font = buildSfnt(
      spec({ names: [{ id: 1, text: "Test", platform: 1 }] }),
    );
    const bytes = Uint8Array.from(font);
    // Patch the 4-byte string "Test" in place: "B" + 0x8A + 0xA5 + "x".
    const at = bytes.findIndex(
      (_, i) => String.fromCharCode(...bytes.slice(i, i + 4)) === "Test",
    );
    bytes.set([0x42, 0x8a, 0xa5, 0x78], at);
    expect(parseFontFaces(bytes)[0]!.family).toBe("Bä•x");
  });

  it("decodes UTF-16BE names", () => {
    const [face] = parseFontFaces(
      buildSfnt(spec({ names: [{ id: 1, text: "Français Sans" }] })),
    );
    expect(face!.family).toBe("Français Sans");
  });

  it("derives weight, stretch and italic from OS/2", () => {
    const [face] = parseFontFaces(
      buildSfnt(spec({ os2: { weight: 700, width: 3, selection: 1 } })),
    );
    expect(face).toMatchObject({ weight: 700, stretch: 0.75, italic: true });
  });

  it("treats the oblique bit as italic", () => {
    const [face] = parseFontFaces(
      buildSfnt(spec({ os2: { weight: 400, width: 5, selection: 1 << 9 } })),
    );
    expect(face!.italic).toBe(true);
  });

  it("falls back to head.macStyle without OS/2", () => {
    const [face] = parseFontFaces(
      buildSfnt(spec({ os2: undefined, macStyle: 0b11 })),
    );
    expect(face).toMatchObject({ weight: 700, italic: true, stretch: 1 });
  });

  it("infers italic from the full name when the bits are unset", () => {
    const [face] = parseFontFaces(
      buildSfnt(
        spec({
          names: [
            { id: 1, text: "Test Sans" },
            { id: 4, text: "Test Sans Italic" },
          ],
        }),
      ),
    );
    expect(face!.italic).toBe(true);
  });

  it("lists every face of a collection", () => {
    const faces = parseFontFaces(
      buildTtc([
        spec(),
        spec({
          names: [
            { id: 1, text: "Test Sans Bold" },
            { id: 2, text: "Bold" },
          ],
          os2: { weight: 700, width: 5, selection: 0 },
        }),
      ]),
    );
    expect(faces.map((f) => [f.index, f.typstFamily, f.weight])).toEqual([
      [0, "Test Sans", 400],
      [1, "Test Sans", 700],
    ]);
  });

  it.each([
    ["WOFF", [0x77, 0x4f, 0x46, 0x46]],
    ["WOFF2", [0x77, 0x4f, 0x46, 0x32]],
  ])("rejects %s with a conversion hint", (_name, magic) => {
    const bytes = new Uint8Array(64);
    bytes.set(magic);
    expect(() => parseFontFaces(bytes)).toThrow(WoffError);
    expect(() => parseFontFaces(bytes)).toThrow(/convert to TTF or OTF/);
    expect(isWoff(bytes)).toBe(true);
  });

  it("throws FontParseError for corrupt data", () => {
    const font = buildSfnt(spec());
    expect(() => parseFontFaces(new Uint8Array())).toThrow(FontParseError);
    expect(() => parseFontFaces(new Uint8Array(40))).toThrow(FontParseError);
    expect(() => parseFontFaces(font.subarray(0, 20))).toThrow(FontParseError);
    expect(() => parseFontFaces(font.subarray(0, font.length - 10))).toThrow(
      FontParseError,
    );
    const ttc = buildTtc([spec(), spec()]);
    expect(() => parseFontFaces(ttc.subarray(0, 14))).toThrow(FontParseError);
    expect(() => parseFontFaces(ttc.subarray(0, ttc.length - 5))).toThrow(
      FontParseError,
    );
  });

  it("rejects a font with no family name and absurd collections", () => {
    expect(() =>
      parseFontFaces(buildSfnt(spec({ names: [{ id: 4, text: "x" }] }))),
    ).toThrow(FontParseError);
    const ttc = buildTtc([spec()]);
    new DataView(ttc.buffer).setUint32(8, 0xffffffff);
    expect(() => parseFontFaces(ttc)).toThrow(FontParseError);
  });

  it("ignores a name record whose string points outside the table", () => {
    const font = buildSfnt(spec());
    // The full name is the third record; the name table follows the
    // three-entry table directory.
    const nameAt = 12 + 3 * 16;
    new DataView(font.buffer).setUint16(nameAt + 6 + 2 * 12 + 10, 0xfff0);
    const [face] = parseFontFaces(font);
    expect(face).toMatchObject({
      family: "Test Sans",
      fullName: "Test Sans Regular",
    });
  });
});

describe("isWoffPath", () => {
  it("matches by extension, case-insensitively", () => {
    expect(isWoffPath("fonts/A.WOFF2")).toBe(true);
    expect(isWoffPath("a.woff")).toBe(true);
    expect(isWoffPath("a.ttf")).toBe(false);
  });
});
