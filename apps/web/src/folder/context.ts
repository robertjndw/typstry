import { createContext, useContext } from "react";

import type { FolderSyncState } from "./engine";

export interface FolderSyncApi {
  state: FolderSyncState | null;
  linkName: string | null;
  /** Call straight from a click handler: the picker only opens before the first await. */
  link: () => Promise<void>;
  unlink: () => Promise<void>;
  syncNow: () => Promise<void>;
  /** Same click-handler rule as `link`. */
  reconnect: () => Promise<void>;
}

export const FolderSyncContext = createContext<FolderSyncApi | null>(null);

/** Null where folders cannot be linked: unsupported browser or no provider. */
export function useFolderSync(): FolderSyncApi | null {
  return useContext(FolderSyncContext);
}
