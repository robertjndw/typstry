// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { createAsset, createFile, deleteNode } from "@/doc/fs-ops";
import { versionAt } from "@/doc/restore";
import { initProject } from "@/doc/schema";
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
    const files = unzipSync(await exportZip(project(), load));

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
      await exportZip(versionAt(p, before), async () => PNG),
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
});
