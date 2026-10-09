// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

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

  it("compacts into a snapshot without losing anything", async () => {
    const backend = await makeBackend();
    const doc = new LoroDoc();
    const store = new LocalDocStore("p1", doc, backend, { compactAfter: 3 });
    await store.load();
    for (const part of ["a", "b", "c", "d"]) {
      write(doc, part);
      await store.flush();
    }
    const stored = await backend.load("p1");
    expect(stored.snapshot).not.toBeNull();
    expect(stored.updates).toHaveLength(1);
    expect(text((await reopen(backend)).doc)).toBe("abcd");
  });

  it("folds in what another tab stored when compacting", async () => {
    const backend = await makeBackend();
    const tabA = new LoroDoc();
    const storeA = new LocalDocStore("p1", tabA, backend, { compactAfter: 2 });
    await storeA.load();
    const tabB = new LoroDoc();
    const storeB = new LocalDocStore("p1", tabB, backend);
    await storeB.load();

    write(tabB, "B was offline. ");
    await storeB.flush();
    write(tabA, "A ");
    await storeA.flush();
    write(tabA, "compacts");
    await storeA.flush();

    const restored = text((await reopen(backend)).doc);
    expect(restored).toContain("B was offline.");
    expect(restored).toContain("A compacts");
  });
});
