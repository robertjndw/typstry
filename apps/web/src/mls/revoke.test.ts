import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceKey, LinkSecret, PersonGraph } from "@/crypto/wasm";
import { MemoryBackend } from "@/persist/local-doc-store";
import { directory } from "@/directory/store";
import { seedProject } from "@/directory/test-utils";
import { saveSpaceKey } from "@/space/space-links";

import { localIdentity, mergeOwnGraph } from "./identity";
import {
  cleanPersonalSpace,
  cleanProjects,
  revokeDevice,
  revokeInGraph,
  secured,
} from "./revoke";
import { saveBinding } from "@/directory/binding";
import type { MlsSession } from "./session";

// The directory itself says which project a token belongs to, as it would
// if every entry were honest; a test files a lie by overriding this.
const share = vi.hoisted(() => ({
  of: null as null | ((token: string) => Promise<string | null>),
}));
vi.mock("@/sync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/sync/api")>()),
  resolveShare: vi.fn(async (token: string) => {
    const spaceId = await share.of!(token);
    return spaceId ? { spaceId, permission: "write" } : null;
  }),
}));

beforeEach(() => {
  localStorage.clear();
  share.of = async (token) =>
    (await directory()).projectOfToken(token, Date.now());
});

describe("revokeInGraph", () => {
  it("marks the device revoked in the stored graph", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    const other = DeviceKey.generate().publicKey();
    const added = PersonGraph.decode(graph);
    added.addDevice(deviceSeed, other);
    await mergeOwnGraph(backend, added.encode());

    await revokeInGraph(backend, other);

    const stored = PersonGraph.decode((await backend.loadGraph())!);
    expect(stored.deviceState(other)).toBe("revoked");
  });

  it("will not revoke the device it runs on", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed } = await localIdentity(backend);
    const key = DeviceKey.import(deviceSeed);
    await expect(revokeInGraph(backend, key.publicKey())).rejects.toThrow(
      /another one/,
    );
  });
});

describe("cleanProjects", () => {
  it("reports a project that was never opened here as not reached", async () => {
    saveSpaceKey("p1", LinkSecret.generateEdit().toBase64url());
    // A view link cannot reset anything, so there is no reason to visit.
    await seedProject("p1", 1, { title: "Thesis", edit: false });
    const results = await cleanProjects(new MemoryBackend(), () => {
      throw new Error("no session for a project without group state");
    });
    expect(results).toEqual([
      {
        projectId: "p1",
        title: "Thesis",
        result: {
          status: "unreached",
          reason: "never opened here, and no device of yours has its owner key",
        },
      },
    ]);
  });

  it("cleans a few projects at a time and reports them in order", async () => {
    const backend = new MemoryBackend();
    // More than the old recent list held.
    const ids = Array.from({ length: 14 }, (_, i) => `p${i + 1}`);
    for (const [i, id] of ids.entries()) {
      saveSpaceKey(id, LinkSecret.generateEdit().toBase64url());
      await seedProject(id, i + 1);
      await backend.saveMls(id, {
        state: new Uint8Array([1]),
        device: null,
        removed: false,
        rotation: null,
      });
    }
    let running = 0;
    let most = 0;
    const results = await cleanProjects(backend, (projectId) => {
      // Later projects answer sooner, so finishing order is not list order.
      const delay = 10 * (ids.length - ids.indexOf(projectId));
      return {
        start: async () => {
          most = Math.max(most, ++running);
        },
        untilSynced: () =>
          new Promise((resolve) => setTimeout(() => resolve(true), delay)),
        getSnapshot: () => ({
          phase: "active",
          members: [],
          holdsOwnerKey: true,
        }),
        syncIdentity: async () => ({ canCommit: true }),
        removedLeaves: 0,
        stop: () => {
          running--;
        },
      } as unknown as MlsSession;
    });
    // The project list puts the last opened first.
    expect(results.map((r) => r.projectId)).toEqual([...ids].reverse());
    expect(results.every((r) => r.result.status === "clean")).toBe(true);
    expect(most).toBe(4);
  });

  it("leaves a revoked device in another person's project to its owner", async () => {
    const backend = new MemoryBackend();
    const roster = (role: string) => [
      { isSelf: true, role, deviceRevoked: false },
      { isSelf: false, role: "editor", deviceRevoked: true },
    ];
    const cases = [
      { id: "theirs", role: "editor", holds: false },
      { id: "mine", role: "owner", holds: false },
      { id: "swept", role: "owner", holds: true },
    ];
    for (const [i, { id }] of cases.entries()) {
      saveSpaceKey(id, LinkSecret.generateEdit().toBase64url());
      await seedProject(id, i + 1);
      await backend.saveMls(id, {
        state: new Uint8Array([1]),
        device: null,
        removed: false,
        rotation: null,
      });
    }
    const results = await cleanProjects(backend, (projectId) => {
      const { role, holds } = cases.find((c) => c.id === projectId)!;
      return {
        start: async () => {},
        untilSynced: async () => true,
        getSnapshot: () => ({
          phase: "active",
          members: roster(role),
          holdsOwnerKey: holds,
        }),
        syncIdentity: async () => ({ canCommit: true }),
        removedLeaves: holds ? 1 : 0,
        stop: () => {},
      } as unknown as MlsSession;
    });
    const byId = Object.fromEntries(
      results.map((r) => [r.projectId, r.result]),
    );
    expect(byId.theirs).toEqual({ status: "left-to-owner" });
    expect(byId.mine).toEqual({
      status: "unreached",
      reason: "this device does not have the project's owner key yet",
    });
    expect(byId.swept).toEqual({ status: "cleaned", removed: 1 });
  });
});

function fakeSession(opts: {
  role?: string;
  holds?: boolean;
  removed?: number;
  onStart?: () => void;
  onReset?: () => void;
}): MlsSession {
  return {
    start: async () => opts.onStart?.(),
    untilSynced: async () => true,
    getSnapshot: () => ({
      phase: "active",
      members: [{ isSelf: true, role: opts.role ?? "owner" }],
      holdsOwnerKey: opts.holds ?? true,
    }),
    syncIdentity: async () => ({ canCommit: true }),
    removedLeaves: opts.removed ?? 0,
    resetLinks: async () => opts.onReset?.(),
    stop: () => {},
  } as unknown as MlsSession;
}

/** Owned projects whose group state is gone but whose owner key is kept. */
async function neverOpened(backend: MemoryBackend, ids: string[]) {
  for (const [i, id] of ids.entries()) {
    saveSpaceKey(id, LinkSecret.generateEdit().toBase64url());
    await seedProject(id, i + 1);
    await backend.saveMls(id, {
      state: null,
      device: null,
      removed: false,
      rotation: null,
      ownerSecrets: new Uint8Array([1]),
    });
  }
}

describe("a project this person owns and never opened here", () => {
  it("is not visited when this device has no owner key for it", async () => {
    const backend = new MemoryBackend();
    saveSpaceKey("p1", LinkSecret.generateEdit().toBase64url());
    await seedProject("p1", 1);
    const results = await cleanProjects(backend, () => {
      throw new Error("joining would add this device to the project");
    });
    expect(results[0]!.result).toEqual({
      status: "unreached",
      reason: "never opened here, and no device of yours has its owner key",
    });
  });

  it("is reset with an owner key another device put in the directory", async () => {
    const backend = new MemoryBackend();
    saveSpaceKey("p1", LinkSecret.generateEdit().toBase64url());
    await seedProject("p1", 1);
    (await directory()).addOwnerKey("p1", new Uint8Array(32).fill(7), 100);
    const reset: string[] = [];
    const results = await cleanProjects(backend, (id) =>
      fakeSession({ onReset: () => reset.push(id) }),
    );
    expect(results[0]!.result).toEqual({ status: "links-reset" });
    expect(reset).toEqual(["p1"]);
  });

  it("gets its links reset without a leaf of the revoked device", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    const reset: string[] = [];
    const results = await cleanProjects(backend, (id) =>
      fakeSession({ onReset: () => reset.push(id) }),
    );
    expect(results[0]!.result).toEqual({ status: "links-reset" });
    expect(reset).toEqual(["p1"]);
  });

  it("is reset even when it was opened here and held no revoked leaf", async () => {
    const backend = new MemoryBackend();
    saveSpaceKey("p1", LinkSecret.generateEdit().toBase64url());
    await seedProject("p1", 1);
    await backend.saveMls("p1", {
      state: new Uint8Array([1]),
      device: null,
      removed: false,
      rotation: null,
    });
    const reset: string[] = [];
    const results = await cleanProjects(backend, (id) =>
      fakeSession({ onReset: () => reset.push(id) }),
    );
    expect(results[0]!.result).toEqual({ status: "links-reset" });
    expect(reset).toEqual(["p1"]);
  });

  it("leaves links alone when asked not to reset", async () => {
    const backend = new MemoryBackend();
    await seedProject("p1", 1);
    saveSpaceKey("p1", LinkSecret.generateEdit().toBase64url());
    await backend.saveMls("p1", {
      state: new Uint8Array([1]),
      device: null,
      removed: false,
      rotation: null,
    });
    const reset: string[] = [];
    const results = await cleanProjects(
      backend,
      (id) => fakeSession({ onReset: () => reset.push(id) }),
      { resetLinks: false },
    );
    expect(results[0]!.result).toEqual({ status: "clean" });
    expect(reset).toEqual([]);
  });

  it("is not joined when links are not to be reset", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    const results = await cleanProjects(
      backend,
      () => {
        throw new Error("a recovery key must not join unopened projects");
      },
      { resetLinks: false },
    );
    expect(results).toEqual([]);
  });

  it("stays quiet about a forgotten project it cannot clean", async () => {
    const backend = new MemoryBackend();
    saveSpaceKey("p1", LinkSecret.generateEdit().toBase64url());
    await seedProject("p1", 1);
    await seedProject("p2", 2);
    (await directory()).setStatus("p1", "forgotten", 200);
    const results = await cleanProjects(backend, () => {
      throw new Error("no key, nothing to join");
    });
    expect(results.map((r) => r.projectId)).toEqual(["p2"]);
    expect(results[0]!.result.status).toBe("unreached");
  });

  it("is cleaned although the person forgot it", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    (await directory()).setStatus("p1", "forgotten", 200);
    const reset: string[] = [];
    const results = await cleanProjects(backend, (id) =>
      fakeSession({ onReset: () => reset.push(id) }),
    );
    expect(results[0]!.result).toEqual({ status: "links-reset" });
    expect(reset).toEqual(["p1"]);
  });

  it("is skipped when its link leads to another project", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    share.of = async () => "someone-elses";
    const results = await cleanProjects(backend, () => {
      throw new Error("a lying entry must not be acted on");
    });
    expect(results[0]!.result.status).toBe("unreached");
  });

  it("is not reset again when the revoked leaf was removed", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    const reset: string[] = [];
    const results = await cleanProjects(backend, (id) =>
      fakeSession({ removed: 1, onReset: () => reset.push(id) }),
    );
    expect(results[0]!.result).toEqual({ status: "cleaned", removed: 1 });
    expect(reset).toEqual([]);
  });

  it("is unreached when this device holds no owner key for it", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    const results = await cleanProjects(backend, () =>
      fakeSession({ holds: false }),
    );
    expect(results[0]!.result).toEqual({
      status: "unreached",
      reason: "this device does not have the project's owner key yet",
    });
  });

  it("leaves someone else's project alone", async () => {
    const backend = new MemoryBackend();
    await neverOpened(backend, ["p1"]);
    const reset: string[] = [];
    const results = await cleanProjects(backend, (id) =>
      fakeSession({
        role: "editor",
        holds: false,
        onReset: () => reset.push(id),
      }),
    );
    expect(results[0]!.result).toEqual({ status: "clean" });
    expect(reset).toEqual([]);
  });

  it("covers more than a dozen projects", async () => {
    const backend = new MemoryBackend();
    const ids = Array.from({ length: 15 }, (_, i) => `p${i + 1}`);
    await neverOpened(backend, ids);
    const results = await cleanProjects(backend, () => fakeSession({}));
    expect(results).toHaveLength(15);
    expect(results.every((r) => r.result.status === "links-reset")).toBe(true);
  });
});

describe("cleanPersonalSpace without a reset", () => {
  it("does not join a space this browser never opened", async () => {
    const backend = new MemoryBackend();
    saveBinding({
      spaceId: "space",
      token: "tok",
      secret: LinkSecret.generateEdit().toBase64url(),
    });
    await backend.saveMls("space", {
      state: null,
      device: null,
      removed: false,
      rotation: null,
      ownerSecrets: new Uint8Array([1]),
    });
    const personal = await cleanPersonalSpace(
      backend,
      () => {
        throw new Error("must not rotate the personal space");
      },
      { resetLinks: false },
    );
    expect(personal).toEqual({ status: "none" });
  });
});

describe("revokeDevice", () => {
  it("cleans the personal space before any project", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    const other = DeviceKey.generate().publicKey();
    const added = PersonGraph.decode(graph);
    added.addDevice(deviceSeed, other);
    await mergeOwnGraph(backend, added.encode());

    const secret = LinkSecret.generateEdit().toBase64url();
    saveBinding({ spaceId: "space", token: "tok", secret });
    await backend.saveMls("space", {
      state: new Uint8Array([1]),
      device: null,
      removed: false,
      rotation: null,
    });
    await neverOpened(backend, ["p1", "p2"]);

    const order: string[] = [];
    const outcome = await revokeDevice(other, {
      backend,
      createPersonal: (id) =>
        fakeSession({ removed: 1, onStart: () => order.push(id) }),
      createProject: (id) => fakeSession({ onStart: () => order.push(id) }),
    });
    expect(order[0]).toBe("space");
    expect(order.slice(1).sort()).toEqual(["p1", "p2"]);
    expect(outcome.personal).toEqual({ status: "cleaned", removed: 1 });
    expect(outcome.projects).toHaveLength(2);
  });

  it("replaces no project link while the personal space is not secured", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    const other = DeviceKey.generate().publicKey();
    const added = PersonGraph.decode(graph);
    added.addDevice(deviceSeed, other);
    await mergeOwnGraph(backend, added.encode());
    saveBinding({
      spaceId: "space",
      token: "tok",
      secret: LinkSecret.generateEdit().toBase64url(),
    });
    await backend.saveMls("space", {
      state: new Uint8Array([1]),
      device: null,
      removed: false,
      rotation: null,
      ownerSecrets: undefined,
    });
    await neverOpened(backend, ["p1"]);

    const outcome = await revokeDevice(other, {
      backend,
      createPersonal: () => fakeSession({ holds: false }),
      createProject: () => {
        throw new Error("no project may be touched");
      },
    });
    expect(outcome.personal.status).toBe("unreached");
    expect(outcome.projects).toEqual([]);
    expect(secured(outcome.personal)).toBe(false);
  });

  it("has nothing to clean without a binding", async () => {
    expect(await cleanPersonalSpace(new MemoryBackend())).toEqual({
      status: "none",
    });
  });
});
