import { describe, expect, it } from "vitest";

import { CASE_PROBE_PREFIX } from "./folder-fs";
import { GIT_FILE_REASON, IgnoreRules, isCompiledPdf } from "./ignore";

const kind = (rules: IgnoreRules, path: string, isDir = false) =>
  rules.classify(path, isDir).kind;

describe("IgnoreRules", () => {
  it("syncs ordinary files", () => {
    const rules = new IgnoreRules();
    expect(kind(rules, "main.typ")).toBe("sync");
    expect(kind(rules, "figures/a.png")).toBe("sync");
    expect(kind(rules, "figures", true)).toBe("sync");
  });

  it("silently ignores reserved names, junk and swap files", () => {
    const rules = new IgnoreRules();
    for (const path of [
      ".git/config",
      ".GIT/config",
      "a/.typstry/x",
      ".DS_Store",
      "node_modules/x/y.js",
      "a/Thumbs.db",
      "main.typ.crswap",
      `${CASE_PROBE_PREFIX}abc`,
    ]) {
      expect(kind(rules, path)).toBe("ignored");
    }
  });

  it("reports unsafe names as skipped", () => {
    const rules = new IgnoreRules();
    expect(kind(rules, "a:b.typ")).toBe("skipped");
    expect(kind(rules, "dir/CON.txt")).toBe("skipped");
  });

  it("keeps git files local unless .typstryignore opts in", () => {
    const rules = new IgnoreRules();
    expect(rules.classify(".gitignore", false)).toEqual({
      kind: "skipped",
      reason: GIT_FILE_REASON,
    });
    expect(kind(rules, ".GitAttributes")).toBe("skipped");
    expect(kind(rules, ".github", true)).toBe("skipped");
    expect(kind(rules, ".github/workflows/ci.yml")).toBe("skipped");

    rules.addDir("", { typstryignore: "!.gitignore\n!.github/\n" });
    expect(kind(rules, ".gitignore")).toBe("sync");
    expect(kind(rules, ".github", true)).toBe("sync");
    expect(kind(rules, ".gitattributes")).toBe("skipped");
  });

  it("does not let .gitignore opt itself in", () => {
    const rules = new IgnoreRules();
    rules.addDir("", { gitignore: "!.gitignore\n" });
    expect(kind(rules, ".gitignore")).toBe("skipped");
  });

  it("applies .gitignore and .typstryignore, deeper and later winning", () => {
    const rules = new IgnoreRules();
    rules.addDir("", { gitignore: "*.log\nout/\n!keep.log\n" });
    expect(kind(rules, "a.log")).toBe("ignored");
    expect(kind(rules, "keep.log")).toBe("sync");
    expect(kind(rules, "out", true)).toBe("ignored");
    expect(kind(rules, "out", false)).toBe("sync");
    // Nothing inside an ignored folder comes back.
    expect(kind(rules, "out/keep.log")).toBe("ignored");

    rules.addDir("", { typstryignore: "!a.log\n" });
    expect(kind(rules, "a.log")).toBe("sync");

    rules.addDir("sub", { gitignore: "!a.log\nb.typ\n" });
    expect(kind(rules, "sub/b.typ")).toBe("ignored");
    expect(kind(rules, "b.typ")).toBe("sync");
    expect(kind(rules, "sub/a.log")).toBe("sync");
  });

  it("puts .typstryignore above .gitignore in the same folder", () => {
    const rules = new IgnoreRules();
    rules.addDir("", { gitignore: "a.typ\n", typstryignore: "!a.typ\n" });
    expect(kind(rules, "a.typ")).toBe("sync");
    const other = new IgnoreRules();
    other.addDir("", { gitignore: "!a.typ\n", typstryignore: "a.typ\n" });
    expect(kind(other, "a.typ")).toBe("ignored");
  });

  it("reads .git/info/exclude at the lowest priority", () => {
    const rules = new IgnoreRules();
    rules.addExclude("secret.typ\nother.typ\n");
    rules.addDir("", { gitignore: "!other.typ\n" });
    expect(kind(rules, "secret.typ")).toBe("ignored");
    expect(kind(rules, "other.typ")).toBe("sync");
  });
});

describe("isCompiledPdf", () => {
  it("matches a pdf with a sibling .typ", () => {
    const siblings = new Set(["thesis.typ", "thesis.pdf", "paper.pdf"]);
    expect(isCompiledPdf("thesis.pdf", siblings)).toBe(true);
    expect(isCompiledPdf("paper.pdf", siblings)).toBe(false);
    expect(isCompiledPdf("thesis.typ", siblings)).toBe(false);
  });
});
