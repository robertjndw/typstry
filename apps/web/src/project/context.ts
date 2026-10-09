import type { TreeID, UndoManager } from "loro-crdt";
import { createContext, useContext } from "react";

import type { ProjectAssets } from "@/assets/project-assets";
import type { ProjectDoc } from "@/doc/schema";

import type { ProjectSnapshot } from "./store";

export interface ProjectContextValue extends ProjectSnapshot {
  project: ProjectDoc;
  undoManager: UndoManager;
  /** View-only share link: no edits to text or files. */
  readOnly: boolean;
  /** Binary files of a synced project; null for a local-only one. */
  assets: ProjectAssets | null;
  openFile: (id: TreeID | null) => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside ProjectProvider");
  return value;
}
