// Characters that Windows, macOS or common shells reject or mangle in a
// file name, plus control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/**
 * A download file name built from free-form parts, e.g. the project title
 * and a version label.
 */
export function downloadFilename(parts: string[], extension: string): string {
  const name = parts
    .map((part) =>
      part.replace(UNSAFE_FILENAME, "-").replace(/\s+/g, " ").trim(),
    )
    .filter((part) => part !== "" && !/^[.-]+$/.test(part))
    .join(" - ");
  return `${name || "project"}.${extension}`;
}

/** Hands `blob` to the browser as a file download. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking right away cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
