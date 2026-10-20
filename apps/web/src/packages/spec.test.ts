// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  formatSpec,
  importSnippet,
  isIdent,
  packageKey,
  parsePinInput,
  parseSpec,
  parseVersion,
} from "./spec";

describe("isIdent", () => {
  it("follows Typst's identifier rules", () => {
    for (const ok of ["cetz", "_x", "a-b_c1", "über", "名前"]) {
      expect(isIdent(ok), ok).toBe(true);
    }
    for (const bad of ["", "1a", "-a", "a b", "a/b", "a.b", "a:b"]) {
      expect(isIdent(bad), bad).toBe(false);
    }
  });
});

describe("versions", () => {
  it("parses three plain numbers", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.0.0")).toEqual([0, 0, 0]);
    expect(parseVersion("4294967295.0.0")).toEqual([4294967295, 0, 0]);
  });

  it("rejects everything else", () => {
    for (const bad of [
      "1.2",
      "1.2.3.4",
      "1.2.3-rc1",
      "1.2.3+b",
      "01.2.3",
      "v1.2.3",
      "a.b.c",
      "4294967296.0.0",
      "",
    ]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it("compares numerically", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v("1.10.0"), v("1.9.0"))).toBe(1);
    expect(compareVersions(v("0.15.0"), v("0.15.0"))).toBe(0);
    expect(compareVersions(v("0.9.9"), v("0.10.0"))).toBe(-1);
  });
});

describe("specs", () => {
  it("parses and formats", () => {
    const spec = parseSpec("@preview/cetz:0.4.2");
    expect(spec).toEqual({
      namespace: "preview",
      name: "cetz",
      version: "0.4.2",
    });
    expect(formatSpec(spec!)).toBe("@preview/cetz:0.4.2");
    expect(importSnippet(spec!)).toBe('#import "@preview/cetz:0.4.2": *');
  });

  it("rejects malformed specs", () => {
    for (const bad of [
      "preview/cetz:0.4.2",
      "@preview/cetz",
      "@preview/cetz:1.0",
      "@preview/1x:1.0.0",
      "@preview/a/b:1.0.0",
      "@/cetz:1.0.0",
      "@preview/cetz:1.0.0 ",
    ]) {
      expect(parseSpec(bad), bad).toBeNull();
    }
  });

  it("accepts short forms as pin input, defaulting to preview", () => {
    const cetz = { namespace: "preview", name: "cetz", version: "0.4.2" };
    for (const text of [
      "@preview/cetz:0.4.2",
      "cetz:0.4.2",
      "cetz 0.4.2",
      "  cetz  v0.4.2 ",
      "@preview/cetz 0.4.2",
      "preview/cetz:0.4.2",
    ]) {
      expect(parsePinInput(text), text).toEqual(cetz);
    }
    expect(parsePinInput("@local/x:1.0.0")?.namespace).toBe("local");
    expect(parsePinInput("cetz")).toBeNull();
    expect(parsePinInput("cetz 1.0")).toBeNull();
  });

  it("re-exports the key of a package", () => {
    expect(
      packageKey({ namespace: "local", name: "x", version: "1.0.0" }),
    ).toBe("local/x/1.0.0");
  });
});
