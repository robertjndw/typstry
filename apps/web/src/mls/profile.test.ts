import { afterEach, describe, expect, it } from "vitest";

import { DeviceKey, PersonGraph } from "@/crypto/wasm";
import { MemoryBackend } from "@/persist/local-doc-store";
import {
  decodeProfile,
  encodeProfile,
  loadIdentity,
  resetIdentityCache,
  setIdentity,
} from "@/presence/identity";

import { localIdentity, mergeOwnGraph } from "./identity";
import { publishProfile } from "./profile";

afterEach(() => {
  localStorage.clear();
  resetIdentityCache();
});

const ada = { name: "Ada", color: "#1d4ed8" };
const grace = { name: "Grace", color: "#047857" };

// The encoding grows with every entry, which is all these tests need.
async function entries(backend: MemoryBackend): Promise<number> {
  return (await backend.loadGraph())!.length;
}

describe("a new person", () => {
  it("starts with the name already chosen here", async () => {
    setIdentity(ada);
    const backend = new MemoryBackend();
    const { graph } = await localIdentity(backend);
    const decoded = PersonGraph.decode(graph);
    expect(decodeProfile(decoded.profile()!)).toEqual(ada);
    decoded.free();
  });

  it("starts without a profile when no name was chosen", async () => {
    const { graph } = await localIdentity(new MemoryBackend());
    const decoded = PersonGraph.decode(graph);
    expect(decoded.profile()).toBeUndefined();
    decoded.free();
  });
});

describe("publishProfile", () => {
  it("writes nothing for a browser without a graph", async () => {
    const backend = new MemoryBackend();
    expect(await publishProfile(backend, ada)).toBe(false);
    expect(await backend.loadGraph()).toBeNull();
  });

  it("appends once per change and not for the same profile again", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    const before = await entries(backend);

    expect(await publishProfile(backend, ada)).toBe(true);
    expect(await publishProfile(backend, ada)).toBe(false);
    expect(await entries(backend)).toBeGreaterThan(before);
    const first = await entries(backend);

    expect(await publishProfile(backend, grace)).toBe(true);
    expect(await entries(backend)).toBeGreaterThan(first);
  });

  it("does not append when the graph already has the profile", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    const set = PersonGraph.decode(graph);
    // Another writer's bytes, e.g. the CLI with a different key order.
    set.setProfile(
      deviceSeed,
      new TextEncoder().encode(
        JSON.stringify({ color: ada.color, name: ada.name }),
      ),
    );
    await mergeOwnGraph(backend, set.encode());
    set.free();
    const before = await entries(backend);
    expect(await publishProfile(backend, ada)).toBe(false);
    expect(await entries(backend)).toBe(before);
  });
});

describe("adopting a profile from the graph", () => {
  it("updates the stored identity without appending anything", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    setIdentity(ada);
    // Another device of the person changes the name and the graph arrives.
    const other = DeviceKey.generate();
    const theirs = PersonGraph.decode(graph);
    theirs.addDevice(deviceSeed, other.publicKey());
    theirs.setProfile(other.export(), encodeProfile(grace));
    const incoming = theirs.encode();
    theirs.free();

    const merged = await mergeOwnGraph(backend, incoming);
    expect(loadIdentity()).toEqual(grace);

    // Merging the same graph again changes nothing and cannot loop.
    setIdentity(ada);
    await mergeOwnGraph(backend, incoming);
    expect(loadIdentity()).toEqual(ada);
    expect(merged.length).toBe(incoming.length);
  });

  it("does not undo a name picked here on an unrelated merge", async () => {
    const backend = new MemoryBackend();
    const { graph } = await localIdentity(backend);
    await publishProfile(backend, ada);
    setIdentity(grace);
    await mergeOwnGraph(backend, graph);
    expect(loadIdentity()).toEqual(grace);
  });
});
