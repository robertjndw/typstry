import type {
  PackageRegistry,
  PackageResolveContext,
  PackageSpec,
} from "@myriaddreamin/typst.ts/internal.types";

import { gunzipLimited, gzipDeterministic } from "@/packages/gzip";
import { readTar, writeTar } from "@/packages/tar";

import { ProjectPackageRegistry } from "./package-registry";

const encoder = new TextEncoder();

class FakeAccessModel {
  files = new Map<string, Uint8Array>();
  insertFile(path: string, data: Uint8Array) {
    this.files.set(path, data);
  }
  removeFile(path: string) {
    this.files.delete(path);
  }
  isFile() {
    return true;
  }
  getMTime() {
    return undefined;
  }
  getRealPath(path: string) {
    return path;
  }
  readAll(path: string) {
    return this.files.get(path);
  }
}

const ctx: PackageResolveContext = {
  untar(data, cb) {
    const tar = gunzipLimited(data, 1 << 20);
    for (const [path, bytes] of readTar(tar)) cb(path, bytes, 0);
  },
};

function archive(files: Record<string, string>): Uint8Array {
  return gzipDeterministic(
    writeTar(
      new Map(Object.entries(files).map(([k, v]) => [k, encoder.encode(v)])),
    ),
  );
}

const spec = (name = "hello", version = "0.1.0"): PackageSpec => ({
  namespace: "local",
  name,
  version,
});

function setup() {
  const am = new FakeAccessModel();
  const resolved: PackageSpec[] = [];
  const fallback: PackageRegistry = {
    resolve(s) {
      resolved.push(s);
      return "/fallback";
    },
  };
  const registry = new ProjectPackageRegistry(am, fallback);
  return { am, registry, resolved };
}

const text = (am: FakeAccessModel, path: string) =>
  new TextDecoder().decode(am.files.get(path));

describe("ProjectPackageRegistry", () => {
  it("unpacks a package on first use into a hash-named directory", () => {
    const { am, registry } = setup();
    registry.set(
      "local/hello/0.1.0",
      "a".repeat(64),
      archive({
        "typst.toml": "[package]",
        "src/lib.typ": "#let hello = [Hi]",
      }),
    );
    expect(am.files.size).toBe(0);
    const dir = registry.resolve(spec(), ctx);
    expect(dir).toBe(
      `/@memory/project-packages/local/hello/0.1.0/${"a".repeat(16)}`,
    );
    expect(text(am, `${dir}/src/lib.typ`)).toBe("#let hello = [Hi]");
    expect(registry.resolve(spec(), ctx)).toBe(dir);
  });

  it("falls back for packages the project does not have", () => {
    const { registry, resolved } = setup();
    registry.set("local/hello/0.1.0", "a".repeat(64), archive({ a: "x" }));
    expect(registry.resolve(spec("other"), ctx)).toBe("/fallback");
    expect(resolved).toEqual([spec("other")]);
  });

  it("lets a pinned @preview package win over the fallback", () => {
    const { registry, resolved } = setup();
    registry.set("preview/cetz/0.3.4", "b".repeat(64), archive({ a: "x" }));
    const dir = registry.resolve(
      { namespace: "preview", name: "cetz", version: "0.3.4" },
      ctx,
    );
    expect(dir).toContain("/preview/cetz/0.3.4/");
    expect(resolved).toEqual([]);
  });

  it("puts a replacement in a new directory and removes the old files", () => {
    const { am, registry } = setup();
    registry.set("local/hello/0.1.0", "a".repeat(64), archive({ f: "one" }));
    const first = registry.resolve(spec(), ctx)!;
    registry.set("local/hello/0.1.0", "c".repeat(64), archive({ f: "two" }));
    expect(am.files.has(`${first}/f`)).toBe(false);
    const second = registry.resolve(spec(), ctx)!;
    expect(second).not.toBe(first);
    expect(text(am, `${second}/f`)).toBe("two");
  });

  it("removes every file when the package goes away", () => {
    const { am, registry, resolved } = setup();
    registry.set("local/hello/0.1.0", "a".repeat(64), archive({ f: "one" }));
    registry.resolve(spec(), ctx);
    registry.remove("local/hello/0.1.0");
    expect(am.files.size).toBe(0);
    expect(registry.resolve(spec(), ctx)).toBe("/fallback");
    expect(resolved).toHaveLength(1);
  });

  it("skips entries that would leave the package directory", () => {
    const { am, registry } = setup();
    registry.set("local/hello/0.1.0", "a".repeat(64), archive({ ok: "1" }));
    const hostile: PackageResolveContext = {
      untar(_data, cb) {
        cb("../evil", encoder.encode("x"), 0);
        cb("/abs", encoder.encode("x"), 0);
        cb("./fine.typ", encoder.encode("y"), 0);
      },
    };
    const dir = registry.resolve(spec(), hostile)!;
    expect([...am.files.keys()]).toEqual([`${dir}/fine.typ`]);
  });

  it("frees the archive after unpacking and retries a failed unpack", () => {
    const { am, registry } = setup();
    const broken: PackageResolveContext = {
      untar(_data, cb) {
        cb("half", encoder.encode("x"), 0);
        throw new Error("corrupt");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registry.set("local/hello/0.1.0", "a".repeat(64), archive({ f: "one" }));
    expect(registry.resolve(spec(), broken)).toBeUndefined();
    expect(am.files.size).toBe(0);
    error.mockRestore();
    // The bytes were kept, so a working unpack still succeeds.
    expect(registry.resolve(spec(), ctx)).toBeDefined();
    const entry = (
      registry as unknown as {
        entries: Map<string, { archive: Uint8Array | null }>;
      }
    ).entries.get("local/hello/0.1.0");
    expect(entry?.archive).toBeNull();
  });
});
