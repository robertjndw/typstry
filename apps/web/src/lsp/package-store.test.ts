import { describe, expect, it, vi } from "vitest";

import { gzipDeterministic } from "@/packages/gzip";
import { packageKey } from "@/packages/spec";
import { writeTar } from "@/packages/tar";

import {
  binaryStringToBytes,
  PACKAGE_ROOT,
  PackageStore,
} from "./package-store";

const enc = new TextEncoder();
const dec = new TextDecoder();

function archive(files: Record<string, string>): Uint8Array {
  return gzipDeterministic(
    writeTar(
      new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])),
    ),
  );
}

const spec = { namespace: "local", name: "demo", version: "1.0.0" };
const key = packageKey(spec);
const uri = (path: string) => `file://${path}`;

describe("PackageStore", () => {
  it("unpacks a project package and serves its files by URI", () => {
    const store = new PackageStore();
    store.set(
      key,
      "abcdef0123456789",
      archive({ "typst.toml": "x", "lib/a.typ": "A" }),
    );
    const dir = store.resolve(spec);
    expect(dir).toBe(`${PACKAGE_ROOT}/local/demo/1.0.0-abcdef012345`);
    expect(dec.decode(store.file(uri(`${dir}/lib/a.typ`)))).toBe("A");
    expect(store.file(uri(`${dir}/missing.typ`))).toBeUndefined();
  });

  it("matches escaped URIs against the unpacked path", () => {
    const store = new PackageStore();
    store.set(key, "h", archive({ "my file.typ": "A" }));
    const dir = store.resolve(spec);
    expect(store.file(uri(`${dir}/my%20file.typ`))).toBeDefined();
  });

  it("gives replaced contents a new path and drops the old files", () => {
    const store = new PackageStore();
    store.set(key, "aaaaaaaaaaaaaaaa", archive({ "a.typ": "1" }));
    const first = store.resolve(spec)!;
    store.set(key, "bbbbbbbbbbbbbbbb", archive({ "a.typ": "2" }));
    const second = store.resolve(spec)!;
    expect(second).not.toBe(first);
    expect(store.file(uri(`${first}/a.typ`))).toBeUndefined();
    expect(dec.decode(store.file(uri(`${second}/a.typ`)))).toBe("2");
  });

  it("forgets a removed package", () => {
    const store = new PackageStore();
    store.set(key, "h", archive({ "a.typ": "1" }));
    const dir = store.resolve(spec)!;
    store.remove(key);
    expect(store.resolve(spec)).toBeUndefined();
    expect(store.file(uri(`${dir}/a.typ`))).toBeUndefined();
  });

  it("fetches preview packages once and leaves other namespaces alone", () => {
    const fetchArchive = vi.fn(() => archive({ "typst.toml": "t" }));
    const store = new PackageStore(fetchArchive);
    const preview = { namespace: "preview", name: "cetz", version: "0.4.2" };
    const dir = store.resolve(preview);
    expect(dir).toBe(`${PACKAGE_ROOT}/preview/cetz/0.4.2`);
    store.resolve(preview);
    expect(fetchArchive).toHaveBeenCalledTimes(1);
    expect(store.file(uri(`${dir}/typst.toml`))).toBeDefined();
    expect(store.resolve({ ...preview, namespace: "other" })).toBeUndefined();
    expect(fetchArchive).toHaveBeenCalledTimes(1);
  });

  it("prefers a project package over the registry", () => {
    const fetchArchive = vi.fn(() => archive({ "a.typ": "remote" }));
    const store = new PackageStore(fetchArchive);
    const preview = { namespace: "preview", name: "cetz", version: "0.4.2" };
    store.set(
      packageKey(preview),
      "hhhhhhhhhhhhhhhh",
      archive({ "a.typ": "mine" }),
    );
    const dir = store.resolve(preview)!;
    expect(fetchArchive).not.toHaveBeenCalled();
    expect(dec.decode(store.file(uri(`${dir}/a.typ`)))).toBe("mine");
  });

  it("does not retry a failed fetch or a corrupt archive", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchArchive = vi.fn((): Uint8Array | undefined => undefined);
    const store = new PackageStore(fetchArchive);
    const preview = { namespace: "preview", name: "cetz", version: "0.4.2" };
    expect(store.resolve(preview)).toBeUndefined();
    expect(store.resolve(preview)).toBeUndefined();
    expect(fetchArchive).toHaveBeenCalledTimes(1);

    store.set(key, "h", gzipDeterministic(new Uint8Array(600).fill(7)));
    expect(store.resolve(spec)).toBeUndefined();
    // A new upload under the same key is tried again.
    store.set(key, "h2", archive({ "a.typ": "1" }));
    expect(store.resolve(spec)).toBeDefined();
  });

  it("converts x-user-defined text to bytes", () => {
    expect(binaryStringToBytes("A")).toEqual(
      new Uint8Array([0x80, 0x41, 0xff]),
    );
  });
});
