// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ImportError } from "@/import/import";

import { handleFs } from "./folder-fs";
import { scanFolder } from "./scan";
import { fakeFolder } from "./test-utils";

async function scan(
  files: Record<string, string | Uint8Array>,
  opts?: Parameters<typeof scanFolder>[1],
) {
  const folder = fakeFolder(files);
  return { folder, result: await scanFolder(handleFs(folder.handle), opts) };
}

describe("scanFolder", () => {
  it("lists files with size and mtime and folders", async () => {
    const { folder, result } = await scan({
      "main.typ": "= Hi",
      "chapters/one.typ": "one",
      "empty/": "",
    });
    expect([...result.files.keys()].sort()).toEqual([
      "chapters/one.typ",
      "main.typ",
    ]);
    expect(result.files.get("main.typ")).toEqual({
      size: 4,
      mtime: folder.clock.now(),
    });
    expect([...result.dirs].sort()).toEqual(["chapters", "empty"]);
    expect(result.skipped).toEqual([]);
  });

  it("applies ignore files as it descends and never lists ignored folders", async () => {
    const { result } = await scan({
      ".gitignore": "*.aux\nbuild/\n",
      "main.typ": "x",
      "main.aux": "x",
      "build/out.txt": "x",
      "sub/.typstryignore": "secret.typ\n",
      "sub/secret.typ": "x",
      "sub/ok.typ": "x",
      "node_modules/pkg/index.js": "x",
      ".git/info/exclude": "excluded.typ\n",
      ".git/config": "x",
      "excluded.typ": "x",
    });
    expect([...result.files.keys()].sort()).toEqual(["main.typ", "sub/ok.typ"]);
    expect(result.present.has("main.aux")).toBe(true);
    expect(result.present.has("sub/secret.typ")).toBe(true);
    expect(result.present.has("excluded.typ")).toBe(true);
    expect(result.present.has("build")).toBe(true);
    expect(result.present.has("build/out.txt")).toBe(false);
    expect(result.present.has("node_modules/pkg/index.js")).toBe(false);
    // Git files are reported, ignored paths are not.
    expect(result.skipped.map((s) => s.path).sort()).toEqual([
      ".gitignore",
      "sub/.typstryignore",
    ]);
  });

  it("reports unsafe names and oversized files", async () => {
    const { result } = await scan(
      { "a:b.typ": "x", "big.bin": new Uint8Array(11), "small.bin": "x" },
      { maxFileBytes: 10 },
    );
    expect([...result.files.keys()]).toEqual(["small.bin"]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual([
      "a:b.typ",
      "big.bin",
    ]);
    expect(result.present.has("big.bin")).toBe(true);
  });

  it("skips a pdf next to its source", async () => {
    const { result } = await scan({
      "thesis.typ": "x",
      "thesis.pdf": "x",
      "paper.pdf": "x",
    });
    expect([...result.files.keys()].sort()).toEqual([
      "paper.pdf",
      "thesis.typ",
    ]);
    expect(result.present.has("thesis.pdf")).toBe(true);
  });

  it("stops at the entry limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.typ`] = "x";
    await expect(scan(files, { maxEntries: 4 })).rejects.toBeInstanceOf(
      ImportError,
    );
    await expect(scan(files, { maxEntries: 5 })).resolves.toBeDefined();
  });
});
