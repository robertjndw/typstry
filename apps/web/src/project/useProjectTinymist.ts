import { useEffect, useState } from "react";

import { TinymistClient } from "@/lsp/tinymist-client";

import { useProject } from "./context";

/**
 * A tinymist language server for the project above, for as long as it is
 * mounted. View-only projects get none: completion has nothing to do there.
 */
export function useProjectTinymist(): TinymistClient | null {
  const { project, assets, readOnly } = useProject();
  const [client, setClient] = useState<TinymistClient | null>(null);
  useEffect(() => {
    if (readOnly) return;
    const next = new TinymistClient(project, assets);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the client owns a Worker, which must be created and terminated by the effect
    setClient(next);
    return () => {
      next.dispose();
      setClient((c) => (c === next ? null : c));
    };
  }, [project, assets, readOnly]);
  return client;
}
