import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeviceKey,
  LinkSecret,
  PersonGraph,
  SpaceGroup,
  RecoveryKey,
  mergeOwnerSecrets,
} from "@/crypto/wasm";
import { loadBinding, saveBinding } from "@/directory/binding";
import { waitForDirectorySync } from "@/directory/service";
import { directory, resetDirectory } from "@/directory/store";
import { fetchMlsBootstrap, resolveShare } from "@/sync/api";
import { toHex } from "@/crypto/bytes";
import { MemoryBackend } from "@/persist/local-doc-store";
import {
  encodeProfile,
  loadIdentity,
  resetIdentityCache,
} from "@/presence/identity";

import { FakeServer } from "./fake-server";
import { localDeviceKey, localIdentity, mergeOwnGraph } from "./identity";
import {
  createRecoveryKey,
  recoverFromLink,
  DeviceRevokedError,
  recoverDevice,
  recoveredOwnerKey,
  RecoveryError,
} from "./recovery";
import { cleanAll } from "./revoke";
import { keepOwnerKey, MlsSession } from "./session";

const mocks = vi.hoisted(() => ({ ensureSpace: vi.fn() }));
vi.mock("@/directory/ensure-space", () => ({
  ensureSpace: mocks.ensureSpace,
}));
vi.mock("@/directory/service", () => ({
  refreshDirectoryService: vi.fn(async () => {}),
  stopDirectoryService: vi.fn(),
  waitForDirectorySync: vi.fn(async () => "synced"),
}));
vi.mock("./revoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./revoke")>()),
  cleanAll: vi.fn(async () => ({ personal: { status: "none" }, projects: [] })),
}));
vi.mock("@/sync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/sync/api")>()),
  resolveShare: vi.fn(),
  fetchMlsBootstrap: vi.fn(),
}));

beforeEach(() => {
  mocks.ensureSpace.mockResolvedValue({
    spaceId: "personal",
    token: "t".repeat(22),
    secret: LinkSecret.generateEdit().toBase64url(),
  });
});

afterEach(async () => {
  localStorage.clear();
  resetIdentityCache();
  mocks.ensureSpace.mockReset();
  await resetDirectory();
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

  it("makes sure the personal space exists first", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    await createRecoveryKey(backend);
    expect(mocks.ensureSpace).toHaveBeenCalledTimes(1);
  });

  it("makes no key when the space cannot be made", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    mocks.ensureSpace.mockRejectedValue(new Error("offline"));
    await expect(createRecoveryKey(backend)).rejects.toThrow(/offline/);
    const graph = PersonGraph.decode((await backend.loadGraph())!);
    const recovery = graph.devices().filter((d) => d.recovery);
    graph.free();
    expect(recovery).toHaveLength(0);
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
    const { message } = SpaceGroup.create(
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
    const { group } = SpaceGroup.create(
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

describe("recoverFromLink", () => {
  /** A project or space of the person, opened once so its leaf holds the shares. */
  async function ownedSpace(
    backend: MemoryBackend,
    n: number,
    pointer: { token: string; secret: string } | undefined,
    sealed = true,
  ) {
    const link = LinkSecret.generateEdit();
    const secret = link.toBase64url();
    const { deviceSeed, graph } = await localIdentity(backend);
    const { group, message } = SpaceGroup.create(
      link,
      encodeProfile({ name: "Ada", color: "#1d4ed8" }),
      deviceSeed,
      graph,
    );
    const token = `${n}`.repeat(22);
    const server = new FakeServer({ edit: token, view: `v${token}` });
    server.seed(message);
    const spaceId = `space-${n}`;
    await backend.saveMls(spaceId, {
      state: group.exportState(),
      device: group.leafKeys().export(),
      removed: false,
      rotation: null,
      ownerPerson: group.ownerPerson(),
      ownerSecrets: group.ownerSecrets(),
    });
    const session = new MlsSession({
      spaceId,
      backend,
      fetchBootstrap: server.bootstrap,
      identity: () => ({ name: "Ada", color: "#1d4ed8" }),
      createDs: server.connect,
      createChannel: () => null,
      localIdentity: () => localIdentity(backend),
      mergeGraph: (g) => mergeOwnGraph(backend, g),
      personSpace: () => pointer,
      jitter: () => 0,
      silenceMs: 100,
      profileDelayMs: 0,
    });
    await session.start({ token, link: secret });
    // The refresh that seals the shares to the recovery key.
    if (sealed) await vi.waitFor(() => expect(server.head).toBe(1));
    session.stop();
    return { spaceId, token, secret, server };
  }

  async function world() {
    const first = new MemoryBackend();
    await localIdentity(first);
    const words = await createRecoveryKey(first);
    const space = await ownedSpace(first, 1, undefined);
    const pointer = { token: space.token, secret: space.secret };
    const one = await ownedSpace(first, 2, pointer);
    const two = await ownedSpace(first, 3, pointer);
    // Someone else's project the person only edits in.
    const stranger = new MemoryBackend();
    await localIdentity(stranger);
    const theirs = await ownedSpace(stranger, 4, undefined, false);
    const servers = [space, one, two, theirs];
    vi.mocked(fetchMlsBootstrap).mockImplementation(async (token) => {
      for (const s of servers) {
        const boot = await s.server.bootstrap(token);
        if (boot) return boot;
      }
      return null;
    });
    vi.mocked(resolveShare).mockImplementation(async (token) => {
      const found = servers.find((s) => s.token === token);
      return found ? { spaceId: found.spaceId, permission: "write" } : null;
    });
    const dir = await directory();
    for (const [i, p] of [one, two, theirs].entries())
      dir.addLink({
        token: p.token,
        projectId: p.spaceId,
        secret: p.secret,
        edit: true,
        addedAt: 100 + i,
      });
    return { words, space, one, two, theirs, pointer, first };
  }

  const linkOf = (p: { token: string; secret: string }) =>
    `https://typstry.test/p/${p.token}#${p.secret}`;

  it("brings back the binding, the space's owner key and every owned project's", async () => {
    const { words, space, one, two, theirs, pointer } = await world();
    const fresh = new MemoryBackend();
    const out = await recoverFromLink(fresh, { words, link: linkOf(one) });

    expect(out.projects).toBe(2);
    expect(loadBinding()).toEqual({ spaceId: space.spaceId, ...pointer });
    expect((await fresh.loadMls(space.spaceId))?.ownerSecrets).toBeDefined();
    expect((await fresh.loadMls(one.spaceId))?.ownerSecrets).toBeDefined();
    expect((await fresh.loadMls(two.spaceId))?.ownerSecrets).toBeDefined();
    expect((await fresh.loadMls(theirs.spaceId))?.ownerSecrets).toBeUndefined();
    expect(cleanAll).toHaveBeenCalledTimes(1);
  });

  it("warns while the project list is not secured", async () => {
    const { words, one } = await world();
    vi.mocked(cleanAll).mockResolvedValueOnce({
      personal: { status: "unreached", reason: "the server did not answer" },
      projects: [],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recoverFromLink(new MemoryBackend(), { words, link: linkOf(one) });
    expect(cleanAll).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "could not secure the project list, projects not cleaned",
    );
    warn.mockRestore();
  });

  it("does not remove the other devices when asked to keep them", async () => {
    const { words, one } = await world();
    await recoverFromLink(new MemoryBackend(), {
      words,
      link: linkOf(one),
      keepOthers: true,
    });
    expect(cleanAll).not.toHaveBeenCalled();
  });

  it("keeps the single project recovery when the space cannot be reached", async () => {
    const { words, space, one, two } = await world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = vi.mocked(fetchMlsBootstrap).getMockImplementation()!;
    vi.mocked(fetchMlsBootstrap).mockImplementation(async (token, opts) =>
      token === space.token ? null : real(token, opts),
    );
    const fresh = new MemoryBackend();
    const out = await recoverFromLink(fresh, { words, link: linkOf(one) });

    expect(out.projects).toBe(0);
    expect(loadBinding()).toBeNull();
    expect((await fresh.loadMls(one.spaceId))?.ownerSecrets).toBeDefined();
    expect(await fresh.loadMls(two.spaceId)).toBeNull();
    expect(await fresh.loadDeviceKey()).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("recovers a project that points nowhere as before", async () => {
    const { words, space } = await world();
    // The space itself carries no pointer.
    const fresh = new MemoryBackend();
    const out = await recoverFromLink(fresh, { words, link: linkOf(space) });
    expect(out.projects).toBe(0);
    expect(loadBinding()).toBeNull();
    expect((await fresh.loadMls(space.spaceId))?.ownerSecrets).toBeDefined();
  });

  it("restores nothing when the only pointer is not the person's space", async () => {
    const { words, theirs, first } = await world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A leaf can carry any pointer; this one leads to a space whose owner
    // key was never sealed to the recovery key.
    const bad = await ownedSpace(first, 8, {
      token: theirs.token,
      secret: theirs.secret,
    });
    const realBoot = vi.mocked(fetchMlsBootstrap).getMockImplementation()!;
    vi.mocked(fetchMlsBootstrap).mockImplementation(
      async (token, opts) =>
        (await bad.server.bootstrap(token)) ?? realBoot(token, opts),
    );
    const realShare = vi.mocked(resolveShare).getMockImplementation()!;
    vi.mocked(resolveShare).mockImplementation(async (token, opts) =>
      token === bad.token
        ? { spaceId: bad.spaceId, permission: "write" }
        : realShare(token, opts),
    );
    const fresh = new MemoryBackend();
    const out = await recoverFromLink(fresh, { words, link: linkOf(bad) });
    expect(out.projects).toBe(0);
    expect(loadBinding()).toBeNull();
    expect(cleanAll).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    // The project itself is still recovered.
    expect((await fresh.loadMls(bad.spaceId))?.ownerSecrets).toBeDefined();
  });

  it("skips a directory entry whose token leads to another project", async () => {
    const { words, one, two } = await world();
    const real = vi.mocked(resolveShare).getMockImplementation()!;
    vi.mocked(resolveShare).mockImplementation(async (token, opts) => {
      const share = await real(token, opts);
      return share && token === two.token
        ? { ...share, spaceId: "someone-elses" }
        : share;
    });
    const fresh = new MemoryBackend();
    const out = await recoverFromLink(fresh, { words, link: linkOf(one) });
    expect(out.projects).toBe(1);
    expect(await fresh.loadMls(two.spaceId)).toBeNull();
  });

  it("starts from an empty directory when replacing an identity", async () => {
    const { words, one, two, theirs } = await world();
    const dir = await directory();
    dir.addLink({
      token: "j".repeat(22),
      projectId: "abandoned",
      secret: LinkSecret.generateEdit().toBase64url(),
      edit: true,
      addedAt: 50,
    });
    dir.addOwnerKey("abandoned", new Uint8Array(32).fill(5), 50);
    // What the first sync of the recovered person's space delivers.
    vi.mocked(waitForDirectorySync).mockImplementationOnce(async () => {
      const synced = await directory();
      for (const [i, p] of [one, two, theirs].entries())
        synced.addLink({
          token: p.token,
          projectId: p.spaceId,
          secret: p.secret,
          edit: true,
          addedAt: 100 + i,
        });
      return "synced";
    });
    // The abandoned person's binding must not survive into the new one.
    saveBinding({
      spaceId: "old",
      token: "o".repeat(22),
      secret: LinkSecret.generateEdit().toBase64url(),
    });
    const out = await recoverFromLink(new MemoryBackend(), {
      words,
      link: linkOf(one),
      replace: true,
    });
    const after = await directory();
    expect(after.list(Date.now()).map((e) => e.projectId)).not.toContain(
      "abandoned",
    );
    expect(after.ownerKeys("abandoned", Date.now())).toEqual([]);
    expect(out.projects).toBe(2);
  });
});
