import { toHex } from "@/crypto/bytes";
import type { Member } from "@/crypto/wasm";
import { decodeProfile, type Identity } from "@/presence/identity";

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
  /** Hex of the person id this device proves to belong to, if it does. */
  person: string | null;
  /**
   * "unverified" is an identity that does not check out: never shown as
   * the person it claims, and not removable with them.
   */
  personState: Member["personState"];
  personFingerprint: string | null;
  /** The person's merged graph shows this device revoked. */
  deviceRevoked: boolean;
  /** Name and color the person's own devices agreed on, if they set any. */
  personProfile: Identity | null;
}

/** One human in the roster: all the devices that prove the same person id. */
export interface RosterPerson {
  /** Hex of the person id; null for a device that carries no identity. */
  key: string | null;
  /** The safety number to compare out of band; null without a person id. */
  fingerprint: string | null;
  devices: RosterMember[];
  /** One of the devices is this one. */
  isSelf: boolean;
  /** What the person's devices share; wins over what one leaf signed. */
  profile: Identity | null;
  /** The highest role among the devices. */
  role: Role;
  /** A device whose identity failed verification. */
  unverified: boolean;
  /** Some device is revoked but still in the group, until it is removed. */
  revoked: boolean;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

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
      person: m.personId ? toHex(m.personId) : null,
      personState: m.personState,
      personFingerprint: m.personFingerprint ?? null,
      deviceRevoked: m.deviceRevoked,
      personProfile: m.personProfile ? decodeProfile(m.personProfile) : null,
    };
  });
}

/**
 * Groups devices by the person id they prove. A device without a
 * verified person stands alone: anonymous ones because nothing links them,
 * unverified ones because their claim must not merge them with anybody.
 */
export function peopleOf(members: readonly RosterMember[]): RosterPerson[] {
  const people: RosterPerson[] = [];
  const byKey = new Map<string, RosterPerson>();
  for (const device of members) {
    let person = device.person ? byKey.get(device.person) : undefined;
    if (!person) {
      person = {
        key: device.person,
        fingerprint: device.personFingerprint,
        devices: [],
        profile: null,
        isSelf: false,
        role: device.role,
        unverified: false,
        revoked: false,
      };
      people.push(person);
      if (device.person) byKey.set(device.person, person);
    }
    person.devices.push(device);
    person.profile ??= device.personProfile;
    person.isSelf ||= device.isSelf;
    if (RANK[device.role] > RANK[person.role]) person.role = device.role;
    if (device.personState === "unverified") person.unverified = true;
    if (device.deviceRevoked) person.revoked = true;
  }
  return people;
}
