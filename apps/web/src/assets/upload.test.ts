// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { BLOB_OVERHEAD } from "@/crypto/project-crypto";
import { newProject as newKeys } from "@/crypto/test-utils";
import { createFile, getText } from "@/doc/fs-ops";
import { NODE, initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { AssetCache, contentHash } from "@/typst/asset-cache";

import { projectAssets } from "./project-assets";
import { freeName, uploadFiles } from "./upload";

const TOKEN = "e".repeat(22);
const key = newKeys().crypto;
const ASSETS = projectAssets(TOKEN, key, {
  cache: new AssetCache({ caches: null }),
});

function mockUploads() {
  const fn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = init?.body as Uint8Array;
    return new Response(
      JSON.stringify({
        hash: await contentHash(body),
        size: body.length,
      }),
      { status: 201 },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function setup() {
  return initProject(newProject(1), { title: "T" });
}

function nodeData(project: ReturnType<typeof setup>, id: string) {
  return project.fs.getNodeByID(id as `${number}@${number}`)!.data;
}

afterEach(() => vi.unstubAllGlobals());

describe("uploadFiles", () => {
  it("imports text formats as text and uploads the rest", async () => {
    const fetch = mockUploads();
    const project = setup();
    const result = await uploadFiles(
      project,
      ASSETS,
      [
        new File(["@book{a,\r\n  title={X}\r\n}\r\n"], "refs.bib"),
        new File([new Uint8Array([137, 80, 78, 71])], "logo.png", {
          type: "image/png",
        }),
        new File([new Uint8Array([0, 1, 0, 0])], "Inter.ttf"),
      ],
      null,
    );

    expect(result.errors).toEqual([]);
    expect(result.created.map((f) => [f.name, f.kind])).toEqual([
      ["refs.bib", "text"],
      ["logo.png", "asset"],
      ["Inter.ttf", "asset"],
    ]);
    expect(getText(project, result.created[0]!.id).toString()).toBe(
      "@book{a,\n  title={X}\n}\n",
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    // Both uploads run concurrently, so either may have been sent first.
    const sent = await Promise.all(
      fetch.mock.calls.map(async ([url, init]) => {
        expect(url).toBe(`/api/p/${TOKEN}/assets`);
        expect(init?.method).toBe("POST");
        // Only ciphertext leaves the browser.
        const body = init?.body as Uint8Array;
        expect(body.length).toBe(4 + BLOB_OVERHEAD);
        return Array.from(key.openBlob(body));
      }),
    );
    expect(sent).toContainEqual([137, 80, 78, 71]);

    const logo = nodeData(project, result.created[1]!.id);
    expect(logo.get(NODE.kind)).toBe("asset");
    expect(logo.get(NODE.hash)).toMatch(/^sha256:/);
    expect(logo.get(NODE.size)).toBe(4);
    expect(logo.get(NODE.mime)).toBe("image/png");
    const font = nodeData(project, result.created[2]!.id);
    expect(font.get(NODE.mime)).toBe("font/ttf");
  });

  it("writes a text file in a single commit", async () => {
    mockUploads();
    const project = setup();
    const before = project.doc.oplogVersion();
    const changes = () =>
      project.doc
        .exportJsonUpdates(before, project.doc.oplogVersion())
        .changes.filter((c) => c.ops.length > 0).length;
    await uploadFiles(project, ASSETS, [new File(["a\r\nb"], "x.typ")], null);
    expect(changes()).toBe(1);
  });

  it("suffixes clashing names before the extension", async () => {
    mockUploads();
    const project = setup();
    createFile(project, null, "logo.png", "text");
    const result = await uploadFiles(
      project,
      ASSETS,
      [
        new File(["x"], "main.typ"),
        new File([new Uint8Array([1])], "logo.png"),
        new File([new Uint8Array([2])], "logo.png"),
      ],
      null,
    );
    expect(result.errors).toEqual([]);
    expect(result.created.map((f) => f.name).sort()).toEqual([
      "logo (2).png",
      "logo (3).png",
      "main (2).typ",
    ]);
  });

  it("stores non-UTF-8 text formats as blobs", async () => {
    const fetch = mockUploads();
    const project = setup();
    const latin1 = new Uint8Array([0x40, 0x62, 0xe9, 0x0a]); // "@bé\n"
    const result = await uploadFiles(
      project,
      ASSETS,
      [new File([latin1], "old.bib")],
      null,
    );
    expect(result.created[0]?.kind).toBe("asset");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports failures per file without touching the doc", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 413 })),
    );
    const project = setup();
    const before = project.doc.oplogVersion();
    const result = await uploadFiles(
      project,
      ASSETS,
      [new File([new Uint8Array([1])], "big.pdf"), new File([""], "a/b.typ")],
      null,
    );
    expect(result.created).toEqual([]);
    expect(result.errors.map((e) => e.name)).toEqual(["big.pdf", "a/b.typ"]);
    expect(result.errors[0]!.error.message).toMatch(/larger than 25 MB/);
    expect(project.doc.oplogVersion().compare(before)).toBe(0);
  });
});

describe("freeName", () => {
  it("handles dotfiles and names without extension", () => {
    const project = setup();
    createFile(project, null, ".gitignore", "text");
    createFile(project, null, "README", "text");
    expect(freeName(project, null, ".gitignore")).toBe(".gitignore (2)");
    expect(freeName(project, null, "README")).toBe("README (2)");
    expect(freeName(project, null, "new.typ")).toBe("new.typ");
  });

  it("looks only at siblings in the target folder", () => {
    const project = setup();
    const dir = createFile(project, null, "img", "dir");
    expect(freeName(project, dir, "main.typ")).toBe("main.typ");
  });
});
