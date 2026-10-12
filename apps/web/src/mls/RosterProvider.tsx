import { useMemo, type ReactNode } from "react";

import { RosterContext, type RosterContextValue } from "./context";
import { usePeerSignersVersion, type PeerSigners } from "./peer-signers";
import type { MlsSession } from "./session";
import { useMlsSnapshot } from "./useMlsSnapshot";

/**
 * Makes the group's roster available to the parts of the app that put
 * names on people: the presence bar and the history.
 */
export function RosterProvider({
  mls,
  signers,
  children,
}: {
  mls: MlsSession | null;
  signers: PeerSigners;
  children: ReactNode;
}) {
  const { members } = useMlsSnapshot(mls);
  const version = usePeerSignersVersion(signers);
  const value = useMemo<RosterContextValue>(
    () => ({
      members,
      signers,
      memberOfPeer: (peer) => {
        const signer = signers.get(peer);
        return signer
          ? (members.find((m) => m.signer === signer) ?? null)
          : null;
      },
    }),
    // The version stands for the signers' contents, which the map hides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, signers, version],
  );
  return (
    <RosterContext.Provider value={value}>{children}</RosterContext.Provider>
  );
}
