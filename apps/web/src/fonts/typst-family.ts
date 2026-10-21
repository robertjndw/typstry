// Port of `typographic_family` from typst-library 0.15
// (src/text/font/info.rs). Typst groups fonts by name ID 1 with the style
// words trimmed off, so this has to match it exactly or the name we show
// would not work in `#set text(font: ...)`.

const SEPARATORS = [" ", "-", "_"];

// Modifiers that can precede a style suffix ("Semi" + "Bold").
const MODIFIERS = [
  "extra",
  "ext",
  "ex",
  "x",
  "semi",
  "sem",
  "sm",
  "demi",
  "dem",
  "ultra",
];

// Order matters: the first suffix that matches wins, as in Typst.
const SUFFIXES = [
  "normal",
  "italic",
  "oblique",
  "slanted",
  "thin",
  "th",
  "hairline",
  "light",
  "lt",
  "regular",
  "medium",
  "med",
  "md",
  "bold",
  "bd",
  "demi",
  "extb",
  "black",
  "blk",
  "bk",
  "heavy",
  "narrow",
  "condensed",
  "cond",
  "cn",
  "cd",
  "compressed",
  "expanded",
  "exp",
  "vf",
  "var",
  "variable",
];

// toLowerCase would also fold non-ASCII letters and can change the length,
// and the length is used to slice the original string.
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function stripAny(text: string, suffixes: readonly string[]): string | null {
  for (const suffix of suffixes) {
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  }
  return null;
}

/** Trims style naming from a name ID 1 family: "Noto Sans Light" -> "Noto Sans". */
export function typographicFamily(name: string): string {
  // Apple's system fonts have leading dots.
  const family = name.trim().replace(/^\.+/, "");
  const lower = asciiLower(family);
  let len = Infinity;
  let trimmed = lower;

  while (trimmed.length < len) {
    len = trimmed.length;

    let t = trimmed;
    let shortened = false;
    for (let s = stripAny(t, SUFFIXES); s !== null; s = stripAny(t, SUFFIXES)) {
      shortened = true;
      t = s;
    }
    if (!shortened) break;

    const sep = stripAny(t, SEPARATORS);
    if (sep !== null) {
      trimmed = sep;
      t = sep;
    }

    // A modifier only counts when a separator splits it from the base name,
    // otherwise "Familx" would lose its x.
    const modified = stripAny(t, MODIFIERS);
    if (modified !== null) {
      const base = stripAny(modified, SEPARATORS);
      if (base !== null) trimmed = base;
    }
  }

  return family.slice(0, len);
}
