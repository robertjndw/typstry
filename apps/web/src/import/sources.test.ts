// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { ImportError, MAX_IMPORT_BYTES } from "./import";
import { isTreeDrop, readDrop, readFolderPick, readPicked } from "./sources";
import { UnzipLimitError, unzipWithLimits } from "./unzip-limits";

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

  it("does not walk into reserved or clutter folders", async () => {
    const untouchable = {
      isFile: false,
      isDirectory: true,
      createReader() {
        throw new Error("walked into a skipped folder");
      },
    };
    const folder = dirEntry("/thesis", [
      fileEntry("/thesis/main.typ", "= Hi"),
      { ...untouchable, name: ".git", fullPath: "/thesis/.git" },
      {
        ...untouchable,
        name: "node_modules",
        fullPath: "/thesis/node_modules",
      },
    ] as unknown as FileSystemEntry[]);
    const source = await readDrop(transfer([{ entry: folder, file: null }]))!
      .source;
    expect([...source.files.keys()]).toEqual(["main.typ"]);
    // The reserved folder is reported, the clutter is not.
    expect(source.skipped).toEqual([".git"]);
  });

  it("checks file sizes before reading anything", async () => {
    const big = new File(["x"], "video.mp4");
    Object.defineProperty(big, "size", { value: 30 * 1024 * 1024 });
    const read = vi.spyOn(big, "arrayBuffer");
    const small = new File(["x"], "main.typ");
    const readSmall = vi.spyOn(small, "arrayBuffer");
    const dropped = readDrop(
      transfer([
        { entry: null, file: big },
        { entry: null, file: small },
      ]),
    )!;
    await expect(dropped.source).rejects.toMatchObject({
      name: "ImportError",
      paths: ["video.mp4"],
    });
    expect(read).not.toHaveBeenCalled();
    expect(readSmall).not.toHaveBeenCalled();
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

describe("zip limits", () => {
  const limits = { maxEntries: 10, maxEntryBytes: 100, maxTotalBytes: 150 };

  it("rejects entries over the per-file cap by their declared size", () => {
    const zip = zipSync({
      "main.typ": strToU8("x"),
      "big.bin": new Uint8Array(101),
    });
    expect(() => unzipWithLimits(zip, limits)).toThrow(
      expect.objectContaining({ paths: ["big.bin"] }),
    );
  });

  it("rejects archives over the total and the entry count", () => {
    const total = zipSync({
      "a.bin": new Uint8Array(80),
      "b.bin": new Uint8Array(80),
    });
    expect(() => unzipWithLimits(total, limits)).toThrow(/more than 0 MB/);
    const many = zipSync(
      Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`${i}.typ`, strToU8("x")]),
      ),
    );
    expect(() => unzipWithLimits(many, limits)).toThrow(UnzipLimitError);
    expect(() => unzipWithLimits(many, limits)).toThrow(/more than 10/);
  });

  it("refuses to read a zip larger than the import cap", async () => {
    const zip = new File([zipSync({})], "huge.zip");
    Object.defineProperty(zip, "size", { value: MAX_IMPORT_BYTES + 1 });
    await expect(readPicked([zip]).source).rejects.toBeInstanceOf(ImportError);
  });
});

describe("isTreeDrop", () => {
  it("is true for a folder", () => {
    const folder = dirEntry("/thesis", []);
    expect(isTreeDrop(transfer([{ entry: folder, file: null }]))).toBe(true);
  });

  it("is true for a single zip", () => {
    const zip = new File([zipSync({})], "a.zip");
    expect(
      isTreeDrop(transfer([{ entry: fileEntry("/a.zip", ""), file: zip }])),
    ).toBe(true);
  });

  it("is false for a zip dropped with other files", () => {
    const zip = new File([zipSync({})], "a.zip");
    const note = new File(["x"], "n.typ");
    expect(
      isTreeDrop(
        transfer([
          { entry: fileEntry("/a.zip", ""), file: zip },
          { entry: fileEntry("/n.typ", "x"), file: note },
        ]),
      ),
    ).toBe(false);
  });

  it("is false for plain files", () => {
    const note = new File(["x"], "n.typ");
    expect(
      isTreeDrop(transfer([{ entry: fileEntry("/n.typ", "x"), file: note }])),
    ).toBe(false);
    expect(isTreeDrop(transfer([{ entry: null, file: note }]))).toBe(false);
  });
});

describe("readFolderPick", () => {
  it("keeps the picked folder's name", async () => {
    const main = new File(["= Hi"], "main.typ");
    Object.defineProperty(main, "webkitRelativePath", {
      value: "thesis/main.typ",
    });
    const pic = new File(["x"], "a.typ");
    Object.defineProperty(pic, "webkitRelativePath", {
      value: "thesis/figures/a.typ",
    });
    const picked = readFolderPick([main, pic]);
    expect(picked.kind).toBe("files");
    const source = await picked.source;
    expect([...source.files.keys()].sort()).toEqual([
      "thesis/figures/a.typ",
      "thesis/main.typ",
    ]);
  });
});
