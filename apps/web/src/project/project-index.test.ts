import { createAsset, createFile, getText, rename } from "@/doc/fs-ops";
import * as paths from "@/doc/paths";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { deletePackage, putPackage, setFontBundle } from "@/packages/records";

import { projectIndex, type ProjectIndexChange } from "./project-index";

function setup() {
  const project = initProject(newProject(1), { title: "T" });
  const index = projectIndex(project);
  const changes: ProjectIndexChange[] = [];
  const unsubscribe = index.subscribe((c) => changes.push(c));
  return { project, index, changes, unsubscribe };
}

describe("ProjectIndex", () => {
  it("is shared per doc and rebuilt once per batch for all subscribers", () => {
    const { project, index } = setup();
    expect(projectIndex(project)).toBe(index);
    const second: ProjectIndexChange[] = [];
    index.subscribe((c) => second.push(c));

    const build = vi.spyOn(paths, "buildPathIndex");
    createFile(project, null, "a.typ", "text");
    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(1);
    build.mockRestore();
  });

  it("reports edits without rebuilding", () => {
    const { project, index, changes } = setup();
    const before = index.state;
    getText(project, project.mainFile!).insert(0, "x");
    project.doc.commit();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ structural: false, state: before });
    expect([...changes[0]!.edited]).toEqual([project.mainFile]);
  });

  it("diffs renames and asset changes", () => {
    const { project, changes } = setup();
    const main = project.mainFile!;
    rename(project, main, "book.typ");
    const [renamed] = changes.splice(0);
    expect(renamed!.textsRemoved.map((t) => t.path)).toEqual(["main.typ"]);
    expect(renamed!.textsAdded.map((t) => t.path)).toEqual(["book.typ"]);
    expect(renamed!.mainChanged).toBe(false);

    createAsset(project, null, "logo.png", { hash: "h", size: 1, mime: "" });
    const [added] = changes.splice(0);
    expect(added!.assetsAdded).toEqual([
      expect.objectContaining({ path: "logo.png", hash: "h" }),
    ]);
    expect(added!.textsAdded).toEqual([]);
  });

  it("keeps the path index object when only other data changed", () => {
    const { project, index, changes } = setup();
    const before = index.state.paths;
    project.setPeer("7", { name: "Ada", color: "#000" });
    expect(changes[0]!.structural).toBe(true);
    expect(changes[0]!.state.paths).toBe(before);
  });

  it("tracks packages and font bundles", () => {
    const { project, index, changes } = setup();
    expect(index.state.fontAssets).toEqual(["text"]);
    const record = {
      namespace: "local",
      name: "p",
      version: "1.0.0",
      hash: "h1",
      size: 1,
      mime: "application/gzip",
      entrypoint: "lib.typ",
      fileCount: 1,
      unpackedSize: 1,
      source: "upload" as const,
      addedAt: 1,
    };
    putPackage(project, record);
    const [added] = changes.splice(0);
    expect(added!.packagesAdded).toEqual([record]);
    expect(added!.fontAssetsChanged).toBe(false);
    const packages = index.state.packages;

    // Unrelated structural change keeps the same map.
    project.setPeer("7", { name: "Ada", color: "#000" });
    expect(changes.splice(0)[0]!.state.packages).toBe(packages);

    putPackage(project, { ...record, hash: "h2" });
    expect(changes.splice(0)[0]!.packagesAdded.map((p) => p.hash)).toEqual([
      "h2",
    ]);

    setFontBundle(project, "emoji", true);
    const [fonts] = changes.splice(0);
    expect(fonts!.fontAssetsChanged).toBe(true);
    expect(fonts!.state.fontAssets).toEqual(["text", "emoji"]);

    deletePackage(project, "local/p/1.0.0");
    const [removed] = changes.splice(0);
    expect(removed!.packagesRemoved).toEqual(["local/p/1.0.0"]);
    expect(removed!.fontAssetsChanged).toBe(false);
  });
});
