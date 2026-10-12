import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MemoryBackend } from "@/persist/local-doc-store";

import { link } from "./test-utils";
import {
  directory,
  DIRECTORY_STORE_ID,
  DirectoryStore,
  flushDirectory,
  GENERATION_KEY,
  onDirectoryReset,
  resetDirectory,
  useDirectory,
} from "./store";

describe("DirectoryStore", () => {
  it("persists under the fixed id and reloads what it wrote", async () => {
    const backend = new MemoryBackend();
    const first = await DirectoryStore.open(backend, null);
    first.directory.addLink(link(1, "p1"));
    first.directory.setTitle("p1", "Thesis");
    await first.close();

    const stored = await backend.load(DIRECTORY_STORE_ID);
    expect(stored.snapshot ?? stored.updates[0]).toBeTruthy();

    const second = await DirectoryStore.open(backend, null);
    expect(second.snapshot).toMatchObject([
      { projectId: "p1", title: "Thesis" },
    ]);
    expect(second.directory.kind).toBe("directory");
    await second.close();
  });

  it("shows another tab's writes through the channel", async () => {
    const backend = new MemoryBackend();
    const name = "typstry:directory:test";
    const a = await DirectoryStore.open(backend, name);
    const b = await DirectoryStore.open(backend, name);
    const seen = vi.fn();
    b.subscribe(seen);

    a.directory.addLink(link(1, "p1"));
    await waitFor(() => expect(b.snapshot).toHaveLength(1));
    expect(seen).toHaveBeenCalled();

    b.directory.setTitle("p1", "From b");
    await waitFor(() => expect(a.snapshot[0]?.title).toBe("From b"));
    await a.close();
    await b.close();
  });

  it("keeps the snapshot identity until the doc changes", async () => {
    const store = await DirectoryStore.open(new MemoryBackend(), null);
    const before = store.snapshot;
    expect(store.snapshot).toBe(before);
    store.directory.addLink(link(1, "p1"));
    await waitFor(() => expect(store.snapshot).not.toBe(before));
    const after = store.snapshot;
    expect(store.snapshot).toBe(after);
    await store.close();
  });
});

describe("the page directory", () => {
  it("is one instance, and useDirectory follows its writes", async () => {
    const { result } = renderHook(() => useDirectory());
    expect(result.current).toBeNull();
    const dir = await directory();
    expect(await directory()).toBe(dir);
    await waitFor(() => expect(result.current).toEqual([]));

    act(() => {
      dir.addLink(link(1, "p1"));
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
  });

  it("keys its storage on a generation that a reset bumps", async () => {
    const dir = await directory();
    dir.addLink(link(1, "p1"));
    await flushDirectory();
    const before = localStorage.getItem(GENERATION_KEY);
    await resetDirectory();
    expect(localStorage.getItem(GENERATION_KEY)).not.toBe(before);
    expect((await directory()).list(Date.now())).toEqual([]);
    expect(await directory()).not.toBe(dir);
  });

  it("bumps the generation even when this page never opened it", async () => {
    await resetDirectory();
    const first = localStorage.getItem(GENERATION_KEY);
    await resetDirectory();
    expect(localStorage.getItem(GENERATION_KEY)).not.toBe(first);
  });

  it("reloads when another tab resets it", () => {
    const reload = vi.fn();
    const stop = onDirectoryReset(reload);
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: GENERATION_KEY }));
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new StorageEvent("storage", { key: GENERATION_KEY }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("starts empty after a reset", async () => {
    (await directory()).addLink(link(1, "p1"));
    await resetDirectory();
    expect((await directory()).list(Date.now())).toEqual([]);
  });
});
