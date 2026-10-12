import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkSecret, ProjectGroup } from "@/crypto/wasm";
import {
  MemoryBackend,
  type DocBackend,
  type StoredRotation,
} from "@/persist/local-doc-store";
import { encodeProfile, type Identity } from "@/presence/identity";

import { FakeServer } from "./fake-server";
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

function world() {
  const link = LinkSecret.generateEdit();
  const editSecret = link.toBase64url();
  const viewSecret = link.viewSecret();
  const { group, message } = ProjectGroup.create(
    link,
    encodeProfile({ name: "Alice", color }),
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
    await backend.saveMls("p", {
      state: group.exportState(),
      device: group.device().export(),
      removed: false,
      rotation: null,
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

  return { server, creator, join, device, editSecret, viewSecret, sessions };
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

    // Bob's reply is lost and his commit never lands; Alice's does.
    server.loseNextReply = { landed: false };
    const bobs = bob.session.resetLinks();
    await alice.session.resetLinks();
    await bobs;
    // Both rotations happened, one after the other, none twice.
    expect(server.head).toBe(3);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
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
