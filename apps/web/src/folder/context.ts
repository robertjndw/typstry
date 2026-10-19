import { createContext, useContext } from "react";

import type { FolderSyncState } from "./engine";

export interface FolderSyncApi {
  /** Null while no folder is linked. */
  state: FolderSyncState | null;
  /** Name of the linked folder, null while none is linked. */
  linkName: string | null;
  /**
   * Asks for a folder and links it. Has to be called straight from a click
   * handler: the picker only opens before the first await.
   */
  link: () => Promise<void>;
  /** Stops syncing; the files stay where they are. */
  unlink: () => Promise<void>;
  syncNow: () => Promise<void>;
  /** Same click-handler rule as `link`, for the permission prompt. */
  reconnect: () => Promise<void>;
}

export const FolderSyncContext = createContext<FolderSyncApi | null>(null);

/** Null where folders cannot be linked: unsupported browser or no provider. */
export function useFolderSync(): FolderSyncApi | null {
  return useContext(FolderSyncContext);
}
