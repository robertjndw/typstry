import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  CompilerClient,
  CompilerClientOptions,
} from "@/typst/compiler-client";
import { useCompilerClient } from "@/typst/hooks";

import { useProject } from "./context";

/** A compiler for the project above, with its uploaded assets mirrored in. */
export function useProjectCompiler(): CompilerClient | null {
  const { project, assets } = useProject();
  // useCompilerClient reads its options once per project, but `assets` can
  // change under a mounted project: rotating the link (when the owner
  // removes a member) brings a new token and keys, and blobs fetched with
  // the old ones fail. The loader always goes through the latest instead.
  const assetsRef = useRef(assets);
  useLayoutEffect(() => {
    assetsRef.current = assets;
  });
  const [options] = useState<CompilerClientOptions | undefined>(() =>
    assets
      ? {
          assetLoader: (hash) => {
            const current = assetsRef.current;
            return current
              ? current.load(hash)
              : Promise.reject(
                  new Error("the project's files are unavailable"),
                );
          },
        }
      : undefined,
  );
  const client = useCompilerClient(project, options);
  // Loads that failed with the old link would otherwise wait out their
  // backoff before trying the new one.
  useEffect(() => {
    if (assets) client?.refreshAssets();
  }, [client, assets]);
  return client;
}
