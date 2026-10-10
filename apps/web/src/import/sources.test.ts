// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readDrop, readPicked } from "./sources";

function fileEntry(fullPath: string, text: string): FileSystemEntry {
  const name = fullPath.slice(fullPath.lastIndexOf("/") + 1);
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (resolve: (f: File) => void) => resolve(new File([text], name)),
  } as unknown as FileSystemEntry;
}

function dirEntry(fullPath: string, children: FileSystemEntry[]) {
  return {
    isFile: false,
    isDirectory: true,
    name: fullPath.slice(fullPath.lastIndexOf("/") + 1),
    fullPath,
    createReader() {
      // Two calls: the batch, then the empty one that ends the listing.
      let batches = [children, []];
      return {
        readEntries: (resolve: (e: FileSystemEntry[]) => void) => {
          resolve(batches[0]!);
          batches = batches.slice(1);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function transfer(
  items: { entry: FileSystemEntry | null; file: File | null }[],
): DataTransfer {
  return {
    items: items.map(({ entry, file }) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
      getAsFile: () => file,
    })),
    files: items.flatMap(({ file }) => (file ? [file] : [])),
  } as unknown as DataTransfer;
}

describe("readDrop", () => {
  it("walks a dropped folder, empty subfolders included", async () => {
    const folder = dirEntry("/thesis", [
      fileEntry("/thesis/main.typ", "= Hi"),
      dirEntry("/thesis/figures", []),
    ]);
    const dropped = readDrop(transfer([{ entry: folder, file: null }]))!;
    expect(dropped.kind).toBe("files");

    const source = await dropped.source;
    expect(source.name).toBe("thesis");
    expect([...source.files.keys()]).toEqual(["main.typ"]);
    expect([...source.dirs]).toEqual(["figures"]);
  });

  it("unpacks a single dropped zip", async () => {
    const zip = new File(
      [zipSync({ "main.typ": strToU8("= Hi") })],
      "Paper.ZIP",
    );
    const dropped = readDrop(
      transfer([{ entry: fileEntry("/Paper.ZIP", ""), file: zip }]),
    )!;
    expect(dropped.kind).toBe("zip");
    expect([...(await dropped.source).files.keys()]).toEqual(["main.typ"]);
  });

  it("falls back to plain files when there are no entries", async () => {
    const file = new File(["x"], "notes.typ");
    const dropped = readDrop(transfer([{ entry: null, file }]))!;
    expect([...(await dropped.source).files.keys()]).toEqual(["notes.typ"]);
  });

  it("ignores drops without files", () => {
    expect(readDrop(transfer([]))).toBeNull();
  });
});

describe("readPicked", () => {
  it("unpacks a single zip", async () => {
    const zip = new File([zipSync({ "a.typ": strToU8("x") })], "a.zip");
    const picked = readPicked([zip]);
    expect(picked.kind).toBe("zip");
    expect([...(await picked.source).files.keys()]).toEqual(["a.typ"]);
  });

  it("imports anything else as loose files", async () => {
    const picked = readPicked([
      new File(["x"], "main.typ"),
      new File([zipSync({})], "data.zip"),
    ]);
    expect(picked.kind).toBe("files");
    expect([...(await picked.source).files.keys()].sort()).toEqual([
      "data.zip",
      "main.typ",
    ]);
  });
});
