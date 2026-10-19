import { renderHook, waitFor } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initProject, META } from "@/doc/schema";
import { recordOpened } from "@/directory/record";
import { editSecret, token } from "@/directory/test-utils";
import { directory } from "@/directory/store";
import { LocalDocStore, MemoryBackend } from "@/persist/local-doc-store";

const backend = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/persist/local-doc-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/persist/local-doc-store")>()),
  defaultBackend: async () => backend.current,
}));

import { useStandaloneSession } from "./useStandaloneSession";

afterEach(() => localStorage.clear());

async function store(id: string, title: string, mem: MemoryBackend) {
  const doc = new LoroDoc();
  const s = new LocalDocStore(id, doc, mem);
  await s.load();
  initProject(doc, { title });
  await s.flush();
}

describe("useStandaloneSession", () => {
  it("is not-found for a project this browser never saved", async () => {
    backend.current = new MemoryBackend();
    const { result } = renderHook(() => useStandaloneSession("nope"));
    expect(result.current.state.phase).toBe("loading");
    await waitFor(() => expect(result.current.state.phase).toBe("not-found"));
  });

  it("opens a saved project and keeps saving its edits", async () => {
    const mem = new MemoryBackend();
    backend.current = mem;
    await store("p1", "Saved", mem);

    const { result } = renderHook(() => useStandaloneSession("p1"));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(result.current.project.title).toBe("Saved");

    result.current.project.meta.set(META.title, "Renamed");
    result.current.project.doc.commit();
    await result.current.saveLocally();
    const reloaded = new LoroDoc();
    await new LocalDocStore("p1", reloaded, mem).load();
    expect(reloaded.getMap("meta").get("title")).toBe("Renamed");
  });

  it("mirrors title changes into the project list", async () => {
    const mem = new MemoryBackend();
    backend.current = mem;
    await store("p1", "Saved", mem);
    await recordOpened(
      "p1",
      { token: token(1), secret: editSecret(), edit: true },
      "Saved",
    );
    const { result } = renderHook(() => useStandaloneSession("p1"));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));

    result.current.project.meta.set(META.title, "Renamed");
    result.current.project.doc.commit();

    await waitFor(async () =>
      expect((await directory()).list(Date.now())[0]?.title).toBe("Renamed"),
    );
  });

  it("lists the project as opened when the link carries its secret", async () => {
    const mem = new MemoryBackend();
    backend.current = mem;
    const id = token(1);
    await store(id, "Saved", mem);
    const secret = editSecret();

    const { result } = renderHook(() => useStandaloneSession(id, secret));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));

    await waitFor(async () =>
      expect((await directory()).list(Date.now())).toMatchObject([
        { projectId: id, title: "Saved", link: { token: id, secret } },
      ]),
    );
    expect((await directory()).list(Date.now())[0]?.openedAt).not.toBeNull();
  });
});
