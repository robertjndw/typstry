import { Text } from "@codemirror/state";

import {
  diagnosticHint,
  formatLocation,
  normalizeDiagnostic,
  parseRange,
  toProjectDiagnostic,
  type ProjectDiagnostic,
} from "./diagnostics";
import { toCodeMirrorDiagnostics } from "./lint";

describe("typst diagnostics", () => {
  it("parses typst.ts range strings", () => {
    expect(parseRange("4:17-4:29")).toEqual({
      startLine: 4,
      startCol: 17,
      endLine: 4,
      endCol: 29,
    });
    expect(parseRange("")).toBeNull();
  });

  it("normalizes raw diagnostics and maps paths to the project", () => {
    const d = toProjectDiagnostic(
      normalizeDiagnostic({
        package: "",
        path: "/chapters/a.typ",
        severity: "warning",
        range: "0:16-0:22",
        message: "unknown font family: nope",
      }),
    );
    expect(d).toEqual({
      path: "chapters/a.typ",
      label: "chapters/a.typ",
      severity: "warning",
      message: "unknown font family: nope",
      range: { startLine: 0, startCol: 16, endLine: 0, endCol: 22 },
      hint: { kind: "font", family: "nope" },
    });
    expect(formatLocation(d)).toBe("chapters/a.typ:1:17");
  });

  it("rewrites the in-memory 'access denied' error to file not found", () => {
    const d = normalizeDiagnostic({
      package: "",
      path: "/main.typ",
      severity: "error",
      range: "2:9-2:20",
      message:
        "failed to load file (access denied), hints: cannot read file outside of project root, you can adjust the project root with the --root argument",
    });
    expect(d.message).toBe("file not found");
  });

  it("keeps package diagnostics out of project files", () => {
    const d = toProjectDiagnostic({
      package: "@preview/cetz:0.3.4",
      path: "/src/lib.typ",
      severity: "error",
      message: "boom",
      range: null,
    });
    expect(d.path).toBeNull();
    expect(d.label).toBe("@preview/cetz:0.3.4/src/lib.typ");
  });
});

describe("toCodeMirrorDiagnostics", () => {
  const diag = (
    path: string | null,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): ProjectDiagnostic => ({
    path,
    label: path ?? "",
    severity: "error",
    message: "m",
    range: { startLine, startCol, endLine, endCol },
  });

  it("converts code point columns to UTF-16 offsets", () => {
    // Real typst.ts output for this source: "unknown variable" at 1:4-1:16.
    // Each emoji is one column for typst but two UTF-16 units for CM.
    const doc = Text.of(["#let a = 1", "😀😀 #undefinedvar"]);
    const [d] = toCodeMirrorDiagnostics(
      [diag("main.typ", 1, 4, 1, 16)],
      "main.typ",
      doc,
    );
    const line = doc.line(2);
    expect(doc.sliceString(d!.from, d!.to)).toBe("undefinedvar");
    expect(d!.from).toBe(line.from + 6);
  });

  it("only returns diagnostics for the requested file", () => {
    const doc = Text.of(["abc"]);
    const out = toCodeMirrorDiagnostics(
      [
        diag("a.typ", 0, 0, 0, 1),
        diag("b.typ", 0, 1, 0, 2),
        diag(null, 0, 0, 0, 1),
      ],
      "b.typ",
      doc,
    );
    expect(out).toEqual([{ from: 1, to: 2, severity: "error", message: "m" }]);
  });

  it("clamps ranges from a stale compile to the current document", () => {
    const doc = Text.of(["short"]);
    const [d] = toCodeMirrorDiagnostics(
      [diag("a.typ", 0, 3, 9, 4)],
      "a.typ",
      doc,
    );
    expect(d).toMatchObject({ from: 3, to: 5 });
    const [e] = toCodeMirrorDiagnostics(
      [diag("a.typ", 0, 50, 0, 60)],
      "a.typ",
      doc,
    );
    expect(e).toMatchObject({ from: 5, to: 5 });
  });

  it("spans multiple lines", () => {
    const doc = Text.of(["ab", "cd"]);
    const [d] = toCodeMirrorDiagnostics(
      [diag("a.typ", 0, 1, 1, 1)],
      "a.typ",
      doc,
    );
    expect(doc.sliceString(d!.from, d!.to)).toBe("b\nc");
  });

  it("pins diagnostics without a range to the start of the file", () => {
    const doc = Text.of(["abc"]);
    const out = toCodeMirrorDiagnostics(
      [
        {
          path: "a.typ",
          label: "a.typ",
          severity: "warning",
          message: "w",
          range: null,
        },
      ],
      "a.typ",
      doc,
    );
    expect(out).toEqual([
      { from: 0, to: 0, severity: "warning", message: "w" },
    ]);
  });

  it("hints at the package a missing import names", () => {
    expect(
      diagnosticHint("package not found (searched for @local/hello:0.1.0)"),
    ).toEqual({ kind: "package", spec: "@local/hello:0.1.0" });
    expect(
      diagnosticHint(
        "package not found (searched for @preview/cetz:0.3.4), hints: x",
      ),
    ).toEqual({ kind: "package", spec: "@preview/cetz:0.3.4" });
  });

  it("hints at a package version that does not exist", () => {
    expect(
      diagnosticHint("package found, but version 9.9.9 does not exist"),
    ).toEqual({ kind: "package", spec: "" });
    expect(
      diagnosticHint(
        "package found, but version 9.9.9 does not exist (@preview/cetz:9.9.9)",
      ),
    ).toEqual({ kind: "package", spec: "@preview/cetz:9.9.9" });
  });

  it("hints at an unknown font family and leaves other messages alone", () => {
    expect(diagnosticHint("unknown font family: fira sans")).toEqual({
      kind: "font",
      family: "fira sans",
    });
    expect(diagnosticHint("file not found")).toBeUndefined();
    const d = toProjectDiagnostic({
      package: "",
      path: "/main.typ",
      severity: "error",
      message: "file not found",
      range: null,
    });
    expect("hint" in d).toBe(false);
  });
});
