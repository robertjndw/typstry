import { typographicFamily } from "./typst-family";

// Cases from the test_trim_styles unit test in Typst 0.15.
describe("typographicFamily", () => {
  it.each([
    ["Atma Light", "Atma"],
    ["eras bold", "eras"],
    ["footlight mt light", "footlight mt"],
    ["times new roman", "times new roman"],
    ["noto sans mono cond sembd", "noto sans mono"],
    ["noto serif SEMCOND sembd", "noto serif"],
    ["crimson text", "crimson text"],
    ["footlight light", "footlight"],
    ["Noto Sans", "Noto Sans"],
    ["Noto Sans Light", "Noto Sans"],
    ["Noto Sans Semicondensed Heavy", "Noto Sans"],
    ["Familx", "Familx"],
    ["Font Ultra", "Font Ultra"],
    ["Font Ultra Bold", "Font"],
  ])("%s -> %s", (input, expected) => {
    expect(typographicFamily(input)).toBe(expected);
  });

  it("drops the leading dots of Apple system fonts", () => {
    expect(typographicFamily(".SF NS Bold")).toBe("SF NS");
  });

  it("keeps a name that is only a style word", () => {
    expect(typographicFamily("Bold")).toBe("Bold");
  });

  it("leaves non-ASCII letters alone", () => {
    expect(typographicFamily("İstanbul Light")).toBe("İstanbul");
  });
});
