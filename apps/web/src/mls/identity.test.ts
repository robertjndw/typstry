import { describe, expect, it } from "vitest";

import { DeviceKey, PersonGraph } from "@/crypto/wasm";
import { MemoryBackend } from "@/persist/local-doc-store";

import { localDeviceKey, localIdentity, mergeOwnGraph } from "./identity";

describe("localIdentity", () => {
  it("makes a device key and a genesis graph once", async () => {
    const backend = new MemoryBackend();
    const first = await localIdentity(backend);
    expect(await localIdentity(backend)).toEqual(first);

    const key = DeviceKey.import(first.deviceSeed);
    const graph = PersonGraph.decode(first.graph);
    expect(graph.deviceState(key.publicKey())).toBe("valid");
    key.free();
    graph.free();
  });

  it("settles on one identity when callers race on the first use", async () => {
    const backend = new MemoryBackend();
    const all = await Promise.all([
      localIdentity(backend),
      localIdentity(backend),
      localIdentity(backend),
    ]);
    expect(all[1]).toEqual(all[0]);
    expect(all[2]).toEqual(all[0]);
    expect(await backend.loadGraph()).toEqual(all[0]!.graph);
  });

  it("keeps the graph out of a device that only has a key", async () => {
    const backend = new MemoryBackend();
    await localDeviceKey(backend);
    expect(await backend.loadGraph()).toBeNull();
  });
});

describe("mergeOwnGraph", () => {
  it("adds the entries it did not have and never drops one", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    const ahead = PersonGraph.decode(graph);
    const other = DeviceKey.generate();
    ahead.addDevice(deviceSeed, other.publicKey());

    const merged = await mergeOwnGraph(backend, ahead.encode());
    // An older copy merged afterwards changes nothing.
    expect(await mergeOwnGraph(backend, graph)).toEqual(merged);
    const result = PersonGraph.decode(merged);
    expect(result.devices()).toHaveLength(2);
    ahead.free();
    result.free();
    other.free();
  });

  it("refuses the graph of another person", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    const foreign = PersonGraph.genesis(DeviceKey.generate().export());
    await expect(
      mergeOwnGraph(backend, foreign.encode()),
    ).rejects.toBeDefined();
    foreign.free();
  });
});
