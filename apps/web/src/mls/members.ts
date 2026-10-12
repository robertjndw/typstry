import { toHex } from "@/crypto/bytes";
import type { Member } from "@/crypto/wasm";
import { decodeProfile } from "@/presence/identity";

export type Role = Member["role"];

/** A device in the project's group, with the profile it signed. */
export interface RosterMember {
  leaf: number;
  role: Role;
  name: string;
  color: string;
  isSelf: boolean;
  /** Hex of the device key records and presence are verified under. */
  signer: string;
  /** The profile could not be read, so name and color are stand-ins. */
  anonymous: boolean;
}

const ANONYMOUS = { name: "Unnamed member", color: "#71717a" };

export function rosterOf(members: readonly Member[]): RosterMember[] {
  return members.map((m) => {
    const profile = m.profile ? decodeProfile(m.profile) : null;
    return {
      leaf: m.leaf,
      role: m.role,
      isSelf: m.isSelf,
      signer: toHex(m.sigPub),
      ...(profile ?? ANONYMOUS),
      anonymous: !profile,
    };
  });
}
