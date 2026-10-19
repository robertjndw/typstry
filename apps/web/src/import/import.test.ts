// @vitest-environment node
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { createFile } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { fileText } from "@/doc/restore";
import { initProject, NODE } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { exportZip } from "@/export/zip";
import { fakeAssets } from "@/folder/test-utils";

import {
  assertImportable,
  collect,
  ImportError,
  pickMainFile,
  readZip,
  writeImport,
  writeSource,
} from "./import";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function file(path: string, text = "") {
  return { path, bytes: strToU8(text) };
}

describe("collect", () => {
  it("strips a single wrapping folder and names the project after it", () => {
    const source = collect("archive", [
      { path: "thesis/", bytes: null },
      file("thesis/main.typ"),
      file("thesis/chapters/intro.typ"),
    ]);
    expect(source.name).toBe("thesis");
    expect([...source.files.keys()].sort()).toEqual([
      "chapters/intro.typ",
      "main.typ",
    ]);
    expect([...source.dirs]).toEqual(["chapters"]);
  });

  it("keeps the top folder when files sit next to it", () => {
    const source = collect("archive", [
      file("main.typ"),
      file("figures/a.typ"),
    ]);
    expect(source.name).toBe("archive");
    expect(source.files.has("figures/a.typ")).toBe(true);
  });

  it("keeps the wrapping folder with unwrap: false", () => {
    const source = collect(
      "x",
      [file("thesis/main.typ"), file("thesis/figures/a.typ")],
      { unwrap: false },
    );
    expect(source.name).toBe("x");
    expect([...source.files.keys()].sort()).toEqual([
      "thesis/figures/a.typ",
      "thesis/main.typ",
    ]);
    expect([...source.dirs].sort()).toEqual(["thesis", "thesis/figures"]);
  });

  it("skips a reserved top-level folder with unwrap: false", () => {
    const source = collect("x", [file("a:b/main.typ")], { unwrap: false });
    expect(source.files.size).toBe(0);
    expect(source.skipped).toEqual(["a:b/main.typ"]);
  });

  it("drops OS clutter and skips unsafe paths", () => {
    const source = collect("x", [
      file("main.typ"),
      file(".DS_Store"),
      file("__MACOSX/._main.typ"),
      file(".git/config"),
      file("a:b.typ"),
    ]);
    expect([...source.files.keys()]).toEqual(["main.typ"]);
    expect(source.skipped).toEqual([".git/config", "a:b.typ"]);
  });

  it("skips a file that clashes with a folder of the same path", () => {
    const source = collect("x", [file("a"), file("a/b.typ")]);
    expect([...source.files.keys()]).toEqual(["a/b.typ"]);
    expect(source.skipped).toEqual(["a"]);
  });
});

describe("readZip", () => {
  it("leaves clutter and .git out of the limits", async () => {
    const files: Record<string, Uint8Array> = { "p/main.typ": strToU8("x") };
    // Past the entry cap together, but none of it is imported anyway.
    for (let i = 0; i < 6_000; i++) {
      files[`p/__MACOSX/._${i}`] = new Uint8Array(0);
      files[`p/.git/objects/${i}`] = new Uint8Array(0);
    }
    const source = await readZip(new File([zipSync(files)], "p.zip"));
    expect([...source.files.keys()]).toEqual(["main.typ"]);
    expect(source.skipped).toEqual([".git"]);
  });
});

describe("assertImportable", () => {
  it("rejects an empty source", () => {
    expect(() => assertImportable(collect("x", []))).toThrow(ImportError);
  });
});

describe("pickMainFile", () => {
  it("prefers the shallowest .typ, then main.typ, then by name", () => {
    expect(pickMainFile(["sub/main.typ", "b.typ", "a.typ"])).toBe("a.typ");
    expect(pickMainFile(["a.typ", "main.typ"])).toBe("main.typ");
    expect(pickMainFile(["refs.bib"])).toBeNull();
  });
});

describe("writeImport", () => {
  it("round-trips an exported zip", async () => {
    const assets = fakeAssets();
    const zip = zipSync({
      "main.typ": strToU8("= Hello\n"),
      "refs.bib": strToU8("@book{a}\r\n"),
      "figures/logo.png": [PNG, { level: 0 }],
      "empty/": new Uint8Array(0),
    });
    const source = await readZip(new File([zip], "thesis.zip"));
    expect(source.name).toBe("thesis");
    assertImportable(source);

    const project = initProject(newProject(2), {
      title: "Thesis",
      starter: false,
    });
    await writeImport(project, source, assets);

    const index = buildPathIndex(project);
    expect([...index.byPath.keys()].sort()).toEqual([
      "empty",
      "figures",
      "figures/logo.png",
      "main.typ",
      "refs.bib",
    ]);
    expect(project.mainFile).toBe(index.byPath.get("main.typ"));
    expect(fileText(project, index.byPath.get("refs.bib")!)).toBe("@book{a}\n");
    const logo = project.fs.getNodeByID(index.byPath.get("figures/logo.png")!)!;
    expect(logo.data.get(NODE.hash)).toBe("sha256:logo.png");

    const exported = unzipSync((await exportZip(project, assets.load)).zip);
    expect(exported["figures/logo.png"]).toEqual(PNG);
  });

  it("leaves the doc untouched when an upload fails", async () => {
    const project = initProject(newProject(1), {
      title: "x",
      starter: false,
    });
    const assets = fakeAssets();
    assets.store = async () => {
      throw new Error("offline");
    };
    const source = collect("x", [
      file("main.typ", "hi"),
      { path: "logo.png", bytes: PNG },
    ]);

    await expect(writeImport(project, source, assets)).rejects.toMatchObject({
      paths: ["logo.png"],
    });
    expect(buildPathIndex(project).byPath.size).toBe(0);
  });
});

describe("writeSource", () => {
  function nonEmpty() {
    const project = initProject(newProject(1), { title: "x", starter: false });
    const parent = createFile(project, null, "docs", "dir");
    const figures = createFile(project, parent, "figures", "dir");
    createFile(project, figures, "old.typ", "text", "old");
    return { project, parent, figures };
  }

  it("restores a tree under a parent and renames a clashing folder", async () => {
    const { project, parent, figures } = nonEmpty();
    const assets = fakeAssets();
    const source = collect(
      "x",
      [
        file("figures/a.typ", "A"),
        { path: "figures/deep/logo.png", bytes: PNG },
        { path: "figures/empty/", bytes: null },
      ],
      { unwrap: false },
    );

    const { created, top } = await writeSource(project, source, assets, parent);

    const index = buildPathIndex(project);
    expect([...index.byPath.keys()].sort()).toEqual([
      "docs",
      "docs/figures",
      "docs/figures (2)",
      "docs/figures (2)/a.typ",
      "docs/figures (2)/deep",
      "docs/figures (2)/deep/logo.png",
      "docs/figures (2)/empty",
      "docs/figures/old.typ",
    ]);
    expect(index.byPath.get("docs/figures")).toBe(figures);
    expect(top).toEqual([index.byPath.get("docs/figures (2)")]);
    expect(created.get("figures/a.typ")).toBe(
      index.byPath.get("docs/figures (2)/a.typ"),
    );
    expect(fileText(project, created.get("figures/a.typ")!)).toBe("A");
  });

  it("writes nothing when an upload fails", async () => {
    const { project, parent } = nonEmpty();
    const before = buildPathIndex(project).byPath.size;
    const assets = fakeAssets();
    assets.store = async () => {
      throw new Error("offline");
    };
    const source = collect(
      "x",
      [file("p/a.typ", "A"), { path: "p/logo.png", bytes: PNG }],
      { unwrap: false },
    );
    await expect(
      writeSource(project, source, assets, parent),
    ).rejects.toMatchObject({ paths: ["p/logo.png"] });
    expect(buildPathIndex(project).byPath.size).toBe(before);
  });
});
