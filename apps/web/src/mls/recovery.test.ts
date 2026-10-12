import { afterEach, describe, expect, it } from "vitest";

import {
  DeviceKey,
  LinkSecret,
  PersonGraph,
  ProjectGroup,
  RecoveryKey,
  mergeOwnerSecrets,
} from "@/crypto/wasm";
import { toHex } from "@/crypto/bytes";
import { MemoryBackend } from "@/persist/local-doc-store";
import {
  encodeProfile,
  loadIdentity,
  resetIdentityCache,
} from "@/presence/identity";

import { localDeviceKey, localIdentity } from "./identity";
import {
  createRecoveryKey,
  DeviceRevokedError,
  keepOwnerKey,
  recoverDevice,
  recoveredOwnerKey,
  RecoveryError,
} from "./recovery";

afterEach(() => {
  localStorage.clear();
  resetIdentityCache();
});

function pubOf(seed: Uint8Array): Uint8Array {
  const key = DeviceKey.import(seed);
  const pub = key.publicKey();
  key.free();
  return pub;
}

/** A person with two devices and a recovery key, as another browser sees it. */
async function account(first = new MemoryBackend()) {
  const { deviceSeed: seedA } = await localIdentity(first);
  const words = await createRecoveryKey(first);
  const second = DeviceKey.generate();
  const graph = PersonGraph.decode((await first.loadGraph())!);
  graph.addDevice(seedA, second.publicKey());
  graph.setProfile(seedA, encodeProfile({ name: "Ada", color: "#1d4ed8" }));
  const bytes = graph.encode();
  graph.free();
  return {
    words,
    bytes,
    a: pubOf(seedA),
    b: second.publicKey(),
    seedB: second.export(),
  };
}

function stateOf(bytes: Uint8Array, pub: Uint8Array) {
  const graph = PersonGraph.decode(bytes);
  const state = graph.deviceState(pub);
  graph.free();
  return state;
}

describe("createRecoveryKey", () => {
  it("adds a recovery device and labels it", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    const words = await createRecoveryKey(backend);
    expect(words.split(/\s+/)).toHaveLength(17);
    const graph = PersonGraph.decode((await backend.loadGraph())!);
    const devices = graph.devices();
    graph.free();
    const recovery = devices.filter((d) => d.recovery);
    expect(recovery).toHaveLength(1);
    expect((await backend.loadLabels())[toHex(recovery[0]!.pub)]).toBe(
      "Recovery key",
    );
  });
});

describe("recoverDevice", () => {
  it("adds this device, revokes the others and adopts the profile", async () => {
    const { words, bytes, a, b } = await account();
    const backend = new MemoryBackend();
    const { graph } = await recoverDevice(backend, { words, graphs: [bytes] });
    const own = pubOf((await backend.loadDeviceKey())!);
    expect(stateOf(graph, own)).toBe("valid");
    expect(stateOf(graph, a)).toBe("revoked");
    expect(stateOf(graph, b)).toBe("revoked");
    expect(await backend.loadGraph()).toEqual(graph);
    expect(loadIdentity()?.name).toBe("Ada");
  });

  it("keeps the other devices on request", async () => {
    const { words, bytes, a } = await account();
    const { graph } = await recoverDevice(new MemoryBackend(), {
      words,
      graphs: [bytes],
      keepOthers: true,
    });
    expect(stateOf(graph, a)).toBe("valid");
  });

  it("picks the graph the key belongs to", async () => {
    const mine = await account();
    const stranger = await account();
    const backend = new MemoryBackend();
    const { graph } = await recoverDevice(backend, {
      words: mine.words,
      graphs: [stranger.bytes, mine.bytes],
    });
    expect(stateOf(graph, mine.a)).toBe("revoked");
    expect(stateOf(graph, stranger.a)).toBe("unknown");
  });

  it("refuses words that open no graph, without making a key", async () => {
    const { bytes } = await account();
    const backend = new MemoryBackend();
    const other = RecoveryKey.generate().words;
    await expect(
      recoverDevice(backend, { words: other, graphs: [bytes] }),
    ).rejects.toBeInstanceOf(RecoveryError);
    await expect(
      recoverDevice(backend, { words: "not words", graphs: [bytes] }),
    ).rejects.toBeInstanceOf(RecoveryError);
    expect(await backend.loadDeviceKey()).toBeNull();
    expect(await backend.loadGraph()).toBeNull();
  });

  it("refuses a browser that is a device of someone else, unless replacing", async () => {
    const { words, bytes } = await account();
    const backend = new MemoryBackend();
    const { graph: foreign } = await localIdentity(backend);
    await expect(
      recoverDevice(backend, { words, graphs: [bytes] }),
    ).rejects.toThrow(/already has an identity/);
    expect(await backend.loadGraph()).toEqual(foreign);

    const { graph } = await recoverDevice(backend, {
      words,
      graphs: [bytes],
      replace: true,
    });
    const own = pubOf(await localDeviceKey(backend));
    expect(stateOf(graph, own)).toBe("valid");
    expect(await backend.loadGraph()).toEqual(graph);
  });

  it("refuses a browser whose device the person revoked", async () => {
    const backend = new MemoryBackend();
    const { words, bytes, a, seedB } = await account(backend);
    const revoked = PersonGraph.decode(bytes);
    revoked.revoke(seedB, a);
    const graphs = [revoked.encode()];
    revoked.free();

    await expect(
      recoverDevice(backend, { words, graphs }),
    ).rejects.toBeInstanceOf(DeviceRevokedError);
  });

  it("counts a revoke this browser stored, even when the project lacks it", async () => {
    const backend = new MemoryBackend();
    const { words, bytes, a, seedB } = await account(backend);
    // This browser learned of its own revoke; the project never did.
    const revoked = PersonGraph.decode(bytes);
    revoked.revoke(seedB, a);
    await backend.mergeGraph(revoked.encode(), (_, incoming) => incoming);
    revoked.free();

    await expect(
      recoverDevice(backend, { words, graphs: [bytes] }),
    ).rejects.toBeInstanceOf(DeviceRevokedError);
  });

  it("refuses a recovery key this browser knows was revoked", async () => {
    const backend = new MemoryBackend();
    const { words, bytes, seedB } = await account(backend);
    const graph = PersonGraph.decode(bytes);
    const key = graph.devices().find((d) => d.recovery)!.pub;
    graph.revoke(seedB, key);
    await backend.mergeGraph(graph.encode(), (_, incoming) => incoming);
    graph.free();

    await expect(
      recoverDevice(backend, { words, graphs: [bytes] }),
    ).rejects.toThrow(/was revoked/);
  });
});

describe("recoveredOwnerKey", () => {
  it("finds nothing in a project that sealed no share to the key", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed } = await localIdentity(backend);
    const words = await createRecoveryKey(backend);
    const link = LinkSecret.generateEdit();
    const { message } = ProjectGroup.create(
      link,
      encodeProfile({ name: "Ada", color: "#1d4ed8" }),
      deviceSeed,
      (await backend.loadGraph())!,
    );
    // Shares to the recovery key only go in with the creator's first
    // refresh, which this project never had.
    expect(recoveredOwnerKey(words, link, message)).toBeUndefined();
  });
});

describe("keepOwnerKey", () => {
  function ownerSecrets(): Uint8Array {
    const seed = DeviceKey.generate().export();
    const { group } = ProjectGroup.create(
      LinkSecret.generateEdit(),
      encodeProfile({ name: "Ada", color: "#1d4ed8" }),
      seed,
      PersonGraph.genesis(seed).encode(),
    );
    const secrets = group.ownerSecrets()!;
    group.free();
    return secrets;
  }

  it("adds the keys to what is stored for the project", async () => {
    const backend = new MemoryBackend();
    const device = new Uint8Array([1, 2]);
    await backend.saveMls("p", {
      state: null,
      device,
      removed: false,
      rotation: null,
    });
    const [one, two] = [ownerSecrets(), ownerSecrets()];
    await keepOwnerKey(backend, "p", one);
    await keepOwnerKey(backend, "q", two);
    expect(await backend.loadMls("p")).toMatchObject({
      device,
      ownerSecrets: one,
    });
    expect(await backend.loadMls("q")).toMatchObject({
      state: null,
      ownerSecrets: two,
    });
    // A second one goes in beside the first, which stays.
    await keepOwnerKey(backend, "p", two);
    const both = (await backend.loadMls("p"))!.ownerSecrets!;
    expect(mergeOwnerSecrets(both, one)).toEqual(both);
    expect(mergeOwnerSecrets(both, two)).toEqual(both);
    expect(both).not.toEqual(one);
  });
});
