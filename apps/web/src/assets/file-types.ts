import { extensionOf } from "@/doc/names";

export type FileCategory =
  | "typst"
  | "text"
  | "image"
  | "pdf"
  | "font"
  | "audio"
  | "video"
  | "data"
  | "other";

const GENERIC_MIME = new Set(["", "application/octet-stream"]);

/** Not registered anywhere; only used to tell .typ files apart. */
const TYPST_MIME = "text/x-typst";

const MIME_BY_EXTENSION: Record<string, string> = {
  typ: TYPST_MIME,
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  ttf: "font/ttf",
  otf: "font/otf",
  ttc: "font/collection",
  otc: "font/collection",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  bib: "application/x-bibtex",
  csv: "text/csv",
  json: "application/json",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
};

// Includes the variants browsers report for some of these, which differ
// from the ones in the table above.
const DATA_MIMES = new Set([
  "application/x-bibtex",
  "text/x-bibtex",
  "text/csv",
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "text/yaml",
  "application/toml",
  "application/xml",
  "text/xml",
]);

/**
 * The reported type when it is specific, else a guess from the extension.
 * Browsers report nothing useful for extensions they do not know, which
 * includes most fonts on some platforms, and older uploads may have stored
 * such a generic type.
 */
export function mimeOf(file: { name: string; type: string }): string {
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  if (!GENERIC_MIME.has(type)) return type;
  return (
    MIME_BY_EXTENSION[extensionOf(file.name)] ?? "application/octet-stream"
  );
}

/**
 * What kind of file this is, for picking an icon and a viewer. Text files
 * carry no mime, so for them the extension decides.
 */
export function fileCategory(name: string, mime = ""): FileCategory {
  const type = mimeOf({ name, type: mime });
  if (type === TYPST_MIME) return "typst";
  if (type === "application/pdf") return "pdf";
  if (DATA_MIMES.has(type)) return "data";
  const top = type.slice(0, type.indexOf("/"));
  if (
    top === "text" ||
    top === "image" ||
    top === "audio" ||
    top === "video" ||
    top === "font"
  )
    return top;
  return "other";
}

// Types that render without running script. Everything else, notably
// text/html and image/svg+xml, would turn an object URL into a page on the
// app's origin if someone opened it in a tab.
const INERT_MIME =
  /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|font\/[a-z0-9.+-]+|audio\/(mpeg|wav|ogg|mp4|flac)|video\/(mp4|webm|quicktime)|text\/plain)$/;

/**
 * The type to give an object URL of a file's bytes. The stored mime comes
 * from whoever uploaded the file, so it is only passed through when it is
 * known not to be active content.
 */
export function inertBlobType(mime: string): string {
  return INERT_MIME.test(mime) ? mime : "application/octet-stream";
}

/**
 * Image formats every current browser decodes, so a preview is worth
 * trying. TIFF, HEIC and friends get the generic view instead of a broken
 * image.
 */
export const PREVIEWABLE_IMAGE =
  /^image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp)$/;
