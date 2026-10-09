import type { Extension } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";

import { fileCategory } from "@/assets/file-types";

// Shared on purpose. Every typst() call creates a new Language, and when the
// language changes CodeMirror throws away the syntax tree and reparses.
export const typstLanguage: Extension = typst();
const plainText: Extension = [];

/**
 * Syntax support for the file at `path`. Only .typ files get Typst
 * highlighting; its markup rules would color random characters in data
 * and other plain text files.
 */
export function languageFor(path: string): Extension {
  return fileCategory(path) === "typst" ? typstLanguage : plainText;
}
