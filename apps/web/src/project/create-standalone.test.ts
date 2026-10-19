import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isEditSecret } from "@/crypto/secret";
import { ProjectDoc } from "@/doc/schema";
import { directory } from "@/directory/store";
import { LocalDocStore, MemoryBackend } from "@/persist/local-doc-store";

import {
  createStandaloneProject,
  deleteStandaloneProject,
} from "./create-standalone";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("createStandaloneProject", () => {
  it("makes a listed, openable project without touching the network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const backend = new MemoryBackend();

    const created = await createStandaloneProject("Notes", { backend });

    expect(fetch).not.toHaveBeenCalled();
    expect(created.projectId).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(created.editToken).toBe(created.projectId);
    expect(isEditSecret(created.key)).toBe(true);
    // The directory refuses entries with a malformed token or secret, so
    // finding it listed is the validity check.
    expect((await directory()).list(Date.now())).toMatchObject([
      {
        projectId: created.projectId,
        title: "Notes",
        state: "listed",
        link: { token: created.editToken, secret: created.key, edit: true },
      },
    ]);

    const doc = new LoroDoc();
    expect(
      await new LocalDocStore(created.projectId, doc, backend).load(),
    ).toBe(true);
    const project = new ProjectDoc(doc);
    expect(project.title).toBe("Notes");
    expect(project.schemaVersion).not.toBeNull();
  });

  it("gives every project its own id and secret", async () => {
    const backend = new MemoryBackend();
    const a = await createStandaloneProject("A", { backend });
    const b = await createStandaloneProject("B", { backend });
    expect(a.projectId).not.toBe(b.projectId);
    expect(a.key).not.toBe(b.key);
  });

  it("drops the seed's files when seeding fails", async () => {
    const backend = new MemoryBackend();
    const saveBlob = vi.spyOn(backend, "saveBlob");
    await expect(
      createStandaloneProject("Bad", {
        backend,
        seed: async (_project, assets) => {
          await assets.store(new File(["x"], "x.txt"));
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    const [projectId, hash] = saveBlob.mock.calls[0]!;
    expect(await backend.loadBlob(projectId, hash)).toBeNull();
    expect((await directory()).list(Date.now())).toEqual([]);
  });

  it("deletes the project's doc and blobs", async () => {
    const backend = new MemoryBackend();
    let hash = "";
    const created = await createStandaloneProject("Doomed", {
      backend,
      seed: async (_project, assets) => {
        hash = (await assets.store(new File(["data"], "d.bin"))).hash;
      },
    });
    expect(await backend.loadBlob(created.projectId, hash)).not.toBeNull();

    await deleteStandaloneProject(created.projectId, { backend });

    expect(await backend.loadBlob(created.projectId, hash)).toBeNull();
    expect((await backend.load(created.projectId)).snapshot).toBeNull();
    expect((await directory()).list(Date.now())).toMatchObject([
      { projectId: created.projectId, state: "forgotten" },
    ]);
  });
});
