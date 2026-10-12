// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  blobUrl,
  createProject,
  OutdatedClientError,
  resolveShare,
  uploadBlob,
} from "./api";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, RELOAD_MESSAGE } from "./protocol";

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

  it("passes the view token through for edit tokens", async () => {
    mockFetch(200, { projectId: "p", permission: "write", viewToken: "v" });
    await expect(resolveShare("e")).resolves.toEqual({
      projectId: "p",
      permission: "write",
      viewToken: "v",
    });
  });

  it("ignores a malformed view token", async () => {
    mockFetch(200, { projectId: "p", permission: "write", viewToken: 5 });
    await expect(resolveShare("e")).resolves.toEqual({
      projectId: "p",
      permission: "write",
    });
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

describe("protocol version", () => {
  it("goes with every call", async () => {
    const fetch = mockFetch(200, { projectId: "p", permission: "read" });
    await resolveShare("t");
    mockFetch(201, { projectId: "p", editToken: "e", viewToken: "v" });
    await createProject();
    const upload = mockFetch(200, { hash: "sha256:00", size: 1 });
    await uploadBlob("t", new Uint8Array([1]), "a.png");
    for (const call of [fetch.mock.calls[0]!, upload.mock.calls[0]!]) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
    }
    // Keeps the call's own headers.
    expect(
      new Headers(upload.mock.calls[0]![1]?.headers).get("content-type"),
    ).toBe("application/octet-stream");
  });

  it("turns a 426 into the error that asks for a reload", async () => {
    mockFetch(426, { error: "too old" });
    const err = await resolveShare("t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutdatedClientError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toBe(RELOAD_MESSAGE);
  });
});
