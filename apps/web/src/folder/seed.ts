import type { ProjectAssets } from "@/assets/project-assets";
import { setMainFile } from "@/doc/fs-ops";
import type { ProjectDoc } from "@/doc/schema";
import { pickMainFile } from "@/import/import";

import type { FolderBase } from "./base";
import type { FolderFs } from "./folder-fs";
import { materialize } from "./materialize";
import { reconcile } from "./reconcile";

/**
 * Fills a fresh project doc from a folder. Returns the base to store with the
 * link, so the first cycle after navigating has nothing to redo. Call it from
 * the `seed` of `createLocalProject`, which stores the doc after it returns.
 */
export async function seedFromFolder(
  project: ProjectDoc,
  assets: ProjectAssets,
  fs: FolderFs,
  opts: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<FolderBase> {
  const { base } = await reconcile({
    project,
    fs,
    assets,
    base: null,
    canWrite: true,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
  if (project.mainFile === null) {
    const files = materialize(project);
    const texts = [...files].filter(([, f]) => f.kind === "text");
    const main = pickMainFile(texts.map(([path]) => path));
    if (main) {
      setMainFile(project, files.get(main)!.id);
      // The main file is doc metadata that no folder file maps to, so the
      // base only has to move up to include its commit.
      base.frontiers = project.doc.oplogFrontiers();
    }
  }
  return base;
}
