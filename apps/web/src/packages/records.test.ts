import { initProject, type PackageRecord } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";

import {
  deletePackage,
  packageKey,
  parsePackageRecord,
  putPackage,
  readFontBundles,
  readPackages,
  setFontBundle,
} from "./records";

function record(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    namespace: "local",
    name: "thesis",
    version: "1.0.0",
    hash: "abc",
    size: 10,
    mime: "application/gzip",
    entrypoint: "lib.typ",
    fileCount: 2,
    unpackedSize: 40,
    source: "upload",
    addedAt: 1700000000000,
    ...overrides,
  };
}

const key = "local/thesis/1.0.0";

describe("parsePackageRecord", () => {
  it("accepts a complete record and drops unknown fields", () => {
    const full = record({
      description: "d",
      authors: ["a"],
      license: "MIT",
      compiler: "0.13.0",
    });
    expect(parsePackageRecord(key, { ...full, extra: 1 })).toEqual(full);
  });

  it("rejects wrong types and non-finite numbers", () => {
    expect(parsePackageRecord(key, null)).toBeNull();
    expect(parsePackageRecord(key, record({ size: NaN }))).toBeNull();
    expect(parsePackageRecord(key, { ...record(), hash: 1 })).toBeNull();
    expect(
      parsePackageRecord(key, { ...record(), source: "elsewhere" }),
    ).toBeNull();
    expect(parsePackageRecord(key, { ...record(), authors: [1] })).toBeNull();
  });

  it("rejects a key that does not match the fields", () => {
    expect(parsePackageRecord("local/thesis/2.0.0", record())).toBeNull();
  });

  it("rejects path-like names and unsafe entrypoints", () => {
    for (const bad of [{ name: "a/b" }, { version: ".." }, { namespace: "" }]) {
      const r = record(bad);
      expect(parsePackageRecord(packageKey(r), r)).toBeNull();
    }
    for (const entrypoint of ["/etc/passwd", "../x.typ", "a/../../x.typ"])
      expect(parsePackageRecord(key, record({ entrypoint }))).toBeNull();
    expect(
      parsePackageRecord(key, record({ entrypoint: "src/lib.typ" })),
    ).not.toBeNull();
  });
});

describe("package storage", () => {
  it("round-trips, sorts and skips malformed entries", () => {
    const project = initProject(newProject(1), { title: "T" });
    putPackage(project, record({ name: "zeta" }));
    putPackage(project, record({ name: "alpha" }));
    project.packages.set("local/bad/1.0.0", { nope: true });
    expect([...readPackages(project).keys()]).toEqual([
      "local/alpha/1.0.0",
      "local/zeta/1.0.0",
    ]);
    deletePackage(project, "local/zeta/1.0.0");
    expect([...readPackages(project).keys()]).toEqual(["local/alpha/1.0.0"]);
  });

  it("replaces a record last writer wins across peers", () => {
    const a = initProject(newProject(1), { title: "T" });
    putPackage(a, record());
    const b = fork(a, 2);
    putPackage(a, record({ hash: "from-a" }));
    putPackage(b, record({ hash: "from-b" }));
    sync(a, b);
    expect(readPackages(a).get(key)?.hash).toBe(readPackages(b).get(key)?.hash);
  });

  it("toggles font bundles independently", () => {
    const project = initProject(newProject(1), { title: "T" });
    expect(readFontBundles(project)).toEqual({ cjk: false, emoji: false });
    setFontBundle(project, "cjk", true);
    expect(readFontBundles(project)).toEqual({ cjk: true, emoji: false });
    setFontBundle(project, "cjk", false);
    setFontBundle(project, "emoji", true);
    expect(readFontBundles(project)).toEqual({ cjk: false, emoji: true });
  });
});
