import type { EphemeralStore } from "loro-crdt";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useProject } from "@/project/context";

import { PresenceContext, type PresenceContextValue } from "./context";
import type { Identity } from "./identity";
import { Presence } from "./presence";

export interface PresenceProviderProps {
  ephemeral: EphemeralStore;
  identity: Identity;
  children: ReactNode;
}

/** Publishes this client's presence for the project above it. */
export function PresenceProvider({
  ephemeral,
  identity,
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

  useEffect(() => {
    // Viewers cannot write to the doc; the server would reject the update.
    if (readOnly) return;
    const known = project.getPeer(presence.peerId);
    if (known?.name === identity.name && known.color === identity.color) return;
    project.setPeer(presence.peerId, identity);
  }, [project, presence, identity, readOnly]);

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
