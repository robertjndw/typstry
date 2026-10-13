import { useSyncExternalStore } from "react";

import {
  storageHealth,
  subscribeStorageHealth,
  type StorageHealth,
} from "./local-doc-store";

/** Whether this browser is saving what it should; see `StorageHealth`. */
export function useStorageHealth(): StorageHealth {
  return useSyncExternalStore(subscribeStorageHealth, storageHealth);
}
