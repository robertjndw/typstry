import { createContext, useContext, useSyncExternalStore } from "react";

import type { Identity } from "./identity";
import type { Presence, RemotePeer } from "./presence";

export interface PresenceContextValue {
  presence: Presence;
  identity: Identity;
}

export const PresenceContext = createContext<PresenceContextValue | null>(null);

/** Null outside a PresenceProvider (local-only projects). */
export function usePresenceContext(): PresenceContextValue | null {
  return useContext(PresenceContext);
}

const EMPTY: readonly RemotePeer[] = [];
const noopSubscribe = () => () => {};
const getEmpty = () => EMPTY;

/** Everybody else in the project, sorted by name. */
export function usePresence(): readonly RemotePeer[] {
  const presence = useContext(PresenceContext)?.presence;
  return useSyncExternalStore(
    presence ? presence.subscribe : noopSubscribe,
    presence ? presence.getPeers : getEmpty,
  );
}
