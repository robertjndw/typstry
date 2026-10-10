// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";

import {
  IndexedDbBackend,
  LocalDocStore,
  MemoryBackend,
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

async function reopen(backend: DocBackend, projectId = "p1") {
  const doc = new LoroDoc();
  const found = await new LocalDocStore(projectId, doc, backend).load();
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
