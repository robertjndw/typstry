import type { EphemeralStore } from "loro-crdt";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { SpaceCrypto } from "@/crypto/space-crypto";
import { useProject } from "@/project/context";

import { PresenceContext, type PresenceContextValue } from "./context";
import type { Identity } from "./identity";
import { Presence } from "./presence";

export interface PresenceProviderProps {
  ephemeral: EphemeralStore;
  identity: Identity;
  /** The project's keys; without them the peer info is written right away. */
  crypto?: Pick<SpaceCrypto, "grouped" | "onChange">;
  children: ReactNode;
}

const ALWAYS = () => () => {};

/** Publishes this client's presence for the project above it. */
export function PresenceProvider({
  ephemeral,
  identity,
  crypto,
  children,
}: PresenceProviderProps) {
  const { project, openFileId, readOnly } = useProject();
  const [presence] = useState(
    () => new Presence({ doc: project.doc, ephemeral, identity }),
  );

  useEffect(() => {
    presence.start();
    return () => presence.dispose();
  }, [presence]);

  useEffect(() => presence.setIdentity(identity), [presence, identity]);
  useEffect(() => presence.setFile(openFileId), [presence, openFileId]);

  const grouped = useSyncExternalStore(
    crypto ? (onChange) => crypto.onChange(onChange) : ALWAYS,
    () => crypto?.grouped ?? true,
  );

  useEffect(() => {
    // Viewers cannot write to the doc; the server would reject the update.
    if (readOnly) return;
    // Until the group is joined, records are signed with a stand-in key, and
    // the first key a peer's records come with is the one its presence has
    // to match from then on (see PeerSigners). Writing the peer info that
    // early would get this client's presence dropped by everyone.
    if (!grouped) return;
    const known = project.getPeer(presence.peerId);
    if (known?.name === identity.name && known.color === identity.color) return;
    project.setPeer(presence.peerId, identity);
  }, [project, presence, identity, readOnly, grouped]);

  const value = useMemo<PresenceContextValue>(
    () => ({ presence, identity }),
    [presence, identity],
  );
  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}
