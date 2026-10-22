import type { TreeID } from "loro-crdt";
import { createContext, useContext } from "react";

import type { RevealTarget } from "@/components/EditorPane";

/** Opens a file and selects `target` in it. */
export type RevealFn = (fileId: TreeID, target: RevealTarget) => void;

export const RevealContext = createContext<RevealFn | null>(null);

export function useReveal(): RevealFn {
  const reveal = useContext(RevealContext);
  if (!reveal)
    throw new Error("useReveal must be used inside ProjectWorkspace");
  return reveal;
}
