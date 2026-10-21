// @vitest-environment node
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ImportSource } from "@/import/import";

import { PackageError } from "./errors";
import { gunzipLimited, gzipDeterministic } from "./gzip";
import { MAX_PACKAGE_ARCHIVE_BYTES } from "./archive-limit";
import { MAX_PACKAGE_FILES } from "./limits";
import { locateRoot, preparePackage } from "./normalize";
import { readTar, writeTar } from "./tar";

const enc = new TextEncoder();

const MANIFEST = `[package]
name = "hello"
version = "0.1.0"
entrypoint = "lib.typ"
description = "Hi"
`;

function pkgFiles(extra: Record<string, string> = {}, manifest = MANIFEST) {
  return new Map(
    Object.entries({
      "typst.toml": manifest,
      "lib.typ": "#let hi = [Hello]",
      ...extra,
    }).map(([k, v]) => [k, enc.encode(v)]),
  );
}

function prefixed(files: Map<string, Uint8Array>, prefix: string) {
  return new Map([...files].map(([k, v]) => [prefix + k, v]));
}

function tgz(files: Map<string, Uint8Array>, name = "p.tar.gz") {
  return new File(
    [gzipDeterministic(writeTar(files)) as Uint8Array<ArrayBuffer>],
    name,
  );
}

function zip(files: Map<string, Uint8Array>) {
  return new File(
    [zipSync(Object.fromEntries(files)) as Uint8Array<ArrayBuffer>],
    "p.zip",
  );
}

function source(files: Map<string, Uint8Array>, skipped: string[] = []) {
  const s: ImportSource = { name: "p", files, dirs: new Set(), skipped };
  return Promise.resolve(s);
}

function unpack(archive: Uint8Array) {
  return readTar(gunzipLimited(archive, 10_000_000));
}

describe("locateRoot", () => {
  it("accepts typst.toml at the top", () => {
    const files = pkgFiles();
    expect(locateRoot(files)).toEqual({ root: "", files });
  });

  it("strips a single wrapper folder", () => {
    const { root, files } = locateRoot(prefixed(pkgFiles(), "hello-0.1.0/"));
    expect(root).toBe("hello-0.1.0");
    expect([...files.keys()].sort()).toEqual(["lib.typ", "typst.toml"]);
  });

  it.each([
    ["nothing", new Map()],
    ["no manifest", new Map([["lib.typ", enc.encode("")]])],
    ["a deeper manifest", prefixed(pkgFiles(), "a/b/")],
    [
      "two folders",
      new Map([...prefixed(pkgFiles(), "a/"), ...prefixed(pkgFiles(), "b/")]),
    ],
    [
      "a wrapper next to a stray file",
      new Map([...prefixed(pkgFiles(), "a/"), ["README", enc.encode("")]]),
    ],
  ])("rejects %s", (_label, files) => {
    expect(() => locateRoot(files)).toThrow(
      "No typst.toml at the top of the package or inside a single folder.",
    );
  });
});

describe("preparePackage", () => {
  it("repacks a tar.gz canonically", async () => {
    const prepared = await preparePackage({
      kind: "archive",
      file: tgz(prefixed(pkgFiles({ "sub/a.typ": "x" }), "hello/")),
    });
    expect(prepared.manifest).toMatchObject({
      name: "hello",
      version: "0.1.0",
      entrypoint: "lib.typ",
      description: "Hi",
    });
    expect(prepared.fileCount).toBe(3);
    expect(prepared.unpackedSize).toBe(
      [...pkgFiles({ "sub/a.typ": "x" }).values()].reduce(
        (n, b) => n + b.length,
        0,
      ),
    );
    expect([...unpack(prepared.archive).keys()].sort()).toEqual([
      "lib.typ",
      "sub/a.typ",
      "typst.toml",
    ]);
  });

  it("gives the same archive for the same package however it arrives", async () => {
    const files = pkgFiles({ "a/b.typ": "1" });
    const fromTgz = await preparePackage({
      kind: "archive",
      file: tgz(prefixed(files, "wrapper/")),
    });
    const fromZip = await preparePackage({
      kind: "zip",
      file: zip(prefixed(files, "wrapper/")),
    });
    const fromFolder = await preparePackage({
      kind: "source",
      source: source(files),
    });
    expect(fromZip.archive).toEqual(fromTgz.archive);
    expect(fromFolder.archive).toEqual(fromTgz.archive);
  });

  it("reads a zip with a wrapper folder and drops junk", async () => {
    const files = new Map([
      ...prefixed(pkgFiles(), "hello/"),
      ["__MACOSX/hello/._lib.typ", enc.encode("x")],
      ["hello/.DS_Store", enc.encode("x")],
    ]);
    const prepared = await preparePackage({ kind: "zip", file: zip(files) });
    expect(prepared.fileCount).toBe(2);
  });

  it("reads a picked folder with its own name as wrapper", async () => {
    const prepared = await preparePackage({
      kind: "source",
      source: source(prefixed(pkgFiles(), "my-folder/"), ["bad/CON"]),
    });
    expect(prepared.manifest.name).toBe("hello");
    expect(prepared.skipped).toEqual(["bad/CON"]);
  });

  it("drops macOS resource fork files from tarballs", async () => {
    const files = new Map([
      ...prefixed(pkgFiles(), "hello/"),
      ["._hello", enc.encode("x")],
      ["hello/._lib.typ", enc.encode("x")],
    ]);
    const prepared = await preparePackage({
      kind: "archive",
      file: tgz(files),
    });
    expect([...unpack(prepared.archive).keys()].sort()).toEqual([
      "lib.typ",
      "typst.toml",
    ]);
  });

  it("keeps universe bytes as they were", async () => {
    const bytes = gzipDeterministic(writeTar(pkgFiles()));
    // Compared by identity: a repack would be a new array.
    const original = new Uint8Array(bytes);
    const prepared = await preparePackage({
      kind: "universe",
      name: "hello",
      version: "0.1.0",
      bytes: original,
    });
    expect(prepared.archive).toBe(original);
    expect(prepared.fileCount).toBe(2);
  });

  it("rejects a universe package that is not the one asked for", async () => {
    const bytes = gzipDeterministic(writeTar(pkgFiles()));
    await expect(
      preparePackage({
        kind: "universe",
        name: "hello",
        version: "0.2.0",
        bytes,
      }),
    ).rejects.toThrow(/instead of hello:0.2.0/);
    await expect(
      preparePackage({
        kind: "universe",
        name: "other",
        version: "0.1.0",
        bytes,
      }),
    ).rejects.toThrow(/instead of other:0.1.0/);
  });

  it("rejects a universe package with a wrapper folder", async () => {
    const bytes = gzipDeterministic(writeTar(prefixed(pkgFiles(), "w/")));
    await expect(
      preparePackage({
        kind: "universe",
        name: "hello",
        version: "0.1.0",
        bytes,
      }),
    ).rejects.toThrow(/no typst.toml at its top/);
  });

  it("requires typst.toml", async () => {
    const files = new Map([["lib.typ", enc.encode("x")]]);
    await expect(
      preparePackage({ kind: "archive", file: tgz(files) }),
    ).rejects.toThrow(
      "No typst.toml at the top of the package or inside a single folder.",
    );
  });

  it("requires the entrypoint", async () => {
    const files = pkgFiles();
    files.delete("lib.typ");
    await expect(
      preparePackage({ kind: "source", source: source(files) }),
    ).rejects.toThrow("The entrypoint lib.typ is not in the package.");
  });

  it("reports an invalid manifest", async () => {
    const files = pkgFiles({}, MANIFEST.replace("0.1.0", "1"));
    await expect(
      preparePackage({ kind: "source", source: source(files) }),
    ).rejects.toThrow(/not a valid version/);
  });

  it("rejects text that is not a tar.gz", async () => {
    await expect(
      preparePackage({
        kind: "archive",
        file: new File([enc.encode("nope")], "x.tar.gz"),
      }),
    ).rejects.toThrow(PackageError);
  });

  it("rejects a zip that is not a zip", async () => {
    await expect(
      preparePackage({
        kind: "zip",
        file: new File([enc.encode("nope")], "x.zip"),
      }),
    ).rejects.toThrow(/not a valid zip/);
  });

  it("stops a gzip bomb", async () => {
    // Plain zeros: enough to pass the cap whatever the tar says.
    const { gzipSync } = await import("fflate");
    const bomb = gzipSync(new Uint8Array(110 * 1024 * 1024), { level: 1 });
    await expect(
      preparePackage({
        kind: "archive",
        file: new File([bomb as Uint8Array<ArrayBuffer>], "bomb.tar.gz"),
      }),
    ).rejects.toThrow(/unpacks to more than/);
  });

  it("rejects an archive over the size limit before reading it", async () => {
    const file = new File([], "big.tar.gz");
    Object.defineProperty(file, "size", {
      value: MAX_PACKAGE_ARCHIVE_BYTES + 1,
    });
    await expect(preparePackage({ kind: "archive", file })).rejects.toThrow(
      /larger than/,
    );
    const zipFile = new File([], "big.zip");
    Object.defineProperty(zipFile, "size", {
      value: MAX_PACKAGE_ARCHIVE_BYTES + 1,
    });
    await expect(
      preparePackage({ kind: "zip", file: zipFile }),
    ).rejects.toThrow(/larger than/);
  });

  it("rejects too many files", async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < MAX_PACKAGE_FILES; i++) extra[`f${i}.txt`] = "";
    await expect(
      preparePackage({ kind: "source", source: source(pkgFiles(extra)) }),
    ).rejects.toThrow(/more than 2000 files/);
  });

  it("rejects a package that unpacks past the limit", async () => {
    const files = pkgFiles();
    files.set("big.bin", new Uint8Array(101 * 1024 * 1024));
    await expect(
      preparePackage({ kind: "source", source: source(files) }),
    ).rejects.toThrow(/unpacks to more than 100 MB/);
  });

  it("warns when the package needs a newer compiler", async () => {
    const newer = await preparePackage({
      kind: "source",
      source: source(pkgFiles({}, `${MANIFEST}compiler = "0.16.0"\n`)),
    });
    expect(newer.warnings).toEqual([expect.stringContaining("0.16.0")]);
    for (const compiler of ["0.15.0", "0.15", "0.12.0"]) {
      const ok = await preparePackage({
        kind: "source",
        source: source(pkgFiles({}, `${MANIFEST}compiler = "${compiler}"\n`)),
      });
      expect(ok.warnings, compiler).toEqual([]);
    }
  });

  it("lists the preview packages it imports, not itself", async () => {
    const prepared = await preparePackage({
      kind: "source",
      source: source(
        pkgFiles({
          "a.typ":
            '#import "@preview/cetz:0.4.2"\n#import "@preview/hello:0.1.0"',
          "notes.txt": '#import "@preview/ignored:1.0.0"',
        }),
      ),
    });
    expect(prepared.dependencies).toEqual(["@preview/cetz:0.4.2"]);
  });

  it("refuses archives with links or traversal", async () => {
    // Built by hand: writeTar will not write what it would later refuse.
    const tar = writeTar(pkgFiles());
    const evil = new Uint8Array(tar);
    evil[156] = "2".charCodeAt(0);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : evil[i]!;
    evil.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    const file = new File(
      [gzipDeterministic(evil) as Uint8Array<ArrayBuffer>],
      "e.tar.gz",
    );
    await expect(preparePackage({ kind: "archive", file })).rejects.toThrow(
      /is a link/,
    );
  });

  it("keeps binary files byte for byte", async () => {
    const files = pkgFiles();
    files.set("img.png", new Uint8Array([0xff, 0xfe, 0x00]));
    const prepared = await preparePackage({
      kind: "source",
      source: source(files),
    });
    expect(unpack(prepared.archive).get("img.png")).toEqual(
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
  });
});
