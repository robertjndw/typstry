import { useEffect, useState } from "react";

import { TinymistClient } from "@/lsp/tinymist-client";
import type { CompilerClient } from "@/typst/compiler-client";
import { usePreviewStarted } from "@/typst/hooks";

import { useProject } from "./context";

/**
 * A tinymist language server for the project above, for as long as it is
 * mounted. View-only projects get none: completion has nothing to do there.
 *
 * It waits for `compiler` to start first. tinymist's wasm is even larger
 * than the compiler's, and on a cold cache both downloading at once roughly
 * doubles the time until the first preview shows up. Completion can wait;
 * the preview is what people see first.
 */
export function useProjectTinymist(
  compiler: CompilerClient | null,
): TinymistClient | null {
  const { project, assets, readOnly } = useProject();
  const compilerStarted = usePreviewStarted(compiler);
  const [client, setClient] = useState<TinymistClient | null>(null);
  useEffect(() => {
    if (readOnly || !compilerStarted) return;
    const next = new TinymistClient(project, assets);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the client owns a Worker, which must be created and terminated by the effect
    setClient(next);
    return () => {
      next.dispose();
      setClient((c) => (c === next ? null : c));
    };
  }, [project, assets, readOnly, compilerStarted]);
  return client;
}
