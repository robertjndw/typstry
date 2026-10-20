// @vitest-environment node
import { createFile } from "@/doc/fs-ops";
import { NODE, initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { buildSfnt } from "./font-fixtures";
import { FontParseError, WoffError } from "./font-info";
import {
  ensureFontsDir,
  partitionFontFiles,
  validateFontFile,
} from "./upload-fonts";

function setup() {
  return initProject(newProject(1), { title: "T" });
}

function file(name: string, bytes: Uint8Array | string = "x") {
  return new File([bytes as BlobPart], name);
}

describe("ensureFontsDir", () => {
  it("creates the folder once", () => {
    const project = setup();
    const id = ensureFontsDir(project);
    expect(project.fs.getNodeByID(id)!.data.get(NODE.kind)).toBe("dir");
    expect(ensureFontsDir(project)).toBe(id);
  });

  it("picks a free name when a file called fonts exists", () => {
    const project = setup();
    createFile(project, null, "fonts", "text");
    const id = ensureFontsDir(project);
    expect(project.fs.getNodeByID(id)!.data.get(NODE.name)).toBe("fonts (2)");
    expect(project.fs.getNodeByID(id)!.data.get(NODE.kind)).toBe("dir");
  });
});

describe("partitionFontFiles", () => {
  it("separates compiler fonts, web fonts and the rest", () => {
    const files = ["a.ttf", "b.OTF", "c.ttc", "d.woff", "e.woff2", "f.png"].map(
      (name) => file(name),
    );
    const { ok, woff, other } = partitionFontFiles(files);
    expect(ok.map((f) => f.name)).toEqual(["a.ttf", "b.OTF", "c.ttc"]);
    expect(woff.map((f) => f.name)).toEqual(["d.woff", "e.woff2"]);
    expect(other.map((f) => f.name)).toEqual(["f.png"]);
  });
});

describe("validateFontFile", () => {
  const font = buildSfnt({
    names: [{ id: 1, text: "Upload Sans" }],
    os2: { weight: 400, width: 5, selection: 0 },
  });

  it("returns the faces of a good font", async () => {
    const faces = await validateFontFile(file("u.ttf", font));
    expect(faces[0]!.typstFamily).toBe("Upload Sans");
  });

  it("rejects corrupt and web fonts", async () => {
    await expect(
      validateFontFile(file("u.ttf", font.subarray(0, 30))),
    ).rejects.toBeInstanceOf(FontParseError);
    const woff = new Uint8Array(32);
    woff.set([0x77, 0x4f, 0x46, 0x32]);
    await expect(validateFontFile(file("u.ttf", woff))).rejects.toBeInstanceOf(
      WoffError,
    );
  });
});
