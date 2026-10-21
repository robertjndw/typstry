import type { Severity, SourceRange, WorkerDiagnostic } from "./protocol";

/** Raw diagnostic as typst.ts 0.7 reports it with `diagnostics: "full"`. */
export interface RawDiagnostic {
  package: string;
  path: string;
  severity: string;
  /** "startLine:startCol-endLine:endCol", or "" when there is no span. */
  range: string;
  message: string;
}

const RANGE = /^(\d+):(\d+)-(\d+):(\d+)$/;

export function parseRange(range: string): SourceRange | null {
  const m = RANGE.exec(range);
  if (!m) return null;
  return {
    startLine: Number(m[1]),
    startCol: Number(m[2]),
    endLine: Number(m[3]),
    endCol: Number(m[4]),
  };
}

// The worker's file system is the in-memory project, so typst.ts reports a
// missing file as "access denied" with a hint about --root, which makes no
// sense in the editor.
const ACCESS_DENIED = /^failed to load file \(access denied\)(, hints: .*)?$/s;

export function normalizeDiagnostic(raw: RawDiagnostic): WorkerDiagnostic {
  return {
    path: raw.path,
    package: raw.package,
    severity: raw.severity === "warning" ? "warning" : "error",
    message: ACCESS_DENIED.test(raw.message) ? "file not found" : raw.message,
    range: parseRange(raw.range),
  };
}

/** A diagnostic resolved against the project: `path` is a project path. */
export interface ProjectDiagnostic {
  /** Project path ("chapters/intro.typ"), or null for package/unknown files. */
  path: string | null;
  /** Human readable location label, e.g. "@preview/cetz:0.3.4/lib.typ". */
  label: string;
  severity: Severity;
  message: string;
  range: SourceRange | null;
  /** What the user can add to make the error go away, if Typst says so. */
  hint?: DiagnosticHint;
}

export type DiagnosticHint =
  { kind: "package"; spec: string } | { kind: "font"; family: string };

const PACKAGE_NOT_FOUND = /^package not found \(searched for (@[^\s)]+)\)/;
const PACKAGE_VERSION_MISSING =
  /^package found, but version (\S+) does not exist/;
const UNKNOWN_FONT = /^unknown font family: (.+)$/s;

/**
 * Typst has no error codes, so the hint comes from the message text. A
 * wording change in a future Typst only loses the hint, not the error.
 */
export function diagnosticHint(message: string): DiagnosticHint | undefined {
  const notFound = PACKAGE_NOT_FOUND.exec(message);
  if (notFound) return { kind: "package", spec: notFound[1]! };
  // The version message may not name the package, so there is nothing to
  // prefill beyond what Typst printed.
  const version = PACKAGE_VERSION_MISSING.exec(message);
  if (version) {
    const spec = /@[^\s/:]+\/[^\s/:]+:[^\s,)]+/.exec(message);
    return { kind: "package", spec: spec ? spec[0] : "" };
  }
  const font = UNKNOWN_FONT.exec(message);
  if (font) return { kind: "font", family: font[1]!.trim() };
  return undefined;
}

export function toProjectDiagnostic(d: WorkerDiagnostic): ProjectDiagnostic {
  const inPackage = d.package !== "";
  const path = !inPackage && d.path.startsWith("/") ? d.path.slice(1) : null;
  const label = inPackage
    ? `${d.package}${d.path}`
    : (path ?? (d.path || "(unknown)"));
  const hint = diagnosticHint(d.message);
  return {
    path,
    label,
    severity: d.severity,
    message: d.message,
    range: d.range,
    ...(hint ? { hint } : {}),
  };
}

/** "main.typ:3:5" style location with 1-based line and column. */
export function formatLocation(d: ProjectDiagnostic): string {
  if (!d.range) return d.label;
  return `${d.label}:${d.range.startLine + 1}:${d.range.startCol + 1}`;
}
