// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { createAsset, createFile, deleteNode } from "@/doc/fs-ops";
import { versionAt } from "@/doc/restore";
import { initProject, NODE, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { gzipDeterministic } from "@/packages/gzip";
import { putPackage } from "@/packages/records";
import { writeTar } from "@/packages/tar";

import { ExportError, exportZip } from "./zip";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function project() {
  const p = initProject(newProject(1), { title: "Thesis" });
  const figures = createFile(p, null, "figures", "dir");
  createAsset(p, figures, "logo.png", {
    hash: "sha256:logo",
    size: PNG.length,
    mime: "image/png",
  });
  createFile(p, null, "refs.bib", "text", "@book{a}\n");
  createFile(p, null, "empty", "dir");
  return p;
}

describe("exportZip", () => {
  it("packs text files, assets and empty folders by path", async () => {
    const load = vi.fn(async () => PNG);
    const { zip, skipped } = await exportZip(project(), load);
    const files = unzipSync(zip);
    expect(skipped).toEqual([]);

    expect(Object.keys(files).sort()).toEqual([
      "empty/",
      "figures/logo.png",
      "main.typ",
      "refs.bib",
    ]);
    expect(strFromU8(files["main.typ"]!)).toContain("= Thesis");
    expect(strFromU8(files["refs.bib"]!)).toBe("@book{a}\n");
    expect(files["figures/logo.png"]).toEqual(PNG);
    expect(load).toHaveBeenCalledWith("sha256:logo");
  });

  it("exports an old version, not the live state", async () => {
    const p = project();
    const before = p.doc.oplogFrontiers();
    deleteNode(p, p.mainFile!);
    createFile(p, null, "later.typ", "text", "new");

    const files = unzipSync(
      (await exportZip(versionAt(p, before), async () => PNG)).zip,
    );
    expect(files["main.typ"]).toBeDefined();
    expect(files["later.typ"]).toBeUndefined();
  });

  it("fails naming every asset that could not be loaded", async () => {
    const p = project();
    createAsset(p, null, "font.otf", {
      hash: "sha256:font",
      size: 1,
      mime: "font/otf",
    });

    const err = await exportZip(p, async () => {
      throw new Error("offline");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).paths).toEqual([
      "figures/logo.png",
      "font.otf",
    ]);

    await expect(exportZip(p, null)).rejects.toBeInstanceOf(ExportError);
  });

  it("leaves out paths that are unsafe to unpack", async () => {
    const p = project();
    // What a modified client can write: names the app itself refuses.
    const plant = (name: string, kind: "text" | "dir", parent = null) => {
      const id = createFile(p, parent, "x", kind, "");
      rawRename(p, id, name);
      return id;
    };
    const git = plant(".GIT", "dir");
    createFile(p, git, "config", "text", "[core]\n");
    plant("nul.typ", "text");
    plant("..\\..\\evil.typ", "text");

    const { zip, skipped } = await exportZip(p, async () => PNG);
    expect(skipped).toEqual([
      "..\\..\\evil.typ",
      ".GIT",
      ".GIT/config",
      "nul.typ",
    ]);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([
      "empty/",
      "figures/logo.png",
      "main.typ",
      "refs.bib",
    ]);
  });
});

function rawRename(
  p: ProjectDoc,
  id: ReturnType<typeof createFile>,
  name: string,
) {
  p.fs.getNodeByID(id)!.data.set(NODE.name, name);
  p.doc.commit();
}

describe("exportZip asset loads", () => {
  it("loads at most four assets at a time", async () => {
    const p = initProject(newProject(1), { title: "Many" });
    for (let i = 0; i < 10; i++) {
      createAsset(p, null, `${i}.png`, {
        hash: `sha256:${i}`,
        size: PNG.length,
        mime: "image/png",
      });
    }
    let inFlight = 0;
    let peak = 0;
    const load = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return PNG.slice();
    };
    const { zip } = await exportZip(p, load);
    expect(Object.keys(unzipSync(zip))).toHaveLength(11);
    expect(peak).toBe(4);
  });
});

function archive(files: Record<string, string>) {
  const enc = new TextEncoder();
  return gzipDeterministic(
    writeTar(
      new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])),
    ),
  );
}

function addPackage(
  p: ProjectDoc,
  name: string,
  hash: string,
  version = "0.1.0",
) {
  putPackage(p, {
    namespace: "local",
    name,
    version,
    hash,
    size: 1,
    mime: "application/gzip",
    entrypoint: "lib.typ",
    fileCount: 1,
    unpackedSize: 1,
    source: "upload",
    addedAt: 1,
  });
}

describe("exportZip packages", () => {
  const bytes: Record<string, Uint8Array> = {
    "sha256:hello": archive({
      "typst.toml": "[package]\n",
      "lib.typ": "#let hi = 1",
      "src/util.typ": "x",
    }),
    "sha256:other": archive({ "lib.typ": "y" }),
  };
  const load = async (hash: string) => (bytes[hash] ?? PNG).slice();

  it("unpacks packages under typst-packages and leaves other files alone", async () => {
    const p = project();
    addPackage(p, "hello", "sha256:hello");
    addPackage(p, "other", "sha256:other", "1.2.3");
    const out = await exportZip(p, load);
    const files = unzipSync(out.zip);
    expect(strFromU8(files["typst-packages/local/hello/0.1.0/lib.typ"]!)).toBe(
      "#let hi = 1",
    );
    expect(
      files["typst-packages/local/hello/0.1.0/src/util.typ"],
    ).toBeDefined();
    expect(files["typst-packages/local/other/1.2.3/lib.typ"]).toBeDefined();
    expect(files["main.typ"]).toBeDefined();
    expect(out.packages).toBe(2);
    expect(out.packagesLeftOut).toEqual([]);
  });

  it("adds no folder when the project has no packages", async () => {
    const files = unzipSync((await exportZip(project(), load)).zip);
    expect(Object.keys(files).some((f) => f.startsWith("typst-packages"))).toBe(
      false,
    );
  });

  it("fails naming a package that could not be loaded", async () => {
    const p = project();
    addPackage(p, "hello", "sha256:missing");
    await expect(
      exportZip(p, async (h) => {
        if (h === "sha256:missing") throw new Error("gone");
        return PNG.slice();
      }),
    ).rejects.toMatchObject({ paths: ["@local/hello:0.1.0"] });
  });

  it("fails when packages exist but there is no way to load them", async () => {
    const p = initProject(newProject(1), { title: "P" });
    addPackage(p, "hello", "sha256:hello");
    await expect(exportZip(p, null)).rejects.toBeInstanceOf(ExportError);
  });

  it("fails the export for an archive that is not gzip", async () => {
    const p = initProject(newProject(1), { title: "Junk" });
    addPackage(p, "hello", "sha256:junk");
    await expect(
      exportZip(p, async () => new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow();
  });

  it("keeps a project's own file and drops the package that would clash", async () => {
    const p = project();
    createFile(p, null, "typst-packages", "text", "mine");
    addPackage(p, "hello", "sha256:hello");
    const out = await exportZip(p, load);
    const files = unzipSync(out.zip);
    expect(strFromU8(files["typst-packages"]!)).toBe("mine");
    expect(Object.keys(files).filter((f) => f.includes("/"))).not.toContain(
      "typst-packages/local/hello/0.1.0/lib.typ",
    );
    expect(out.packages).toBe(0);
    expect(out.packagesLeftOut).toEqual(["local/hello/0.1.0"]);
  });

  it("shares an existing typst-packages folder with the packages", async () => {
    const p = project();
    const dir = createFile(p, null, "typst-packages", "dir");
    createFile(p, dir, "notes.txt", "text", "n");
    addPackage(p, "hello", "sha256:hello");
    const files = unzipSync((await exportZip(p, load)).zip);
    expect(files["typst-packages/notes.txt"]).toBeDefined();
    expect(files["typst-packages/local/hello/0.1.0/lib.typ"]).toBeDefined();
  });
});
