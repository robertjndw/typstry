import type { CompilerClient } from "@/typst/compiler-client";
import { useCompilerClient } from "@/typst/hooks";

import { useProject } from "./context";

/** A compiler for the project above, with its uploaded assets mirrored in. */
export function useProjectCompiler(): CompilerClient | null {
  const { project, assets } = useProject();
  // useCompilerClient reads its options once per project, which is all we
  // need: the assets never change for a mounted project.
  return useCompilerClient(
    project,
    assets ? { assetLoader: (hash) => assets.load(hash) } : undefined,
  );
}
