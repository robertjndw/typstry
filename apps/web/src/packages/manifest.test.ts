// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseCompiler, parseManifest } from "./manifest";

const base = `[package]
name = "hello"
version = "0.1.0"
entrypoint = "lib.typ"
`;

describe("parseManifest", () => {
  it("reads the required fields", () => {
    expect(parseManifest(base)).toEqual({
      name: "hello",
      version: "0.1.0",
      entrypoint: "lib.typ",
    });
  });

  it("reads the optional fields and ignores everything else", () => {
    const m = parseManifest(`${base}
authors = ["A <a@x.org>", "B"]
license = "MIT"
description = "Says hello."
compiler = "0.12.0"
categories = ["text"]
future-key = 1

[template]
path = "template"

[tool.foo]
x = 1
`);
    expect(m).toEqual({
      name: "hello",
      version: "0.1.0",
      entrypoint: "lib.typ",
      authors: ["A <a@x.org>", "B"],
      license: "MIT",
      description: "Says hello.",
      compiler: "0.12.0",
    });
  });

  it("normalizes the entrypoint", () => {
    const m = parseManifest(base.replace("lib.typ", "./src//lib.typ"));
    expect(m.entrypoint).toBe("src/lib.typ");
  });

  it.each([
    ["not toml", "[package\nname=", /not valid TOML/],
    ["no package table", "[x]\na = 1", /no \[package\]/],
    ["no name", base.replace('name = "hello"\n', ""), /no name/],
    ["no version", base.replace('version = "0.1.0"\n', ""), /no version/],
    [
      "no entrypoint",
      base.replace('entrypoint = "lib.typ"\n', ""),
      /no entrypoint/,
    ],
    ["bad name", base.replace("hello", "1hello"), /not a valid package name/],
    ["bad version", base.replace("0.1.0", "1.0"), /not a valid version/],
    ["prerelease", base.replace("0.1.0", "1.0.0-rc1"), /not a valid version/],
    ["numeric name", base.replace('"hello"', "5"), /must be a string/],
    [
      "absolute entry",
      base.replace("lib.typ", "/lib.typ"),
      /inside the package/,
    ],
    [
      "escaping entry",
      base.replace("lib.typ", "../lib.typ"),
      /inside the package/,
    ],
    ["empty entry", base.replace("lib.typ", ""), /inside the package/],
    ["bad compiler", `${base}compiler = "new"`, /compiler version/],
  ])("rejects %s", (_label, text, message) => {
    expect(() => parseManifest(text)).toThrow(message);
  });
});

describe("parseCompiler", () => {
  it("pads short versions", () => {
    expect(parseCompiler("0.12")).toEqual([0, 12, 0]);
    expect(parseCompiler("1")).toEqual([1, 0, 0]);
    expect(parseCompiler("0.12.1")).toEqual([0, 12, 1]);
    expect(parseCompiler("0.12.1.2")).toBeNull();
    expect(parseCompiler("")).toBeNull();
  });
});
