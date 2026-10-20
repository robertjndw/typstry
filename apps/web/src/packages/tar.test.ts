// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PackageError } from "./errors";
import { normalizeArchivePath, readTar, writeTar } from "./tar";

const enc = new TextEncoder();

function files(entries: Record<string, string | Uint8Array>) {
  return new Map(
    Object.entries(entries).map(([k, v]) => [
      k,
      typeof v === "string" ? enc.encode(v) : v,
    ]),
  );
}

function text(map: Map<string, Uint8Array>) {
  return Object.fromEntries(
    [...map].map(([k, v]) => [k, new TextDecoder().decode(v)]),
  );
}

/** Hand-built entries, for archives writeTar would never produce. */
function raw(opts: {
  name: string;
  type?: string;
  data?: Uint8Array;
  prefix?: string;
  badChecksum?: boolean;
}): Uint8Array {
  const data = opts.data ?? new Uint8Array();
  const block = new Uint8Array(512);
  block.set(enc.encode(opts.name), 0);
  block.set(enc.encode("0000644\0"), 100);
  block.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
  block[156] = (opts.type ?? "0").charCodeAt(0);
  block.set(enc.encode("ustar\0" + "00"), 257);
  if (opts.prefix) block.set(enc.encode(opts.prefix), 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  if (opts.badChecksum) sum += 1;
  block.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat(block, padded);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const END = new Uint8Array(1024);

describe("round trip", () => {
  it("writes and reads files, including empty and binary ones", () => {
    const input = files({
      "typst.toml": "[package]\n",
      "lib.typ": "#let x = 1",
      "sub/dir/empty.txt": "",
      "bin.dat": new Uint8Array([0, 1, 2, 255, 254]),
      "big.txt": "x".repeat(5000),
    });
    const out = readTar(writeTar(input));
    expect([...out.keys()].sort()).toEqual([...input.keys()].sort());
    for (const [path, bytes] of input) expect(out.get(path)).toEqual(bytes);
  });

  it("handles names up to the ustar limits through prefix and name", () => {
    const dir = "d".repeat(100);
    const path = `${dir}/${"e".repeat(40)}/${"f".repeat(100)}`;
    const out = readTar(writeTar(files({ [path]: "hi" })));
    expect(text(out)).toEqual({ [path]: "hi" });
  });

  it("falls back to PAX for names that cannot be split", () => {
    const path = `${"a".repeat(300)}.typ`;
    const nested = `${"b".repeat(120)}/${"c".repeat(120)}/x.typ`;
    const tar = writeTar(files({ [path]: "1", [nested]: "2" }));
    expect(new TextDecoder().decode(tar)).toContain("path=");
    expect(text(readTar(tar))).toEqual({ [path]: "1", [nested]: "2" });
  });

  it("keeps non-ASCII names intact", () => {
    const input = files({
      "größe/日本語.typ": "x",
      [`${"é".repeat(80)}.typ`]: "y",
    });
    expect(text(readTar(writeTar(input)))).toEqual(text(input));
  });

  it("is deterministic and independent of insertion order", () => {
    const a = writeTar(files({ "b.typ": "2", "a.typ": "1", "c/d.typ": "3" }));
    const b = writeTar(files({ "c/d.typ": "3", "a.typ": "1", "b.typ": "2" }));
    expect(a).toEqual(b);
    expect(a.length % 512).toBe(0);
    expect(a.slice(-1024)).toEqual(END);
  });

  it("writes the fixed header fields", () => {
    const tar = writeTar(files({ "a.txt": "hi" }));
    const field = (start: number, len: number) =>
      new TextDecoder().decode(tar.subarray(start, start + len));
    expect(field(100, 8)).toBe("0000644\0");
    expect(field(136, 12)).toBe("00000000000\0");
    expect(field(257, 6)).toBe("ustar\0");
  });

  it("refuses to write unsafe paths", () => {
    expect(() => writeTar(files({ "../x": "" }))).toThrow(PackageError);
    expect(() => writeTar(files({ "/x": "" }))).toThrow(PackageError);
  });
});

describe("readTar formats", () => {
  it("strips a leading ./ and skips folders", () => {
    const tar = concat(
      raw({ name: "./", type: "5" }),
      raw({ name: "./pkg/", type: "5" }),
      raw({ name: "./pkg/a.typ", data: enc.encode("a") }),
      END,
    );
    expect(text(readTar(tar))).toEqual({ "pkg/a.typ": "a" });
  });

  it("reads a PAX path and ignores global headers", () => {
    const record = "20 path=real/name.typ\n";
    expect(record.length).toBe(22);
    const pax = `${record.length} path=real/name.typ\n`;
    const tar = concat(
      raw({ name: "g", type: "g", data: enc.encode("18 comment=hello\n") }),
      raw({ name: "PaxHeaders/x", type: "x", data: enc.encode(pax) }),
      raw({ name: "short", data: enc.encode("1") }),
      raw({ name: "next", data: enc.encode("2") }),
      END,
    );
    expect(text(readTar(tar))).toEqual({ "real/name.typ": "1", next: "2" });
  });

  it("reads a GNU long name", () => {
    const long = `${"x".repeat(150)}/file.typ`;
    const tar = concat(
      raw({ name: "././@LongLink", type: "L", data: enc.encode(long + "\0") }),
      raw({ name: "truncated", data: enc.encode("z") }),
      END,
    );
    expect(text(readTar(tar))).toEqual({ [long]: "z" });
  });

  it("joins the ustar prefix", () => {
    const tar = concat(raw({ name: "f.typ", prefix: "dir/sub" }), END);
    expect([...readTar(tar).keys()]).toEqual(["dir/sub/f.typ"]);
  });

  it("accepts an archive without the end marker", () => {
    expect(readTar(raw({ name: "a", data: enc.encode("1") })).size).toBe(1);
  });
});

describe("readTar rejections", () => {
  it.each([
    ["a symlink", "2"],
    ["a hard link", "1"],
    ["a device", "3"],
    ["a fifo", "6"],
  ])("rejects %s", (_label, type) => {
    expect(() => readTar(concat(raw({ name: "x", type }), END))).toThrow(
      PackageError,
    );
  });

  it("names the link in the message", () => {
    expect(() => readTar(concat(raw({ name: "ln", type: "2" }), END))).toThrow(
      /ln is a link/,
    );
  });

  it.each(["/etc/passwd", "../x", "a/../../x", "a/..", "a\\b"])(
    "rejects the path %s",
    (name) => {
      expect(() => readTar(concat(raw({ name }), END))).toThrow(/unsafe path/);
    },
  );

  it("rejects an unsafe PAX path", () => {
    const pax = "19 path=../escape\n";
    const tar = concat(
      raw({ name: "p", type: "x", data: enc.encode(pax) }),
      raw({ name: "ok" }),
      END,
    );
    expect(() => readTar(tar)).toThrow(/unsafe path/);
  });

  it("rejects a bad checksum", () => {
    expect(() =>
      readTar(concat(raw({ name: "a", badChecksum: true }), END)),
    ).toThrow(/checksum/);
  });

  it("rejects a truncated archive", () => {
    const tar = raw({ name: "a", data: new Uint8Array(2000) });
    expect(() => readTar(tar.subarray(0, 1000))).toThrow(/cut off/);
  });

  it("rejects garbage", () => {
    expect(() => readTar(enc.encode("hello ".repeat(200)))).toThrow(
      PackageError,
    );
  });

  it("enforces the entry and size limits", () => {
    const many = writeTar(files({ a: "1", b: "2", c: "3" }));
    expect(() => readTar(many, { maxEntries: 2 })).toThrow(/more than 2 files/);
    const big = writeTar(files({ a: "x".repeat(100), b: "x".repeat(100) }));
    expect(() => readTar(big, { maxTotalBytes: 150 })).toThrow(/size limit/);
    expect(readTar(big, { maxTotalBytes: 200 }).size).toBe(2);
  });
});

describe("normalizeArchivePath", () => {
  it("cleans and judges paths", () => {
    expect(normalizeArchivePath("./a//b/./c")).toBe("a/b/c");
    expect(normalizeArchivePath("./")).toBe("");
    expect(normalizeArchivePath("a/../b")).toBeNull();
    expect(normalizeArchivePath("/a")).toBeNull();
    expect(normalizeArchivePath("a\0b")).toBeNull();
  });
});
