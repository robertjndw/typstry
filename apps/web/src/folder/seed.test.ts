import { describe, expect, it } from "vitest";

import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { materialize } from "./materialize";
import { reconcile } from "./reconcile";
import { seedFromFolder } from "./seed";
import { handleFs } from "./folder-fs";
import { fakeAssets, fakeFolder } from "./test-utils";

function fresh() {
  const project = newProject(1);
  initProject(project, { title: "T", starter: false });
  return project;
}

describe("seedFromFolder", () => {
  it("fills the doc, picks the main file and returns a base that fits", async () => {
    const folder = fakeFolder({
      "chapters/one.typ": "one",
      "main.typ": '#include "chapters/one.typ"',
      "pic.png": new Uint8Array([0, 1]),
      ".gitignore": "*.aux\n",
      "x.aux": "ignored",
    });
    const assets = fakeAssets();
    const project = fresh();
    const progress: [number, number][] = [];
    const base = await seedFromFolder(
      project,
      assets,
      handleFs(folder.handle),
      {
        onProgress: (done, total) => progress.push([done, total]),
      },
    );

    const files = materialize(project);
    expect([...files.keys()]).toEqual([
      "chapters/one.typ",
      "main.typ",
      "pic.png",
    ]);
    expect(project.mainFile).toBe(files.get("main.typ")!.id);
    expect(progress).toEqual([[1, 1]]);
    expect(Object.keys(base.files).sort()).toEqual([
      "chapters/one.typ",
      "main.typ",
      "pic.png",
    ]);
    expect(base.frontiers).toEqual(project.doc.oplogFrontiers());

    // The first cycle after linking has nothing to do.
    const next = await reconcile({
      project,
      fs: handleFs(folder.handle),
      assets,
      base,
      canWrite: true,
    });
    expect(next.report.applied).toBeNull();
    expect(next.report.written).toEqual([]);
    expect(next.report.conflicts).toEqual([]);
  });

  it("falls back to the shallowest typ file and tolerates an empty folder", async () => {
    const project = fresh();
    await seedFromFolder(
      project,
      fakeAssets(),
      handleFs(fakeFolder({ "a/b.typ": "b", "z.typ": "z" }).handle),
    );
    expect(project.mainFile).toBe(materialize(project).get("z.typ")!.id);

    const empty = fresh();
    const base = await seedFromFolder(
      empty,
      fakeAssets(),
      handleFs(fakeFolder().handle),
    );
    expect(base.files).toEqual({});
    expect(empty.mainFile).toBeNull();
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      seedFromFolder(
        fresh(),
        fakeAssets(),
        handleFs(fakeFolder({ "a.typ": "a" }).handle),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
