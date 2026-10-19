import { describe, expect, it } from "vitest";

import { parseGitignore } from "./gitignore";

function verdict(rules: string, path: string, isDir = false, base = "") {
  return parseGitignore(rules, base).match(path, isDir);
}

describe("parseGitignore", () => {
  it("skips comments and blank lines", () => {
    expect(verdict("# a.typ\n\n", "a.typ")).toBeNull();
    expect(verdict("\\#a.typ", "#a.typ")).toBe("ignore");
  });

  it("matches a bare name at any depth", () => {
    expect(verdict("*.log", "a.log")).toBe("ignore");
    expect(verdict("*.log", "x/y/a.log")).toBe("ignore");
    expect(verdict("*.log", "a.logs")).toBeNull();
  });

  it("lets the last matching rule win and supports negation", () => {
    const rules = "*.png\n!keep.png";
    expect(verdict(rules, "a.png")).toBe("ignore");
    expect(verdict(rules, "keep.png")).toBe("include");
    expect(verdict("!a\na", "a")).toBe("ignore");
  });

  it("limits a trailing slash to folders", () => {
    expect(verdict("build/", "build", true)).toBe("ignore");
    expect(verdict("build/", "build", false)).toBeNull();
  });

  it("anchors patterns with a slash", () => {
    expect(verdict("/a.typ", "a.typ")).toBe("ignore");
    expect(verdict("/a.typ", "x/a.typ")).toBeNull();
    expect(verdict("doc/a.typ", "doc/a.typ")).toBe("ignore");
    expect(verdict("doc/a.typ", "x/doc/a.typ")).toBeNull();
  });

  it("does not let * cross a slash", () => {
    expect(verdict("doc/*.typ", "doc/a.typ")).toBe("ignore");
    expect(verdict("doc/*.typ", "doc/x/a.typ")).toBeNull();
    expect(verdict("a?c", "abc")).toBe("ignore");
    expect(verdict("a?c", "a/c")).toBeNull();
  });

  it("handles **", () => {
    expect(verdict("**/cache", "a/b/cache", true)).toBe("ignore");
    expect(verdict("**/cache", "cache", true)).toBe("ignore");
    expect(verdict("a/**", "a/b/c.typ")).toBe("ignore");
    expect(verdict("a/**", "a", true)).toBeNull();
    expect(verdict("a/**/z", "a/z")).toBe("ignore");
    expect(verdict("a/**/z", "a/x/y/z")).toBe("ignore");
    expect(verdict("a/**/z", "b/z")).toBeNull();
  });

  it("handles classes", () => {
    expect(verdict("[ab].typ", "a.typ")).toBe("ignore");
    expect(verdict("[ab].typ", "c.typ")).toBeNull();
    expect(verdict("[a-c].typ", "b.typ")).toBe("ignore");
    expect(verdict("[!a-c].typ", "d.typ")).toBe("ignore");
    expect(verdict("[!a-c].typ", "a.typ")).toBeNull();
    expect(verdict("[]a].typ", "].typ")).toBe("ignore");
    expect(verdict("[a.typ", "[a.typ")).toBe("ignore");
  });

  it("handles escapes and trailing spaces", () => {
    expect(verdict("\\!a", "!a")).toBe("ignore");
    expect(verdict("a\\*", "a*")).toBe("ignore");
    expect(verdict("a\\*", "ab")).toBeNull();
    expect(verdict("a  ", "a")).toBe("ignore");
    expect(verdict("a\\ ", "a ")).toBe("ignore");
    expect(verdict("a\\ ", "a")).toBeNull();
  });

  it("treats regex characters literally", () => {
    expect(verdict("a+b(1).typ", "a+b(1).typ")).toBe("ignore");
    expect(verdict("a.typ", "aXtyp")).toBeNull();
  });

  it("is relative to its base folder", () => {
    expect(verdict("*.log", "sub/a.log", false, "sub")).toBe("ignore");
    expect(verdict("*.log", "a.log", false, "sub")).toBeNull();
    expect(verdict("/a", "sub/a", false, "sub")).toBe("ignore");
    expect(verdict("/a", "sub/x/a", false, "sub")).toBeNull();
  });

  it("copes with CRLF files", () => {
    expect(verdict("a.typ\r\nb.typ\r\n", "b.typ")).toBe("ignore");
  });
});
