import type { Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { ProjectDiagnostic } from "./diagnostics";

/**
 * Converts a code point column within `line` to a UTF-16 offset, which is
 * what CodeMirror (and Loro's JS API) use. Typst counts columns in chars, so
 * anything outside the BMP (emoji, some CJK) shifts the two apart.
 */
function codePointColToUtf16(line: string, col: number): number {
  let offset = 0;
  for (let i = 0; i < col && offset < line.length; i++) {
    const code = line.codePointAt(offset)!;
    offset += code > 0xffff ? 2 : 1;
  }
  return Math.min(offset, line.length);
}

function toOffset(doc: Text, line: number, col: number): number {
  if (line + 1 > doc.lines) return doc.length;
  const l = doc.line(line + 1);
  return l.from + codePointColToUtf16(l.text, col);
}

/**
 * Where `d` sits in `doc`. Diagnostics without a span are pinned to the
 * start of the file so they still show up in the gutter.
 */
export function diagnosticRange(
  d: ProjectDiagnostic,
  doc: Text,
): { from: number; to: number } {
  if (!d.range) return { from: 0, to: 0 };
  const from = toOffset(doc, d.range.startLine, d.range.startCol);
  const to = Math.max(from, toOffset(doc, d.range.endLine, d.range.endCol));
  return { from, to };
}

/** Picks the diagnostics for one project file and maps them onto `doc`. */
export function toCodeMirrorDiagnostics(
  diagnostics: readonly ProjectDiagnostic[],
  path: string,
  doc: Text,
): Diagnostic[] {
  return diagnostics
    .filter((d) => d.path === path)
    .map((d) => ({
      ...diagnosticRange(d, doc),
      severity: d.severity,
      message: d.message,
    }));
}
