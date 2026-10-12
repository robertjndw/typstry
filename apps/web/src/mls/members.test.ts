import { describe, expect, it } from "vitest";

import { toHex } from "@/crypto/bytes";
import type { Member } from "@/crypto/wasm";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { authorIdentities } from "@/project/history-items";

import { peopleOf, rosterOf } from "./members";
import { PeerSigners } from "./peer-signers";

describe("PeerSigners", () => {
  it("keeps the first signer seen for a peer", () => {
    const signers = new PeerSigners();
    signers.record("1", new Uint8Array([1, 2]));
    signers.record("1", new Uint8Array([9, 9]));
    expect(signers.get("1")).toBe("0102");
    expect(signers.get("2")).toBeUndefined();
  });

  it("tells listeners about new peers only", () => {
    const signers = new PeerSigners();
    let calls = 0;
    signers.subscribe(() => calls++);
    signers.record("1", new Uint8Array([1]));
    signers.record("1", new Uint8Array([2]));
    signers.record("2", new Uint8Array([2]));
    expect(calls).toBe(2);
    expect(signers.getVersion()).toBe(2);
  });
});

describe("rosterOf", () => {
  const member = (profile?: Uint8Array) => ({
    leaf: 3,
    role: "viewer" as const,
    profile,
    isSelf: false,
    sigPub: new Uint8Array([0xab, 0xcd]),
    personState: "anonymous" as const,
    deviceRevoked: false,
  });

  it("reads the profile each member signed", () => {
    const profile = new TextEncoder().encode(
      JSON.stringify({ name: "Ada", color: "#1d4ed8" }),
    );
    expect(rosterOf([member(profile)])[0]).toMatchObject({
      leaf: 3,
      name: "Ada",
      color: "#1d4ed8",
      signer: "abcd",
      anonymous: false,
    });
  });

  it("does not trust a profile it cannot read", () => {
    const junk = new TextEncoder().encode("{not json");
    expect(rosterOf([member(junk)])[0]).toMatchObject({
      name: "Unnamed member",
      anonymous: true,
    });
    expect(rosterOf([member()])[0]!.anonymous).toBe(true);
  });
});

describe("peopleOf", () => {
  const device = (
    leaf: number,
    person: number | null,
    over: Partial<Member> = {},
  ): Member => ({
    leaf,
    role: "viewer",
    isSelf: false,
    sigPub: new Uint8Array([leaf]),
    personId: person === null ? undefined : new Uint8Array([person]),
    deviceRevoked: false,
    personState: person === null ? "anonymous" : "verified",
    personFingerprint: person === null ? undefined : `fp${person}`,
    ...over,
  });
  const people = (members: Member[]) => peopleOf(rosterOf(members));

  it("takes the person profile from the graph when a leaf has one", () => {
    const profile = (name: string) =>
      new TextEncoder().encode(JSON.stringify({ name, color: "#1d4ed8" }));
    const [bob] = people([
      device(0, 7, { personProfile: profile("Bobby") }),
      device(1, 7),
    ]);
    expect(bob!.profile).toEqual({ name: "Bobby", color: "#1d4ed8" });
    expect(people([device(0, 7)])[0]!.profile).toBeNull();
  });

  it("groups the devices of one person and keeps the rest apart", () => {
    const result = people([
      device(0, 7, { isSelf: true }),
      device(1, null),
      device(2, 7, { role: "editor" }),
      device(3, null),
      device(4, 8),
    ]);
    expect(result.map((p) => p.devices.map((d) => d.leaf))).toEqual([
      [0, 2],
      [1],
      [3],
      [4],
    ]);
    expect(result[0]).toMatchObject({
      key: "07",
      fingerprint: "fp7",
      isSelf: true,
      role: "editor",
      unverified: false,
    });
    expect(result[1]).toMatchObject({ key: null, fingerprint: null });
  });

  it("flags a person with a revoked device still in the group", () => {
    const result = people([
      device(0, 7),
      device(1, 7, { deviceRevoked: true }),
      device(2, 8),
    ]);
    expect(result.map((p) => p.revoked)).toEqual([true, false]);
    expect(result[0]!.devices.map((d) => d.deviceRevoked)).toEqual([
      false,
      true,
    ]);
  });

  it("gives a person the highest role among their devices", () => {
    const result = people([
      device(0, 7, { role: "editor" }),
      device(1, 7, { role: "owner" }),
      device(2, 8, { role: "viewer" }),
    ]);
    expect(result.map((p) => p.role)).toEqual(["owner", "viewer"]);
  });

  it("never merges an unverified device into anyone", () => {
    const result = people([
      device(0, 7),
      device(1, null, { personState: "unverified" }),
      device(2, null, { personState: "unverified" }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ key: null, unverified: true });
  });
});

describe("history authors", () => {
  it("prefers the roster's name over the one a peer wrote into the doc", () => {
    const project = initProject(newProject(1), { title: "T" });
    project.setPeer("100", { name: "Mallory", color: "#b91c1c" });
    project.setPeer("200", { name: "Bob", color: "#1d4ed8" });
    const roster = new Map([
      [
        "100",
        { name: "Alice", color: "#047857", signer: toHex(new Uint8Array([1])) },
      ],
      [
        "101",
        { name: "Alice", color: "#047857", signer: toHex(new Uint8Array([1])) },
      ],
    ]);
    const authors = authorIdentities(
      project,
      ["100", "101", "200"] as never,
      (peer) => roster.get(peer) ?? null,
    );
    // One member under two peer ids, and the unverified claim as it is.
    expect(authors.map((a) => a.name)).toEqual(["Alice", "Bob"]);
  });

  it("falls back to the claimed name without a roster", () => {
    const project = initProject(newProject(1), { title: "T" });
    project.setPeer("100", { name: "Mallory", color: "#b91c1c" });
    expect(
      authorIdentities(project, ["100", "999"] as never).map((a) => a.name),
    ).toEqual(["Mallory", "Unknown"]);
  });
});
