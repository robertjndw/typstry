import { describe, expect, it } from "vitest";

import { toHex } from "@/crypto/bytes";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { authorIdentities } from "@/project/history-items";

import { rosterOf } from "./members";
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
