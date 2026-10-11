import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toHex } from "@/crypto/bytes";
import { DeviceKey, LinkSecret, PersonGraph } from "@/crypto/wasm";
import { localDeviceKey, localIdentity } from "@/mls/identity";
import { MemoryBackend } from "@/persist/local-doc-store";
import {
  loadProjectKey,
  loadRecent,
  rememberProject,
  saveProjectKey,
} from "@/project/recent";

import { applyGrant, holderGrant } from "./grant";
import { GrantRefusedError } from "./session";

function newDevice(): { name: string; pub: Uint8Array } {
  const key = DeviceKey.generate();
  const pub = key.publicKey();
  key.free();
  return { name: "Laptop", pub };
}

function stateOf(graph: Uint8Array, pub: Uint8Array): string {
  const decoded = PersonGraph.decode(graph);
  const state = decoded.deviceState(pub);
  decoded.free();
  return state;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("holderGrant", () => {
  it("lists the recent projects it holds a key for", async () => {
    const key = LinkSecret.generateEdit().toBase64url();
    saveProjectKey("p1", key);
    rememberProject({ projectId: "p1", token: "tok1", title: "Thesis" });
    // No key stored: nothing to hand over.
    rememberProject({ projectId: "p2", token: "tok2", title: "Lost" });

    const grant = await holderGrant(
      new MemoryBackend(),
      newDevice(),
      "https://t.test",
    );
    expect(grant.projects).toEqual([
      { title: "Thesis", link: `https://t.test/p/tok1#${key}` },
    ]);
  });

  it("names itself by its stored label, else by the browser", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed } = await localIdentity(backend);
    const key = DeviceKey.import(deviceSeed);
    const own = toHex(key.publicKey());
    key.free();

    const guessed = await holderGrant(backend, newDevice(), "https://t.test");
    expect(guessed.holderName).toMatch(/\S/);

    await backend.saveLabels({ [own]: "Studio Mac" });
    const labeled = await holderGrant(backend, newDevice(), "https://t.test");
    expect(labeled.holderName).toBe("Studio Mac");
  });

  it("adds the device to the graph, stores it and labels the device", async () => {
    const backend = new MemoryBackend();
    const device = newDevice();
    const { graph: before } = await localIdentity(backend);
    expect(stateOf(before, device.pub)).toBe("unknown");

    const grant = await holderGrant(backend, device, "https://t.test");

    expect(stateOf(grant.graph, device.pub)).toBe("valid");
    expect(await backend.loadGraph()).toEqual(grant.graph);
    expect(await backend.loadLabels()).toEqual({
      [toHex(device.pub)]: "Laptop",
    });
  });

  it("refuses when this device was revoked from its own graph", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    // Another device of the person revoked this one.
    const other = DeviceKey.generate();
    const revoked = PersonGraph.decode(graph);
    revoked.addDevice(deviceSeed, other.publicKey());
    revoked.revoke(other.export(), DeviceKey.import(deviceSeed).publicKey());
    await backend.mergeGraph(revoked.encode(), (_, incoming) => incoming);

    await expect(
      holderGrant(backend, newDevice(), "https://t.test"),
    ).rejects.toBeInstanceOf(GrantRefusedError);
  });

  it("does not add a device that is already valid", async () => {
    const backend = new MemoryBackend();
    const device = newDevice();
    const first = await holderGrant(backend, device, "https://t.test");
    const again = await holderGrant(backend, device, "https://t.test");
    expect(again.graph).toEqual(first.graph);
  });

  it("refuses a device that was removed from the account before", async () => {
    const backend = new MemoryBackend();
    const device = newDevice();
    const { graph } = await holderGrant(backend, device, "https://t.test");
    const { deviceSeed } = await localIdentity(backend);
    const revoked = PersonGraph.decode(graph);
    revoked.revoke(deviceSeed, device.pub);
    await backend.mergeGraph(revoked.encode(), (_, incoming) => incoming);
    revoked.free();

    await expect(
      holderGrant(backend, device, "https://t.test"),
    ).rejects.toThrow(/cannot be added again/);
  });
});

describe("applyGrant", () => {
  function stubShare(projectId: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ projectId, permission: "write" }, { status: 200 }),
      ),
    );
  }

  /** What a holder hands to the device with `backend`'s key. */
  async function grantFor(backend: MemoryBackend, projects = [] as never[]) {
    const key = DeviceKey.import(await localDeviceKey(backend));
    const holderBackend = new MemoryBackend();
    const { graph, holderName } = await holderGrant(holderBackend, {
      name: "x",
      pub: key.publicKey(),
    });
    key.free();
    return { graph, projects, holderName };
  }

  it("stores the graph, the label and the projects", async () => {
    stubShare("pid-1");
    const backend = new MemoryBackend();
    const key = LinkSecret.generateEdit().toBase64url();
    const { graph } = await grantFor(backend);

    const opened = await applyGrant(
      {
        graph,
        holderName: "Desk",
        projects: [{ title: "Thesis", link: `https://t.test/p/tok#${key}` }],
      },
      backend,
      "Phone",
    );

    expect(await backend.loadGraph()).toEqual(graph);
    // The holder is labeled under the key that added this device.
    expect(Object.values(await backend.loadLabels()).sort()).toEqual([
      "Desk",
      "Phone",
    ]);
    expect(loadProjectKey("pid-1")).toBe(key);
    expect(loadRecent()).toMatchObject([
      { projectId: "pid-1", token: "tok", title: "Thesis" },
    ]);
    expect(opened).toEqual([{ title: "Thesis", link: "/p/tok" }]);
  });

  it("refuses a grant that does not include this device", async () => {
    const backend = new MemoryBackend();
    const { graph } = await localIdentity(new MemoryBackend());
    await expect(
      applyGrant({ graph, projects: [], holderName: "Desk" }, backend, "Phone"),
    ).rejects.toBeInstanceOf(GrantRefusedError);
    expect(await backend.loadGraph()).toBeNull();
  });

  describe("with a key made for the pairing", () => {
    function pairingKey() {
      const key = DeviceKey.generate();
      const out = { seed: key.export(), pub: key.publicKey() };
      key.free();
      return out;
    }

    async function grantTo(pub: Uint8Array) {
      return holderGrant(new MemoryBackend(), { name: "x", pub });
    }

    it("stores the key with the grant", async () => {
      const backend = new MemoryBackend();
      const { seed, pub } = pairingKey();
      const { graph, holderName } = await grantTo(pub);
      await applyGrant({ graph, projects: [], holderName }, backend, "Phone", {
        deviceSeed: seed,
      });
      expect(await backend.loadDeviceKey()).toEqual(seed);
    });

    it("leaves no key behind when the grant is refused", async () => {
      const backend = new MemoryBackend();
      const { seed } = pairingKey();
      const { graph } = await grantTo(pairingKey().pub);
      await expect(
        applyGrant({ graph, projects: [], holderName: "Desk" }, backend, "P", {
          deviceSeed: seed,
        }),
      ).rejects.toBeInstanceOf(GrantRefusedError);
      expect(await backend.loadDeviceKey()).toBeNull();
      expect(await backend.loadGraph()).toBeNull();
    });

    it("refuses without storing the graph when another tab stored a key first", async () => {
      const backend = new MemoryBackend();
      const { seed, pub } = pairingKey();
      const other = await localDeviceKey(backend);
      const { graph } = await grantTo(pub);
      await expect(
        applyGrant({ graph, projects: [], holderName: "Desk" }, backend, "P", {
          deviceSeed: seed,
        }),
      ).rejects.toBeInstanceOf(GrantRefusedError);
      expect(await backend.loadDeviceKey()).toEqual(other);
      expect(await backend.loadGraph()).toBeNull();
    });
  });

  it("refuses when the device already belongs to another person", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    const { graph } = await grantFor(backend);
    await expect(
      applyGrant({ graph, projects: [], holderName: "Desk" }, backend, "Phone"),
    ).rejects.toBeInstanceOf(GrantRefusedError);
  });

  it("merges a grant of the person it already belongs to", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph: own } = await localIdentity(backend);
    const grown = PersonGraph.decode(own);
    grown.addDevice(deviceSeed, newDevice().pub);
    const graph = grown.encode();
    grown.free();
    await expect(
      applyGrant({ graph, projects: [], holderName: "Desk" }, backend, "Phone"),
    ).resolves.toEqual([]);
    expect(await backend.loadGraph()).toEqual(graph);
  });

  it("leaves out a project the server does not know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const backend = new MemoryBackend();
    const key = LinkSecret.generateEdit().toBase64url();
    const { graph } = await grantFor(backend);
    const opened = await applyGrant(
      {
        graph,
        holderName: "Desk",
        projects: [{ title: "Gone", link: `https://t.test/p/tok#${key}` }],
      },
      backend,
      "Phone",
    );
    expect(opened).toEqual([]);
    expect(loadRecent()).toEqual([]);
  });
});
