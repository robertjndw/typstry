import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import type { ProjectDoc } from "@/doc/schema";

import { ProjectContext, type ProjectContextValue } from "./context";
import { ProjectStore } from "./store";

export interface ProjectProviderProps {
  doc: ProjectDoc;
  readOnly?: boolean;
  /** Blobs of a synced project; enables uploads and asset previews. */
  assets?: ProjectAssets;
  children: ReactNode;
}

export function ProjectProvider({
  doc: project,
  readOnly = false,
  assets,
  children,
}: ProjectProviderProps) {
  const store = useMemo(
    () =>
      new ProjectStore(project, {
        onOpenFileRemoved: (path) =>
          toast.info(`${path} was deleted by a collaborator`),
      }),
    [project],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const value = useMemo<ProjectContextValue>(
    () => ({
      ...snapshot,
      project: store.project,
      undoManager: store.undoManager,
      readOnly,
      assets: assets ?? null,
      openFile: (id) => store.open(id),
    }),
    [snapshot, store, readOnly, assets],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}
