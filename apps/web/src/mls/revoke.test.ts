import { beforeEach, describe, expect, it } from "vitest";

import { DeviceKey, LinkSecret, PersonGraph } from "@/crypto/wasm";
import { MemoryBackend } from "@/persist/local-doc-store";
import { rememberProject, saveProjectKey } from "@/project/recent";

import { localIdentity, mergeOwnGraph } from "./identity";
import { cleanProjects, revokeInGraph } from "./revoke";
import type { MlsSession } from "./session";

beforeEach(() => localStorage.clear());

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
    saveProjectKey("p1", LinkSecret.generateEdit().toBase64url());
    rememberProject({ projectId: "p1", token: "t", title: "Thesis" });
    const results = await cleanProjects(new MemoryBackend(), () => {
      throw new Error("no session for a project without group state");
    });
    expect(results).toEqual([
      {
        projectId: "p1",
        title: "Thesis",
        result: {
          status: "unreached",
          reason: "it was never opened in this browser",
        },
      },
    ]);
  });

  it("cleans a few projects at a time and reports them in order", async () => {
    const backend = new MemoryBackend();
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    for (const id of ids) {
      saveProjectKey(id, LinkSecret.generateEdit().toBase64url());
      rememberProject({ projectId: id, token: `t-${id}`, title: id });
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
        getSnapshot: () => ({ phase: "active" }),
        syncIdentity: async () => ({ canCommit: true }),
        removedLeaves: 0,
        stop: () => {
          running--;
        },
      } as unknown as MlsSession;
    });
    // The recent list puts the last remembered first.
    expect(results.map((r) => r.projectId)).toEqual([...ids].reverse());
    expect(results.every((r) => r.result.status === "clean")).toBe(true);
    expect(most).toBe(4);
  });
});
