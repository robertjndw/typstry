// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  blobUrl,
  createProject,
  resolveShare,
  uploadBlob,
} from "./api";

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn<typeof fetch>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProject", () => {
  it("posts nothing but the request and returns the tokens", async () => {
    const created = { projectId: "p", editToken: "e", viewToken: "v" };
    const fetch = mockFetch(201, created);
    await expect(createProject()).resolves.toEqual(created);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/projects");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("throws ApiError on failure", async () => {
    mockFetch(500);
    await expect(createProject()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("resolveShare", () => {
  it("returns project and permission", async () => {
    const fetch = mockFetch(200, { projectId: "p", permission: "read" });
    await expect(
      resolveShare("tok/en", { baseUrl: "http://x" }),
    ).resolves.toEqual({ projectId: "p", permission: "read" });
    expect(fetch.mock.calls[0]![0]).toBe("http://x/api/share/tok%2Fen");
  });

  it("returns null for unknown tokens", async () => {
    mockFetch(404);
    await expect(resolveShare("nope")).resolves.toBeNull();
  });
});

describe("uploadBlob", () => {
  it("posts only the bytes, without the file name", async () => {
    const stored = { hash: "sha256:00", size: 3 };
    const fetch = mockFetch(201, stored);
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(uploadBlob("tok", bytes, "my logo.png")).resolves.toEqual(
      stored,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/p/tok/assets");
    expect(init?.method).toBe("POST");
    expect(init?.body).toEqual(bytes);
    expect(JSON.stringify(init)).not.toContain("logo");
  });

  it("explains size and permission failures", async () => {
    const empty = new Uint8Array();
    mockFetch(413);
    await expect(uploadBlob("tok", empty, "a.pdf")).rejects.toThrow(
      /a.pdf is larger than 25 MB/,
    );
    mockFetch(403);
    await expect(uploadBlob("tok", empty, "a.pdf")).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("blobUrl", () => {
  it("encodes the hash into the path", () => {
    expect(blobUrl("tok", "sha256:ab", { baseUrl: "http://h" })).toBe(
      "http://h/api/p/tok/blobs/sha256%3Aab",
    );
  });
});
