import { createContext, useContext } from "react";

import type { RosterMember } from "./members";
import type { PeerSigners } from "./peer-signers";

export interface RosterContextValue {
  members: readonly RosterMember[];
  signers: PeerSigners;
  /**
   * The member whose key signed what `peer` wrote, if the roster has it.
   * Names from here are authenticated; anything else a peer says about
   * itself is only a claim.
   */
  memberOfPeer: (peer: string) => RosterMember | null;
}

export const RosterContext = createContext<RosterContextValue | null>(null);

/** Null outside a project that has a group (or before it is joined). */
export function useRoster(): RosterContextValue | null {
  return useContext(RosterContext);
}
