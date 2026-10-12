import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceKey,
  LinkSecret,
  PersonGraph,
  ProjectGroup,
  RecoveryKey,
  devicePublicKey,
  graphsInGroupInfo,
  mergeOwnerSecrets,
} from "@/crypto/wasm";
import {
  MemoryBackend,
  type DocBackend,
  type StoredRotation,
} from "@/persist/local-doc-store";
import { encodeProfile, type Identity } from "@/presence/identity";

import { FakeServer } from "./fake-server";
import { localIdentity, mergeOwnGraph } from "./identity";
import { keepOwnerKey, recoverDevice, recoveredOwnerKey } from "./recovery";
import { MlsSession, type MlsSessionOptions } from "./session";

const EDIT = "edit-1";
const VIEW = "view-1";

const color = "#1d4ed8";

/** A broadcast channel that reaches only the others on the same bus. */
class Bus {
  private readonly members = new Set<FakeChannel>();
  channel(): BroadcastChannel {
    const channel = new FakeChannel(this.members);
    this.members.add(channel);
    return channel as unknown as BroadcastChannel;
  }
}

class FakeChannel {
  onmessage: ((event: unknown) => void) | null = null;
  private readonly members: Set<FakeChannel>;
  constructor(members: Set<FakeChannel>) {
    this.members = members;
  }
  postMessage(data: unknown) {
    for (const other of this.members)
      if (other !== this) queueMicrotask(() => other.onmessage?.({ data }));
  }
  close() {
    this.members.delete(this);
  }
}

interface Device {
  session: MlsSession;
  backend: DocBackend;
  rotations: StoredRotation[];
  keyrings: Uint8Array[];
  errors: Error[];
  identity: Identity;
}

function world({ recovery = false } = {}) {
  const link = LinkSecret.generateEdit();
  const editSecret = link.toBase64url();
  const viewSecret = link.viewSecret();
  const aliceKey = DeviceKey.generate();
  const aliceSeed = aliceKey.export();
  const aliceGraph = PersonGraph.genesis(aliceSeed);
  const recoveryKey = recovery ? RecoveryKey.generate() : null;
  if (recoveryKey)
    aliceGraph.addDevice(
      aliceSeed,
      devicePublicKey(recoveryKey.deviceSeed),
      true,
    );
  const { group, message } = ProjectGroup.create(
    link,
    encodeProfile({ name: "Alice", color }),
    aliceSeed,
    aliceGraph.encode(),
  );
  const server = new FakeServer({ edit: EDIT, view: VIEW });
  server.seed(message);

  const sessions: MlsSession[] = [];
  function device(
    name: string,
    opts: {
      backend?: DocBackend;
      bus?: Bus;
      options?: Partial<MlsSessionOptions>;
    } = {},
  ): Device {
    const backend = opts.backend ?? new MemoryBackend();
    const rotations: StoredRotation[] = [];
    const keyrings: Uint8Array[] = [];
    const errors: Error[] = [];
    const out = { identity: { name, color } } as Device;
    out.session = new MlsSession({
      projectId: "p",
      backend,
      fetchBootstrap: server.bootstrap,
      identity: () => out.identity,
      createDs: server.connect,
      createChannel: () => opts.bus?.channel() ?? null,
      onRotated: (r) => rotations.push(r),
      onKeyring: (k) => keyrings.push(k),
      onError: (e) => errors.push(e),
      jitter: () => 0,
      silenceMs: 100,
      profileDelayMs: 0,
      localIdentity: () => localIdentity(backend),
      mergeGraph: (graph) => mergeOwnGraph(backend, graph),
      ...opts.options,
    });
    sessions.push(out.session);
    Object.assign(out, { backend, rotations, keyrings, errors });
    return out;
  }

  /** The creator's browser, which kept the group `create` made. */
  async function creator(
    opts: { bus?: Bus; options?: Partial<MlsSessionOptions> } = {},
  ): Promise<Device> {
    const backend = new MemoryBackend();
    await backend.saveDeviceKey(aliceSeed);
    await backend.mergeGraph(aliceGraph.encode(), (_, incoming) => incoming);
    await backend.saveMls("p", {
      state: group.exportState(),
      device: group.leafKeys().export(),
      removed: false,
      rotation: null,
      ownerPerson: group.ownerPerson(),
      ownerSecrets: group.ownerSecrets(),
    });
    const d = device("Alice", { backend, ...opts });
    await d.session.start({ token: EDIT, link: editSecret });
    return d;
  }

  async function join(
    name: string,
    as: "edit" | "view",
    opts: { backend?: DocBackend; bus?: Bus } = {},
  ): Promise<Device> {
    const token = as === "edit" ? EDIT : VIEW;
    const secret = as === "edit" ? editSecret : viewSecret;
    const d = device(name, opts);
    await d.session.start({ token, link: secret });
    return d;
  }

  /**
   * A second browser of Alice's: its device key is added to her graph and
   * both are stored the way pairing leaves them. `backend` is one that
   * already has a key, e.g. a browser that opened a link before pairing.
   */
  async function pairedWithAlice(
    alice: Device,
    backend: DocBackend = new MemoryBackend(),
  ): Promise<{ backend: DocBackend; pub: Uint8Array }> {
    let seed = await backend.loadDeviceKey();
    if (!seed) {
      seed = DeviceKey.generate().export();
      await backend.saveDeviceKey(seed);
    }
    const pub = devicePublicKey(seed);
    const { graph } = await localIdentity(alice.backend);
    const next = PersonGraph.decode(graph);
    next.addDevice(aliceSeed, pub);
    await mergeOwnGraph(alice.backend, next.encode());
    await backend.mergeGraph(next.encode(), (_, incoming) => incoming);
    return { backend, pub };
  }

  return {
    server,
    creator,
    join,
    device,
    editSecret,
    viewSecret,
    sessions,
    aliceSeed,
    pairedWithAlice,
    recoveryWords: recoveryKey?.words ?? "",
  };
}

const names = (d: Device) =>
  d.session
    .getSnapshot()
    .members.map((m) => m.name)
    .sort();

afterEach(() => vi.restoreAllMocks());

describe("MlsSession", () => {
  it("lets the creator follow the group it made", async () => {
    const { creator, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().phase).toBe("active"),
    );
    expect(alice.session.keys()).not.toBeNull();
    expect(names(alice)).toEqual(["Alice"]);
    expect(alice.session.getSnapshot().canCommit).toBe(false);
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    sessions.forEach((s) => s.stop());
  });

  it("joins a new device with an external commit that others see", async () => {
    const { creator, join, sessions } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    expect(bob.session.getSnapshot().phase).toBe("joining");

    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Bob"]));
    expect(names(bob)).toEqual(["Alice", "Bob"]);
    expect(bob.session.getSnapshot().members.find((m) => m.isSelf)?.role).toBe(
      "editor",
    );
    expect(bob.session.keys()?.generation).toBe(1);
    expect(bob.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("joins with the view link as a viewer who cannot commit", async () => {
    const { creator, join, sessions } = world();
    const alice = await creator();
    const carol = await join("Carol", "view");
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Carol"]));
    expect(
      carol.session.getSnapshot().members.find((m) => m.isSelf)?.role,
    ).toBe("viewer");
    expect(carol.session.getSnapshot().canCommit).toBe(false);
    await expect(carol.session.resetLinks()).rejects.toThrow();
    sessions.forEach((s) => s.stop());
  });

  it("settles devices that join at the same moment", async () => {
    const { creator, join, sessions } = world();
    const alice = await creator();
    const [bob, carol] = await Promise.all([
      join("Bob", "edit"),
      join("Carol", "view"),
    ]);
    for (const d of [alice, bob, carol])
      await vi.waitFor(
        () => expect(names(d)).toEqual(["Alice", "Bob", "Carol"]),
        {
          timeout: 3000,
        },
      );
    expect([alice, bob, carol].flatMap((d) => d.errors)).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("removes a member and moves the others to the new links", async () => {
    const { creator, join, server, sessions } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    const carol = await join("Carol", "view");
    for (const d of [alice, bob, carol])
      await vi.waitFor(() =>
        expect(d.session.getSnapshot().members).toHaveLength(3),
      );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );

    const carolSigner = alice.session
      .getSnapshot()
      .members.find((m) => m.name === "Carol")!.signer;
    await alice.session.removeMembers([carolSigner]);

    // The remover switches right away, with the tokens it chose.
    expect(alice.rotations).toHaveLength(1);
    expect(alice.keyrings).toHaveLength(1);
    const [rotation] = alice.rotations;
    expect(rotation!.canEdit).toBe(true);
    expect(rotation!.token).not.toBe(EDIT);
    expect(server.live.has(rotation!.token)).toBe(true);
    expect(server.retired.has(EDIT)).toBe(true);

    // The remaining editor is handed the same links by the group.
    await vi.waitFor(() => expect(bob.rotations).toHaveLength(1));
    expect(bob.rotations[0]).toEqual(rotation);
    await vi.waitFor(() => expect(bob.keyrings).toHaveLength(1));
    expect(bob.session.keys()?.generation).toBe(2);
    expect(names(bob)).toEqual(["Alice", "Bob"]);

    // The removed one learns it, and has no keys left.
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("removed"),
    );
    expect(carol.session.keys()).toBeNull();
    expect(carol.rotations).toEqual([]);

    // Editors keep working on the new links.
    await alice.session.resetLinks();
    await vi.waitFor(() => expect(bob.rotations).toHaveLength(2));

    // A fresh link is the way back in for the removed device.
    const fresh = alice.rotations.at(-1)!;
    await carol.session.start({
      token: fresh.viewToken!,
      link: LinkSecret.parse(fresh.link).viewSecret(),
    });
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(names(alice)).toEqual(["Alice", "Bob", "Carol"]),
    );
    sessions.forEach((s) => s.stop());
  });

  it("follows a rotation it missed through its retired token", async () => {
    const { creator, join, sessions, editSecret } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    // Bob closes the tab; links rotate twice meanwhile.
    bob.session.stop();
    await alice.session.resetLinks();
    await alice.session.resetLinks();
    const latest = alice.rotations.at(-1)!;

    // He opens the link he had, which is retired by now.
    await bob.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() => expect(bob.rotations.length).toBeGreaterThan(0));
    expect(bob.rotations.at(-1)).toEqual(latest);
    // The keyring comes once, after the last commit.
    await vi.waitFor(() => expect(bob.keyrings).toHaveLength(1));
    expect(bob.session.keys()?.generation).toBe(3);
    sessions.forEach((s) => s.stop());
  });

  it("hops from token to token when it was offline across several rotations", async () => {
    const { creator, join, server, sessions, editSecret } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    bob.session.stop();
    await alice.session.resetLinks();
    await alice.session.resetLinks();
    await alice.session.resetLinks();
    const first = alice.rotations[0]!;
    const latest = alice.rotations.at(-1)!;

    // A retired token reads the log only up to its own rotation.
    const hellosBefore = server.hellos;
    await bob.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() => expect(bob.rotations.at(-1)).toEqual(latest));
    // Only the links that work are announced, not the retired ones on the
    // way, which the page would try to open.
    expect(bob.rotations).toEqual([latest]);
    expect(first).not.toEqual(latest);
    expect(server.hellos - hellosBefore).toBeGreaterThanOrEqual(3);
    await vi.waitFor(() => expect(bob.keyrings).toHaveLength(1));
    expect(bob.session.keys()?.generation).toBe(4);
    expect(bob.session.getSnapshot().phase).toBe("active");
    expect(bob.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("says the link was replaced when a retired token leads nowhere", async () => {
    const { creator, join, server, sessions, editSecret } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    bob.session.stop();
    await alice.session.resetLinks();
    // The rotation fell out of the log, so the old token cannot say where
    // the project went.
    server.prune(server.head);

    await bob.session.start({ token: EDIT, link: editSecret });
    // Bob's group is still there, but nothing can sync for these links.
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("lost"),
    );
    expect(bob.rotations).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("says the link was replaced when the server no longer knows the token", async () => {
    const { creator, server, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().phase).toBe("active"),
    );
    // A new session on a token the server has forgotten, with the group
    // already on this device.
    const again = alice.session;
    again.stop();
    server.live.clear();
    await again.start({ token: "gone", link: "AA" });
    await vi.waitFor(() => expect(again.getSnapshot().phase).toBe("lost"));
    sessions.forEach((s) => s.stop());
  });

  it("rejoins as the same device when the log no longer reaches it", async () => {
    const { creator, join, server, sessions, editSecret } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    bob.session.stop();
    const carol = await join("Carol", "view");
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(3),
    );
    // Everything before the head is pruned, so Bob cannot catch up.
    server.prune(server.head);

    await bob.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(
      () =>
        expect(
          bob.session
            .getSnapshot()
            .members.map((m) => m.name)
            .sort(),
        ).toEqual(["Alice", "Bob", "Carol"]),
      { timeout: 3000 },
    );
    // His old leaf was replaced rather than left behind.
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(3),
    );
    expect(bob.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("settles a rotation whose reply was lost from the log instead of discarding it", async () => {
    const { creator, server, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );

    // The commit is stored before it is sent, with the links it rotates to.
    let storedPending = false;
    server.onSubmit = async () => {
      const record = await alice.backend.loadMls("p");
      storedPending =
        ProjectGroup.importState(record!.state!).pendingSubmit() !== undefined;
    };
    server.loseNextReply = { landed: true };
    const epoch = server.head;
    await alice.session.resetLinks();

    expect(storedPending).toBe(true);
    // Exactly one rotation, and the new links are the ones the server has.
    expect(server.head).toBe(epoch + 1);
    expect(alice.rotations).toHaveLength(1);
    expect(server.live.has(alice.rotations[0]!.token)).toBe(true);
    expect(alice.keyrings).toHaveLength(1);
    expect(alice.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("sends a commit again when it never reached the server", async () => {
    const { creator, server, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );

    server.loseNextReply = { landed: false };
    const epoch = server.head;
    await alice.session.resetLinks();

    expect(server.head).toBe(epoch + 1);
    expect(alice.rotations).toHaveLength(1);
    expect(server.live.has(alice.rotations[0]!.token)).toBe(true);
    // The group carries on at the new epoch with nothing left waiting.
    const stored = await alice.backend.loadMls("p");
    const group = ProjectGroup.importState(stored!.state!);
    expect(group.pendingSubmit()).toBeUndefined();
    expect(group.epoch).toBe(epoch + 1);
    sessions.forEach((s) => s.stop());
  });

  it("drops its commit when another member's wins the epoch", async () => {
    const { creator, join, server, sessions } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().canCommit).toBe(true),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    // Alice's reply is lost and her commit never lands; Bob's does.
    server.loseNextReply = { landed: false };
    const alices = alice.session.resetLinks();
    bob.identity = { name: "Robert", color };
    bob.session.updateProfile();
    await alices;
    await vi.waitFor(() => expect(server.head).toBe(3));
    // Both commits happened, one after the other, none twice.
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("lets only the owner remove members or reset the links", async () => {
    const { creator, join, sessions } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().canCommit).toBe(true),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );
    const roleOf = (d: Device) =>
      d.session.getSnapshot().members.find((m) => m.isSelf)?.role;
    expect(roleOf(alice)).toBe("owner");
    expect(roleOf(bob)).toBe("editor");

    const alicesSigner = alice.session
      .getSnapshot()
      .members.find((m) => m.isSelf)!.signer;
    await expect(bob.session.resetLinks()).rejects.toMatchObject({
      kind: "NotOwner",
    });
    await expect(
      bob.session.removeMembers([alicesSigner]),
    ).rejects.toMatchObject({ kind: "NotOwner" });
    sessions.forEach((s) => s.stop());
  });

  it("stays the owner through a reset of the links", async () => {
    const { creator, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    await alice.session.resetLinks();
    expect(alice.session.getSnapshot().members[0]!.role).toBe("owner");
    expect((await alice.backend.loadMls("p"))?.ownerPerson).toBeDefined();
    sessions.forEach((s) => s.stop());
  });

  it("makes a paired device of the owner an owner and one person", async () => {
    const { creator, device, pairedWithAlice, editSecret, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    const { backend } = await pairedWithAlice(alice);
    const second = device("Alice 2", { backend });
    await second.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Alice 2"]));
    const members = alice.session.getSnapshot().members;
    expect(members.every((m) => m.role === "owner")).toBe(true);
    expect(members[0]!.person).not.toBeNull();
    expect(members[0]!.person).toBe(members[1]!.person);
    sessions.forEach((s) => s.stop());
  });

  it("joins again as the person it paired into after opening the link first", async () => {
    const { creator, join, pairedWithAlice, sessions } = world();
    const alice = await creator();
    const desk = await join("Desk", "edit");
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );
    const persons = () =>
      new Set(alice.session.getSnapshot().members.map((m) => m.person));
    expect(persons().size).toBe(2);

    // Pairing into Alice's person, the way a grant with `replace` leaves it.
    await pairedWithAlice(alice, desk.backend);

    await desk.session.syncIdentity();
    await vi.waitFor(() => {
      expect(alice.session.getSnapshot().members).toHaveLength(2);
      expect(persons().size).toBe(1);
    });
    expect(desk.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("does not merge an unchanged group graph into storage again", async () => {
    const { device, editSecret, sessions } = world();
    const backend = new MemoryBackend();
    const merges = vi.fn((graph: Uint8Array) => mergeOwnGraph(backend, graph));
    const alice = device("Alice", { backend, options: { mergeGraph: merges } });
    await alice.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().phase).toBe("active"),
    );
    await alice.session.syncIdentity();
    const before = merges.mock.calls.length;
    await alice.session.syncIdentity();
    await alice.session.syncIdentity();
    expect(merges).toHaveBeenCalledTimes(before);
    sessions.forEach((s) => s.stop());
  });

  it("removes a revoked device of its own person and rotates the links", async () => {
    const { creator, device, pairedWithAlice, editSecret, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    const { backend, pub } = await pairedWithAlice(alice);
    const second = device("Alice 2", { backend });
    await second.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Alice 2"]));
    // Offline for both the refresh and the removal, so it only ever sees
    // the commit that removes it.
    second.session.stop();

    const { deviceSeed, graph } = await localIdentity(alice.backend);
    const revoked = PersonGraph.decode(graph);
    revoked.revoke(deviceSeed, pub);
    await mergeOwnGraph(alice.backend, revoked.encode());

    const done = await alice.session.syncIdentity();
    expect(done).toEqual({ canCommit: true });
    expect(alice.session.getSnapshot().holdsOwnerKey).toBe(true);
    expect(alice.session.removedLeaves).toBe(1);
    expect(names(alice)).toEqual(["Alice"]);
    expect(alice.rotations).toHaveLength(1);
    await second.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(second.session.getSnapshot().phase).toBe("removed"),
    );
    // Being removed is how the revoked device hears of its revoke.
    await vi.waitFor(async () => {
      const { graph } = await localIdentity(backend);
      expect(PersonGraph.decode(graph).deviceState(pub)).toBe("revoked");
    });
    sessions.forEach((s) => s.stop());
  });

  it("hands the owner key to a paired owner device, which can then reset the links", async () => {
    const { creator, device, pairedWithAlice, editSecret, server, sessions } =
      world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().holdsOwnerKey).toBe(true),
    );
    const { backend } = await pairedWithAlice(alice);
    // Away while the second device joins, so nobody hands the key over yet.
    alice.session.stop();
    const second = device("Alice 2", { backend });
    await second.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(second.session.getSnapshot().canCommit).toBe(true),
    );
    expect(second.session.getSnapshot().members[0]!.role).toBe("owner");
    expect(second.session.getSnapshot().holdsOwnerKey).toBe(false);
    await expect(second.session.resetLinks()).rejects.toMatchObject({
      kind: "NoOwnerKey",
    });

    // Opening the project on the device that holds the key hands it over.
    await alice.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(second.session.getSnapshot().holdsOwnerKey).toBe(true),
    );
    expect(
      (await backend.loadMls("p"))?.ownerSecrets?.length ?? 0,
    ).toBeGreaterThan(0);
    await second.session.resetLinks();
    expect(second.rotations).toHaveLength(1);
    expect(server.notOwner).toBe(0);
    // The rotation moved the owner key on, and the other device follows.
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().holdsOwnerKey).toBe(true),
    );
    await alice.session.resetLinks();
    expect(server.notOwner).toBe(0);
    sessions.forEach((s) => s.stop());
  });

  it("brings the owner key along when it rejoins after losing its state", async () => {
    const { creator, device, editSecret, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    alice.session.stop();
    const record = (await alice.backend.loadMls("p"))!;
    await alice.backend.saveMls("p", { ...record, state: null });

    const again = device("Alice", { backend: alice.backend });
    await again.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(again.session.getSnapshot().canCommit).toBe(true),
    );
    expect(again.session.getSnapshot().holdsOwnerKey).toBe(true);
    await again.session.resetLinks();
    expect(again.rotations).toHaveLength(1);
    sessions.forEach((s) => s.stop());
  });

  it("keeps the real owner key when the server names another", async () => {
    const { creator, device, editSecret, server, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().holdsOwnerKey).toBe(true),
    );
    alice.session.stop();
    const real = server.ownerKey;
    const kept = (await alice.backend.loadMls("p"))!.ownerSecrets!;
    // A key this device holds that the server does not name now, as one it
    // was told was current once would be.
    const seed = DeviceKey.generate().export();
    const { group: other } = ProjectGroup.create(
      LinkSecret.generateEdit(),
      encodeProfile({ name: "Other", color }),
      seed,
      PersonGraph.genesis(seed).encode(),
    );
    const extra = other.ownerSecrets()!;
    other.free();
    await keepOwnerKey(alice.backend, "p", extra);

    // The server names a key of its own making while the device has to
    // join again: the device cannot rotate, but loses nothing.
    server.ownerKey = DeviceKey.generate().publicKey();
    const record = (await alice.backend.loadMls("p"))!;
    await alice.backend.saveMls("p", { ...record, state: null });
    const lied = device("Alice", { backend: alice.backend });
    await lied.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(lied.session.getSnapshot().canCommit).toBe(true),
    );
    expect(lied.session.getSnapshot().holdsOwnerKey).toBe(false);
    lied.session.stop();
    const after = (await alice.backend.loadMls("p"))!;
    expect(mergeOwnerSecrets(after.ownerSecrets, kept)).toEqual(
      after.ownerSecrets,
    );

    // Once the server tells the truth again, the key is there to use.
    server.ownerKey = real;
    await alice.backend.saveMls("p", { ...after, state: null });
    const again = device("Alice", { backend: alice.backend });
    await again.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(again.session.getSnapshot().holdsOwnerKey).toBe(true),
    );
    await again.session.resetLinks();
    expect(server.notOwner).toBe(0);
    // Every save added to what was kept and dropped none of it.
    const last = (await alice.backend.loadMls("p"))!.ownerSecrets;
    for (const held of [kept, extra])
      expect(mergeOwnerSecrets(last, held)).toEqual(last);
    sessions.forEach((s) => s.stop());
  });

  it("drops a rotation the server refuses for a wrong owner key", async () => {
    const { creator, server, sessions } = world();
    const alice = await creator();
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );
    // As if another device had moved the key on behind this one's back.
    server.ownerKey = DeviceKey.generate().publicKey();
    const head = server.head;
    await expect(alice.session.resetLinks()).rejects.toThrow(/owner key/);
    expect(server.notOwner).toBe(1);
    expect(server.head).toBe(head);
    expect(alice.rotations).toEqual([]);
    expect(
      ProjectGroup.importState((await alice.backend.loadMls("p"))!.state!)
        .hasPendingSubmit,
    ).toBe(false);
    sessions.forEach((s) => s.stop());
  });

  it("leaves another person's revoked device to the owner, who removes it", async () => {
    const { creator, device, join, editSecret, sessions } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().canCommit).toBe(true),
    );
    // Bob's second device, paired into his person.
    const bobs = await localIdentity(bob.backend);
    const tablet = new MemoryBackend();
    const tabletSeed = DeviceKey.generate().export();
    await tablet.saveDeviceKey(tabletSeed);
    const tabletPub = devicePublicKey(tabletSeed);
    const paired = PersonGraph.decode(bobs.graph);
    paired.addDevice(bobs.deviceSeed, tabletPub);
    await mergeOwnGraph(bob.backend, paired.encode());
    await tablet.mergeGraph(paired.encode(), (_, incoming) => incoming);
    const bob2 = device("Bob 2", { backend: tablet });
    await bob2.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(names(alice)).toEqual(["Alice", "Bob", "Bob 2"]),
    );
    bob2.session.stop();
    // Alice is away while Bob revokes it.
    alice.session.stop();

    const revoked = PersonGraph.decode(
      (await localIdentity(bob.backend)).graph,
    );
    revoked.revoke(bobs.deviceSeed, tabletPub);
    await mergeOwnGraph(bob.backend, revoked.encode());
    const done = await bob.session.syncIdentity();
    expect(done).toEqual({ canCommit: true });
    expect(bob.session.getSnapshot().holdsOwnerKey).toBe(false);
    expect(bob.session.removedLeaves).toBe(0);
    await vi.waitFor(() =>
      expect(
        bob.session.getSnapshot().members.find((m) => m.name === "Bob 2")
          ?.deviceRevoked,
      ).toBe(true),
    );

    // The owner reads the revoke from Bob's leaf and sweeps the device.
    await alice.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Bob"]));
    expect(alice.session.removedLeaves).toBe(1);
    await vi.waitFor(() => expect(names(bob)).toEqual(["Alice", "Bob"]));
    sessions.forEach((s) => s.stop());
  });

  it("lets a device recovered with the recovery key remove the lost devices", async () => {
    const { creator, device, editSecret, server, sessions, recoveryWords } =
      world({ recovery: true });
    const alice = await creator();
    // Creating the project seals no share to the recovery key yet; opening
    // it does, in a refresh of the creator's leaf.
    await vi.waitFor(() => expect(server.head).toBe(1));
    // The only device is lost.
    alice.session.stop();

    const backend = new MemoryBackend();
    const link = LinkSecret.parse(editSecret);
    const boot = (await server.bootstrap(EDIT))!;
    const ownerKey = recoveredOwnerKey(recoveryWords, link, boot);
    expect(ownerKey).toBeDefined();
    await recoverDevice(backend, {
      words: recoveryWords,
      graphs: graphsInGroupInfo(link, boot.groupInfo, boot.keyring),
    });
    await keepOwnerKey(backend, "p", ownerKey!);

    const found = device("Found", { backend });
    await found.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() => expect(names(found)).toEqual(["Found"]));
    expect(found.session.getSnapshot().holdsOwnerKey).toBe(true);
    expect(found.session.removedLeaves).toBe(1);
    expect(found.rotations).toHaveLength(1);
    expect(server.notOwner).toBe(0);
    sessions.forEach((s) => s.stop());
  });

  it("removes by device key, and refuses a member who is gone", async () => {
    const { creator, join, server, sessions } = world();
    const alice = await creator();
    const carol = await join("Carol", "view");
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().canCommit).toBe(true),
    );

    const head = server.head;
    await expect(alice.session.removeMembers(["00ff"])).rejects.toThrow(
      /no longer in the project/,
    );
    // Nothing was committed on the way to that error.
    expect(server.head).toBe(head);
    expect(alice.session.getSnapshot().members).toHaveLength(2);
    sessions.forEach((s) => s.stop());
  });

  it("treats a commit it cannot process as a stalled group, not as a gap to rejoin", async () => {
    const { creator, join, server, sessions } = world();
    const alice = await creator();
    const carol = await join("Carol", "view");
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    const spy = vi
      .spyOn(ProjectGroup.prototype, "processCommit")
      .mockImplementation(() => {
        throw Object.assign(new Error("broken"), { kind: "Mls" });
      });
    const head = server.head;
    const dan = await join("Dan", "view");
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().stalled).toBe(true),
    );
    spy.mockRestore();
    // Carol is a viewer, so she waits for an editor instead of rejoining:
    // the epoch only moved for Dan's own join.
    expect(carol.session.getSnapshot().stalled).toBe(true);
    expect(server.head).toBe(head + 1);
    expect(dan.errors).toEqual([]);
    sessions.forEach((s) => s.stop());
  });

  it("carries a changed name into the roster", async () => {
    const { creator, join, sessions } = world();
    const alice = await creator();
    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().canCommit).toBe(true),
    );

    bob.identity = { name: "Robert", color };
    bob.session.updateProfile();
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Robert"]));
    expect(names(bob)).toEqual(["Alice", "Robert"]);
    sessions.forEach((s) => s.stop());
  });

  it("joins a viewer again with its new name, since viewers cannot commit", async () => {
    const { creator, join, sessions } = world();
    const alice = await creator();
    const carol = await join("Carol", "view");
    await vi.waitFor(() =>
      expect(carol.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(alice.session.getSnapshot().members).toHaveLength(2),
    );

    carol.identity = { name: "Caroline", color };
    carol.session.updateProfile();
    await vi.waitFor(() => expect(names(alice)).toEqual(["Alice", "Caroline"]));
    expect(names(carol)).toEqual(["Alice", "Caroline"]);
    sessions.forEach((s) => s.stop());
  });

  it("shares the stored group between tabs without applying a commit twice", async () => {
    const { creator, join, sessions, device, editSecret } = world();
    const bus = new Bus();
    const first = await creator({ bus });
    // A second tab of the same browser profile: same storage, same device.
    const second = device("Alice", { backend: first.backend, bus });
    await second.session.start({ token: EDIT, link: editSecret });
    await vi.waitFor(() =>
      expect(second.session.getSnapshot().phase).toBe("active"),
    );

    const bob = await join("Bob", "edit");
    await vi.waitFor(() =>
      expect(bob.session.getSnapshot().phase).toBe("active"),
    );
    await vi.waitFor(() =>
      expect(first.session.getSnapshot().members).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(second.session.getSnapshot().members).toHaveLength(2),
    );
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);

    // Both tabs agree with what is stored.
    const stored = await first.backend.loadMls("p");
    expect(stored?.state).not.toBeNull();
    sessions.forEach((s) => s.stop());
  });

  it("reports a project whose server has no group", async () => {
    const { server, device, sessions } = world();
    server.live.clear();
    const lone = device("Dan");
    await lone.session.start({ token: "gone", link: "AA" });
    await vi.waitFor(() =>
      expect(lone.session.getSnapshot().phase).toBe("unavailable"),
    );
    sessions.forEach((s) => s.stop());
  });
});
