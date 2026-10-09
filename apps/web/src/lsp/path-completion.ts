import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

import { fileCategory } from "@/assets/file-types";
import { dirname, extensionOf } from "@/doc/names";

// tinymist completes paths only for files open in the editor when it runs
// in the browser (it cannot list a directory), so project file names come
// from here instead.

type PathFilter = (path: string) => boolean;

const hasExtension =
  (...extensions: string[]): PathFilter =>
  (path) =>
    extensions.includes(extensionOf(path));

// Functions and keywords whose first argument is a file path.
const PATH_ARGUMENTS: Record<string, PathFilter> = {
  include: hasExtension("typ"),
  import: hasExtension("typ"),
  image: (path) => fileCategory(path) === "image",
  bibliography: hasExtension("bib", "yml", "yaml"),
  json: hasExtension("json"),
  csv: hasExtension("csv", "tsv"),
  yaml: hasExtension("yml", "yaml"),
  toml: hasExtension("toml"),
  xml: hasExtension("xml"),
  cbor: hasExtension("cbor"),
  plugin: hasExtension("wasm"),
  read: () => true,
};

// Matched on the text rather than a syntax tree: while the closing quote is
// missing, the rest of the line does not parse as a string, and that is
// exactly when completions are wanted.
const PATH_STRING = new RegExp(
  `(?<![\\w.-])(${Object.keys(PATH_ARGUMENTS).join("|")})(?:\\s*\\(\\s*|\\s+)"([^"\\\\\\n]*)$`,
);

/** `target` as Typst resolves it from a file in `fromDir`. */
export function relativePath(fromDir: string, target: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const to = target.split("/");
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length - 1 &&
    from[shared] === to[shared]
  )
    shared++;
  return [
    ...Array<string>(from.length - shared).fill(".."),
    ...to.slice(shared),
  ].join("/");
}

/**
 * Project files inside path arguments such as `#include "` or `#image("`,
 * filtered to what the function accepts and relative to the edited file.
 * `files` returns every project file path (no folders).
 */
export function pathCompletion(
  currentPath: string,
  files: () => readonly string[],
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const match = PATH_STRING.exec(
      context.state.sliceDoc(line.from, context.pos),
    );
    const [, func = "", typed = ""] = match ?? [];
    const accepts = PATH_ARGUMENTS[func];
    // Package imports such as "@preview/cetz:0.3.4" are not project files.
    if (!accepts || typed.startsWith("@")) return null;

    // A leading slash makes Typst resolve from the project root.
    const absolute = typed.startsWith("/");
    const fromDir = dirname(currentPath);
    const options: Completion[] = files()
      .filter((path) => path !== currentPath && accepts(path))
      .map((path) => ({
        label: absolute ? `/${path}` : relativePath(fromDir, path),
        type: "text",
        detail: fileCategory(path),
      }));
    return {
      from: context.pos - typed.length,
      options,
      validFor: /^[^"\\\n]*$/,
    };
  };
}
