import { useSyncExternalStore } from "react";

import { IDLE, type MlsSession, type MlsSnapshot } from "./session";

const noopSubscribe = () => () => {};
const getIdle = () => IDLE;

/** The state of a project's group; idle while there is no session yet. */
export function useMlsSnapshot(mls: MlsSession | null): MlsSnapshot {
  return useSyncExternalStore(
    mls ? mls.subscribe : noopSubscribe,
    mls ? mls.getSnapshot : getIdle,
  );
}
