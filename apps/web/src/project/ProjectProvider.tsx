import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import type { ProjectDoc } from "@/doc/schema";

import { ProjectContext, type ProjectContextValue } from "./context";
import { useDisposeOnUnmount } from "./dispose";
import { ProjectStore } from "./store";

const disposeStore = (store: ProjectStore) => store.dispose();

export interface ProjectProviderProps {
  doc: ProjectDoc;
  readOnly?: boolean;
  /** Blobs of a synced project; enables uploads and asset previews. */
  assets?: ProjectAssets;
  /** Remembers the open tabs in this browser under this id. */
  projectId?: string;
  /**
   * False until the doc has caught up with the server. Saved tabs of files
   * not loaded yet wait for it before they count as deleted.
   */
  synced?: boolean;
  children: ReactNode;
}

export function ProjectProvider({
  doc: project,
  readOnly = false,
  assets,
  projectId,
  synced = true,
  children,
}: ProjectProviderProps) {
  const store = useMemo(
    () =>
      new ProjectStore(project, {
        onOpenFileRemoved: (path) =>
          toast.info(`${path} was deleted by a collaborator`),
        projectId,
      }),
    [project, projectId],
  );
  useDisposeOnUnmount(store, disposeStore);
  useEffect(() => {
    if (synced) store.settle();
  }, [store, synced]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const value = useMemo<ProjectContextValue>(
    () => ({
      ...snapshot,
      project: store.project,
      undoManager: store.undoManager,
      readOnly,
      assets: assets ?? null,
      openFile: (id) => store.open(id),
      closeFile: (id) => store.close(id),
    }),
    [snapshot, store, readOnly, assets],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}
