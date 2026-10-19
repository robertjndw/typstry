// @vitest-environment node
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";

import type { FolderLink } from "@/folder/base";

import {
  IndexedDbBackend,
  LocalDocStore,
  MemoryBackend,
  storageHealth,
  type DocBackend,
} from "./local-doc-store";

function write(doc: LoroDoc, text: string) {
  const t = doc.getText("t");
  t.insert(t.length, text);
  doc.commit();
}

function text(doc: LoroDoc) {
  return doc.getText("t").toString();
}

async function reopen(backend: DocBackend, spaceId = "p1") {
  const doc = new LoroDoc();
  const found = await new LocalDocStore(spaceId, doc, backend).load();
  return { doc, found };
}

const backends: [string, () => Promise<DocBackend>][] = [
  ["IndexedDB", () => IndexedDbBackend.open(new IDBFactory())],
  ["memory", async () => new MemoryBackend()],
];

describe.each(backends)("LocalDocStore on %s", (_name, makeBackend) => {
  it("finds nothing for an unknown project", async () => {
    const { found } = await reopen(await makeBackend());
    expect(found).toBe(false);
  });

  it("restores local edits and synced changes", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, { flushDelayMs: 5 });
    await store.load();
    store.start();

    write(doc, "mine");
    const remote = new LoroDoc();
    write(remote, "theirs");
    doc.import(remote.export({ mode: "snapshot" }));
    await store.stop();

    const again = await reopen(backend);
    expect(again.found).toBe(true);
    expect(text(again.doc)).toBe(text(doc));
    expect(text(again.doc)).toContain("mine");
    expect(text(again.doc)).toContain("theirs");
  });

  it("keeps projects apart", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend);
    await store.load();
    write(doc, "one");
    await store.flush();
    expect((await reopen(backend, "p2")).found).toBe(false);
  });

  it("removes one project's snapshot and updates", async () => {
    const backend = await makeBackend();
    for (const id of ["p1", "p2"]) {
      const doc = new LoroDoc();
      const store = new LocalDocStore(id, doc, backend, {
        compactMinBytes: 1,
      });
      await store.load();
      write(doc, "a");
      await store.flush();
      write(doc, "b");
      await store.flush();
    }
    await backend.remove("p1");
    expect((await reopen(backend, "p1")).found).toBe(false);
    expect(text((await reopen(backend, "p2")).doc)).toBe("ab");
  });

  it("compacts once the log outgrows the snapshot", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, {
      compactMinBytes: 1,
      compactRatio: 1,
    });
    await store.load();
    // No snapshot yet, so the first row already passes the minimum.
    write(doc, "a");
    await store.flush();
    let stored = await backend.load("p1");
    expect(stored.snapshot).not.toBeNull();
    expect(stored.updates).toHaveLength(0);

    write(doc, "b");
    await store.flush();
    write(doc, "c");
    await store.flush();
    stored = await backend.load("p1");
    expect(stored.updates).toHaveLength(2);

    write(doc, "d".repeat(4 * stored.snapshot!.length));
    await store.flush();
    stored = await backend.load("p1");
    expect(stored.updates).toHaveLength(0);
    expect(text((await reopen(backend)).doc)).toBe(text(doc));
    expect(text(doc)).toMatch(/^abcd+$/);
  });

  it("does not re-import its own rows when compacting", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, {
      compactMinBytes: 1,
      compactRatio: 1,
    });
    await store.load();
    write(doc, "a");
    await store.flush();
    const importBatch = vi.spyOn(doc, "importBatch");
    write(doc, "b".repeat(5000));
    await store.flush();
    expect((await backend.load("p1")).updates).toHaveLength(0);
    expect(importBatch).not.toHaveBeenCalled();
    expect(text((await reopen(backend)).doc)).toBe(text(doc));
  });

  it("waits for a pause in typing before writing", async () => {
    const backend = await makeBackend();
    const append = vi.spyOn(backend, "append");
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, {
      flushDelayMs: 30,
      maxFlushDelayMs: 10_000,
    });
    await store.load();
    store.start();
    for (const ch of "typing") {
      write(doc, ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(append).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    await store.stop();
    expect(append).toHaveBeenCalledTimes(1);
    expect(text((await reopen(backend)).doc)).toBe("typing");
  });

  it("writes during steady typing at least every maxFlushDelayMs", async () => {
    const backend = await makeBackend();
    const append = vi.spyOn(backend, "append");
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, {
      flushDelayMs: 1000,
      maxFlushDelayMs: 20,
    });
    await store.load();
    store.start();
    write(doc, "a");
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    await store.stop();
  });

  it("folds in what another tab stored when compacting", async () => {
    const backend = await makeBackend();
    const tabA = new LoroDoc();
    const storeA = new LocalDocStore("p1", tabA, backend, {
      compactMinBytes: 1,
    });
    await storeA.load();
    const tabB = new LoroDoc();
    const storeB = new LocalDocStore("p1", tabB, backend);
    await storeB.load();

    write(tabB, "B was offline. ");
    await storeB.flush();
    write(tabA, "A ");
    write(tabA, "compacts");
    await storeA.flush();
    expect((await backend.load("p1")).updates).toHaveLength(0);

    const restored = text((await reopen(backend)).doc);
    expect(restored).toContain("B was offline.");
    expect(restored).toContain("A compacts");
  });
});

describe.each(backends)("reloading a store on %s", (_name, makeBackend) => {
  it("keeps edits made while no store was bound to the doc", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const first = new LocalDocStore("p1", doc, backend, { flushDelayMs: 5 });
    await first.load();
    first.start();
    write(doc, "before ");
    await first.stop();

    // A reconnect: the doc lives on, the store is made anew once the keys
    // open, and typing goes on in between.
    write(doc, "between");
    const second = new LocalDocStore("p1", doc, backend, { flushDelayMs: 5 });
    await second.load();
    second.start();
    await second.stop();

    expect(text((await reopen(backend)).doc)).toBe("before between");
  });

  it("writes nothing on a plain reload", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, {
      compactMinBytes: 1,
    });
    await store.load();
    write(doc, "snap");
    await store.flush();
    const remote = new LoroDoc();
    write(remote, "theirs");
    doc.import(remote.export({ mode: "snapshot" }));
    await backend.append("p1", remote.export({ mode: "snapshot" }));

    const again = new LocalDocStore("p1", new LoroDoc(), backend, {
      flushDelayMs: 1,
    });
    await again.load();
    const append = vi.spyOn(backend, "append");
    again.start();
    await new Promise((r) => setTimeout(r, 20));
    await again.stop();
    expect(append).not.toHaveBeenCalled();
  });

  it("opens with the rows that import when one is broken", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend);
    await store.load();
    write(doc, "kept");
    await store.flush();
    await backend.append("p1", new Uint8Array([1, 2, 3, 4]));
    write(doc, " too");
    await store.flush();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const again = await reopen(backend);
      expect(again.found).toBe(true);
      expect(text(again.doc)).toBe("kept too");
    } finally {
      warn.mockRestore();
    }
  });

  it("drops a broken row when it compacts", async () => {
    const backend = await makeBackend();
    await backend.append("p1", new Uint8Array([1, 2, 3, 4]));
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, {
      compactMinBytes: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await store.load();
      write(doc, "fine");
      await store.flush();
      const stored = await backend.load("p1");
      expect(stored.updates).toEqual([]);
      expect(stored.snapshot).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe.each(backends)("device key on %s", (_name, makeBackend) => {
  it("is absent until saved", async () => {
    expect(await (await makeBackend()).loadDeviceKey()).toBeNull();
  });

  it("keeps the first key when two writers race", async () => {
    const backend = await makeBackend();
    const [a, b] = await Promise.all([
      backend.saveDeviceKey(new Uint8Array([1])),
      backend.saveDeviceKey(new Uint8Array([2])),
    ]);
    expect(a).toEqual(b);
    expect(await backend.loadDeviceKey()).toEqual(a);
  });
});

// Stands in for a graph merge: a sorted set of bytes, so a lost update shows
// as a missing byte.
const union = (stored: Uint8Array | null, incoming: Uint8Array) =>
  Uint8Array.from(new Set([...(stored ?? []), ...incoming]).values()).sort();

describe.each(backends)("person graph on %s", (_name, makeBackend) => {
  it("is absent until merged, then holds the merge", async () => {
    const backend = await makeBackend();
    expect(await backend.loadGraph()).toBeNull();
    await backend.mergeGraph(new Uint8Array([1]), union);
    await backend.mergeGraph(new Uint8Array([2]), union);
    expect(await backend.loadGraph()).toEqual(new Uint8Array([1, 2]));
  });

  it("keeps every entry when tabs merge at the same time", async () => {
    const backend = await makeBackend();
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        backend.mergeGraph(new Uint8Array([n]), union),
      ),
    );
    expect(await backend.loadGraph()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("leaves the graph as it was when the merge refuses", async () => {
    const backend = await makeBackend();
    await backend.mergeGraph(new Uint8Array([1]), union);
    await expect(
      backend.mergeGraph(new Uint8Array([9]), () => {
        throw new Error("another person");
      }),
    ).rejects.toThrow("another person");
    expect(await backend.loadGraph()).toEqual(new Uint8Array([1]));
  });

  it("keeps device labels, the latest name winning", async () => {
    const backend = await makeBackend();
    expect(await backend.loadLabels()).toEqual({});
    await backend.saveLabels({ aa: "Laptop", bb: "Phone" });
    await backend.saveLabels({ aa: "Work laptop" });
    expect(await backend.loadLabels()).toEqual({
      aa: "Work laptop",
      bb: "Phone",
    });
  });

  it("survives removing a project", async () => {
    const backend = await makeBackend();
    await backend.mergeGraph(new Uint8Array([1]), union);
    await backend.remove("p1");
    expect(await backend.loadGraph()).toEqual(new Uint8Array([1]));
  });
});

describe.each(backends)("pinned owner on %s", (_name, makeBackend) => {
  it("is kept in the group record", async () => {
    const backend = await makeBackend();
    await backend.saveMls("p1", {
      state: null,
      device: null,
      removed: false,
      rotation: null,
      ownerPerson: new Uint8Array([9]),
      ownerSecrets: new Uint8Array([7]),
    });
    const loaded = await backend.loadMls("p1");
    expect(loaded?.ownerPerson).toEqual(new Uint8Array([9]));
    expect(loaded?.ownerSecrets).toEqual(new Uint8Array([7]));
  });
});

function link(spaceId: string, name = "thesis"): FolderLink {
  // Real handles are structured-cloneable in browsers, but not in fake-indexeddb.
  const handle = {
    kind: "directory",
    name,
  } as unknown as FileSystemDirectoryHandle;
  return { spaceId, v: 1, handle, name, base: null };
}

describe.each(backends)("folder links on %s", (_name, makeBackend) => {
  it("round-trips a row", async () => {
    const backend = await makeBackend();
    expect(await backend.loadFolder("p1")).toBeNull();
    const withBase: FolderLink = {
      ...link("p1"),
      base: {
        frontiers: [{ peer: "1", counter: 4 }],
        files: {
          "main.typ": { kind: "text", digest: "d", size: 3, mtime: 9 },
        },
      },
    };
    await backend.saveFolder(withBase);
    expect(await backend.loadFolder("p1")).toEqual(withBase);
    expect(await backend.loadFolder("p2")).toBeNull();
  });

  it("is dropped by removeFolder and by removing the project", async () => {
    const backend = await makeBackend();
    await backend.saveFolder(link("p1"));
    await backend.saveFolder(link("p2"));
    await backend.removeFolder("p1");
    expect(await backend.loadFolder("p1")).toBeNull();
    expect(await backend.loadFolder("p2")).not.toBeNull();
    await backend.remove("p2");
    expect(await backend.loadFolder("p2")).toBeNull();
  });
});

describe("IndexedDbBackend schema", () => {
  it("reopens an existing v1 database without recreating stores", async () => {
    const factory = new IDBFactory();
    const first = await IndexedDbBackend.open(factory);
    await first.append("p1", new Uint8Array([1, 2]));

    const second = await IndexedDbBackend.open(factory);
    const stored = await second.load("p1");
    expect(stored.updates).toEqual([new Uint8Array([1, 2])]);
  });

  it("creates the stores on a fresh open", async () => {
    const backend = await IndexedDbBackend.open(new IDBFactory());
    await expect(backend.load("none")).resolves.toEqual({
      snapshot: null,
      updates: [],
    });
  });
});

describe("IndexedDbBackend connection", () => {
  it("opens the database again after it was deleted under it", async () => {
    const factory = new IDBFactory();
    const backend = await IndexedDbBackend.open(factory);
    await backend.append("p1", new Uint8Array([1]));
    // Clearing site data closes our connection through versionchange.
    await new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase("typstry");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    await backend.append("p1", new Uint8Array([2]));
    expect((await backend.load("p1")).updates).toEqual([new Uint8Array([2])]);
    expect(storageHealth()).toBe("ok");
  });

  it("says saving fails once a newer schema took the database", async () => {
    const factory = new IDBFactory();
    const backend = await IndexedDbBackend.open(factory);
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("typstry", 99);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    await expect(
      backend.append("p1", new Uint8Array([1])),
    ).rejects.toMatchObject({ name: "VersionError" });
    expect(storageHealth()).toBe("failing");
    // Back once writing works again, here in a fresh database.
    const fresh = await IndexedDbBackend.open(new IDBFactory());
    await fresh.append("p1", new Uint8Array([1]));
    expect(storageHealth()).toBe("ok");
  });
});

describe("person graph writes on IndexedDB", () => {
  it("skips the write when the merge changes nothing", async () => {
    const backend = await IndexedDbBackend.open(new IDBFactory());
    await backend.mergeGraph(new Uint8Array([1]), union);
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    try {
      await backend.mergeGraph(new Uint8Array([1]), union);
      expect(put).not.toHaveBeenCalled();
      await backend.mergeGraph(new Uint8Array([2]), union);
      expect(put).toHaveBeenCalledTimes(1);
      expect(await backend.loadGraph()).toEqual(new Uint8Array([1, 2]));
    } finally {
      put.mockRestore();
    }
  });
});
