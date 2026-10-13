// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { createAsset, createFile, deleteNode } from "@/doc/fs-ops";
import { versionAt } from "@/doc/restore";
import { initProject, NODE, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

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
