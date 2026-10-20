// What the compiler ships with. The lists mirror the font files typst.ts
// fetches for each bundle (options.init.mjs); bytes are the download sizes
// of the typst-assets / typst-dev-assets v0.15.0 files, for UI copy only.

export type FontBundleId = "cjk" | "emoji";

export interface FontBundle {
  label: string;
  families: readonly string[];
  /** Approximate download size in bytes. */
  bytes: number;
}

/** The "text" bundle, always loaded. */
export const BUILTIN_FAMILIES: readonly string[] = [
  "Libertinus Serif",
  "New Computer Modern",
  "New Computer Modern Math",
  "DejaVu Sans Mono",
];

/** Download size of the "text" bundle, about 9.7 MB. */
export const BUILTIN_BYTES = 9_682_300;

export const FONT_BUNDLES: Record<FontBundleId, FontBundle> = {
  cjk: {
    label: "CJK fonts",
    families: ["Noto Serif CJK SC", "Inria Serif", "Roboto"],
    bytes: 2_049_112,
  },
  emoji: {
    label: "Color emoji",
    families: ["Twitter Color Emoji", "Noto Color Emoji"],
    bytes: 18_063_992,
  },
};
