import { useEffect, useState, useSyncExternalStore } from "react";

import type { ProjectDoc } from "@/doc/schema";

import {
  CompilerClient,
  type CompilerClientOptions,
  type PreviewState,
} from "./compiler-client";
import type { ProjectDiagnostic } from "./diagnostics";

/**
 * Owns a CompilerClient (and its worker) for the lifetime of `project`.
 * Returns null on the first render, before the effect has created it.
 */
export function useCompilerClient(
  project: ProjectDoc | null,
  options?: CompilerClientOptions,
): CompilerClient | null {
  const [client, setClient] = useState<CompilerClient | null>(null);
  // Options are read once per project; changing them later is not supported.
  const [initialOptions] = useState(options);
  useEffect(() => {
    if (!project) return;
    const next = new CompilerClient(project, initialOptions);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the client owns a Worker, which must be created and terminated by the effect
    setClient(next);
    return () => {
      next.dispose();
      setClient((c) => (c === next ? null : c));
    };
  }, [project, initialOptions]);
  return client;
}

const noopSubscribe = () => () => {};
const getNull = () => null;
const getUndefined = () => undefined;

/**
 * Just the diagnostics, so a caller re-renders when they change rather than
 * on every compile status update.
 */
export function usePreviewDiagnostics(
  client: CompilerClient | null,
): readonly ProjectDiagnostic[] | undefined {
  return useSyncExternalStore(
    client ? client.subscribe : noopSubscribe,
    client ? () => client.getState().diagnostics : getUndefined,
  );
}

export function usePreviewState(
  client: CompilerClient | null,
): PreviewState | null {
  return useSyncExternalStore(
    client ? client.subscribe : noopSubscribe,
    client ? client.getState : getNull,
  );
}
