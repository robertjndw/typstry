// @vitest-environment node
// Cross-language check against a running typstry-server. Skipped unless
// TYPSTRY_E2E=1; point TYPSTRY_E2E_URL at the server (default :8787), e.g.
//   TYPSTRY_DATA_DIR=$(mktemp -d) cargo run -p typstry-server
//   TYPSTRY_E2E=1 pnpm --filter web exec vitest run src/sync/e2e.test.ts
import { EphemeralStore, LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpaceCrypto } from "@/crypto/space-crypto";
import { newProject, viewerOf } from "@/crypto/test-utils";
import { getText } from "@/doc/fs-ops";
import { ProjectDoc, initProject, starterContent } from "@/doc/schema";

import { createSpace, resolveShare } from "./api";
import { connectSpace, type SpaceConnection } from "./connection";

const enabled = process.env.TYPSTRY_E2E === "1";
const baseUrl = process.env.TYPSTRY_E2E_URL ?? "http://127.0.0.1:8787";
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;

const open: SpaceConnection[] = [];

afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
});

function connect(
  spaceId: string,
  token: string,
  crypto: SpaceCrypto,
  opts: {
    canWrite?: boolean;
    ephemeral?: EphemeralStore;
    doc?: LoroDoc;
    onDecryptError?: (error: Error) => void;
  } = {},
) {
  const doc = opts.doc ?? new LoroDoc();
  const conn = connectSpace({
    spaceId,
    token,
    crypto,
    canWrite: opts.canWrite ?? true,
    doc,
    ephemeral: opts.ephemeral,
    url: wsUrl,
    onDecryptError: opts.onDecryptError,
  });
  open.push(conn);
  return { doc, conn, project: new ProjectDoc(doc) };
}

/** What the creator's browser does: register, then seed the doc locally. */
async function create(title: string) {
  const created = await createSpace({ baseUrl });
  const project = newProject();
  const seed = new LoroDoc();
  initProject(seed, { title });
  return { ...created, project, key: project.crypto, seed };
}

function mainText(project: ProjectDoc) {
  const id = project.mainFile;
  if (!id) throw new Error("no main file");
  return getText(project, id);
}

async function eventually(check: () => void, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe.skipIf(!enabled)("sync against a running server", () => {
  it("two JS clients converge through the Rust server", async () => {
    const created = await create("E2E");
    expect(await resolveShare(created.editToken, { baseUrl })).toEqual({
      spaceId: created.spaceId,
      permission: "write",
      viewToken: created.viewToken,
    });

    // The creator uploads the seed on first connect.
    const a = connect(created.spaceId, created.editToken, created.key, {
      doc: created.seed,
    });
    await a.conn.synced;
    const b = connect(created.spaceId, created.editToken, created.key);
    await b.conn.synced;
    await eventually(() => expect(a.conn.getStatus()).toBe("connected"));
    await eventually(() => expect(b.project.title).toBe("E2E"));
    expect(mainText(b.project).toString()).toBe(starterContent("E2E"));

    mainText(a.project).insert(0, "// from A\n");
    a.doc.commit();
    await eventually(() =>
      expect(mainText(b.project).toString()).toContain("// from A"),
    );

    // Concurrent edits on both sides.
    const textA = mainText(a.project);
    const textB = mainText(b.project);
    textA.insert(textA.length, "A tail\n");
    textB.insert(0, "B head\n");
    a.doc.commit();
    b.doc.commit();
    await eventually(() => {
      expect(a.doc.toJSON()).toEqual(b.doc.toJSON());
      expect(mainText(a.project).toString()).toContain("A tail");
      expect(mainText(a.project).toString()).toContain("B head");
    });

    // A late joiner loads the persisted state.
    const c = connect(
      created.spaceId,
      created.viewToken,
      viewerOf(created.project),
      {
        canWrite: false,
      },
    );
    await c.conn.synced;
    await eventually(() => expect(c.doc.toJSON()).toEqual(a.doc.toJSON()));
  });

  it("view tokens cannot write, and presence reaches others", async () => {
    const created = await create("Viewer");
    const editorStore = new EphemeralStore(30_000);
    const viewerStore = new EphemeralStore(30_000);
    const editor = connect(created.spaceId, created.editToken, created.key, {
      ephemeral: editorStore,
      doc: created.seed,
    });
    await editor.conn.synced;
    const viewer = connect(
      created.spaceId,
      created.viewToken,
      viewerOf(created.project),
      {
        ephemeral: viewerStore,
        canWrite: false,
      },
    );
    await viewer.conn.synced;
    await eventually(() => expect(viewer.project.mainFile).not.toBeNull());

    viewerStore.set("p:viewer", { name: "Vic" });
    await eventually(() =>
      expect(editorStore.get("p:viewer")).toEqual({ name: "Vic" }),
    );

    mainText(viewer.project).insert(0, "viewer edit\n");
    viewer.doc.commit();
    mainText(editor.project).insert(0, "editor edit\n");
    editor.doc.commit();
    await eventually(() =>
      expect(mainText(viewer.project).toString()).toContain("editor edit"),
    );

    const fresh = connect(created.spaceId, created.editToken, created.key);
    await fresh.conn.synced;
    await eventually(() => expect(fresh.project.mainFile).not.toBeNull());
    const text = mainText(fresh.project).toString();
    expect(text).toContain("editor edit");
    expect(text).not.toContain("viewer edit");
    editorStore.destroy();
    viewerStore.destroy();
  });

  it("a wrong key cannot read the project", async () => {
    const created = await create("Secret");
    const owner = connect(created.spaceId, created.editToken, created.key, {
      doc: created.seed,
    });
    await owner.conn.synced;
    await new Promise((r) => setTimeout(r, 200));

    const onDecryptError = vi.fn();
    const wrongKey = newProject().crypto;
    const intruder = connect(created.spaceId, created.viewToken, wrongKey, {
      canWrite: false,
      onDecryptError,
    });
    await eventually(() => expect(onDecryptError).toHaveBeenCalled());
    expect(intruder.project.title).toBe("");
  });

  it("rejects unknown tokens", async () => {
    const created = await create("Unknown");
    expect(await resolveShare("0000000000000000000000", { baseUrl })).toBe(
      null,
    );
    const bad = connect(created.spaceId, "0000000000000000000000", created.key);
    await expect(bad.conn.synced).rejects.toThrow();
    expect(bad.conn.getStatus()).toBe("disconnected");
  });
});
