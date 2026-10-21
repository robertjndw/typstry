// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { ProjectAssets } from "@/assets/project-assets";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { addPackage, findConflict } from "./add";
import type { PreparedPackage } from "./normalize";
import { readPackages } from "./records";

function fakeAssets() {
  const files: File[] = [];
  const assets: ProjectAssets = {
    load: async () => new Uint8Array(),
    store: vi.fn(async (file: File) => {
      files.push(file);
      return { hash: "sha256:abc", size: file.size, mime: "application/gzip" };
    }),
  };
  return { assets, files };
}

function prepared(
  overrides: Partial<PreparedPackage["manifest"]> = {},
): PreparedPackage {
  return {
    manifest: {
      name: "hello",
      version: "0.1.0",
      entrypoint: "lib.typ",
      ...overrides,
    },
    archive: new Uint8Array([1, 2, 3, 4]),
    fileCount: 2,
    unpackedSize: 40,
    skipped: [],
    warnings: [],
    dependencies: [],
  };
}

function setup() {
  return initProject(newProject(1), { title: "T" });
}

describe("addPackage", () => {
  it("uploads the archive, then records the package", async () => {
    const project = setup();
    const { assets, files } = fakeAssets();
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const record = await addPackage(
      project,
      assets,
      prepared({
        description: "Hi",
        authors: ["A"],
        license: "MIT",
        compiler: "0.12.0",
      }),
      { namespace: "local", source: "upload" },
    );
    expect(files[0]!.name).toBe("hello-0.1.0.tar.gz");
    expect(files[0]!.type).toBe("application/gzip");
    expect(record).toEqual({
      namespace: "local",
      name: "hello",
      version: "0.1.0",
      hash: "sha256:abc",
      size: 4,
      mime: "application/gzip",
      entrypoint: "lib.typ",
      description: "Hi",
      authors: ["A"],
      license: "MIT",
      compiler: "0.12.0",
      fileCount: 2,
      unpackedSize: 40,
      source: "upload",
      addedAt: 1234,
    });
    expect(readPackages(project).get("local/hello/0.1.0")).toEqual(record);
    vi.restoreAllMocks();
  });

  it("omits optional fields the manifest lacks", async () => {
    const project = setup();
    const record = await addPackage(project, fakeAssets().assets, prepared(), {
      namespace: "preview",
      source: "universe",
    });
    expect(Object.keys(record)).not.toContain("description");
    expect(Object.keys(record)).not.toContain("authors");
  });

  it("leaves the doc alone when the upload fails", async () => {
    const project = setup();
    const assets: ProjectAssets = {
      load: async () => new Uint8Array(),
      store: vi.fn().mockRejectedValue(new Error("offline")),
    };
    await expect(
      addPackage(project, assets, prepared(), {
        namespace: "local",
        source: "upload",
      }),
    ).rejects.toThrow("offline");
    expect(readPackages(project).size).toBe(0);
  });

  it("passes the abort signal on to the upload", async () => {
    const { assets } = fakeAssets();
    const signal = new AbortController().signal;
    await addPackage(setup(), assets, prepared(), {
      namespace: "local",
      source: "upload",
      signal,
    });
    expect(vi.mocked(assets.store).mock.calls[0]![1]).toEqual({ signal });
  });

  it("rejects an invalid namespace before uploading", async () => {
    const { assets } = fakeAssets();
    const project = setup();
    for (const namespace of ["", "1x", "a b", "a/b"]) {
      await expect(
        addPackage(project, assets, prepared(), {
          namespace,
          source: "upload",
        }),
      ).rejects.toThrow(/not a valid namespace/);
    }
    expect(assets.store).not.toHaveBeenCalled();
  });
});

describe("findConflict", () => {
  it("finds an existing package by key", async () => {
    const project = setup();
    expect(findConflict(project, "local/hello/0.1.0")).toBeNull();
    const record = await addPackage(project, fakeAssets().assets, prepared(), {
      namespace: "local",
      source: "upload",
    });
    expect(findConflict(project, "local/hello/0.1.0")).toEqual(record);
    expect(findConflict(project, "local/hello/0.2.0")).toBeNull();
  });
});
