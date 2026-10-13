// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  blobUrl,
  createSpace,
  OutdatedClientError,
  RATE_LIMIT_RETRIES,
  RATE_LIMITED_MESSAGE,
  RateLimitedError,
  resolveShare,
  retryAfterMs,
  STORAGE_FULL_MESSAGE,
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

/** Answers with each of `statuses` in turn, then keeps answering the last. */
function mockFetchSequence(
  statuses: number[],
  body: unknown,
  headers: Record<string, string> = {},
) {
  let call = 0;
  const fn = vi.fn<typeof fetch>(async () => {
    const status = statuses[Math.min(call++, statuses.length - 1)]!;
    const ok = status >= 200 && status < 300;
    return new Response(ok ? JSON.stringify(body) : null, {
      status,
      headers: ok ? {} : headers,
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createSpace", () => {
  it("posts nothing but the request and returns the tokens", async () => {
    const created = { spaceId: "p", editToken: "e", viewToken: "v" };
    const fetch = mockFetch(201, created);
    await expect(createSpace()).resolves.toEqual(created);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/spaces");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("throws ApiError on failure", async () => {
    mockFetch(500);
    await expect(createSpace()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("resolveShare", () => {
  it("returns project and permission", async () => {
    const fetch = mockFetch(200, { spaceId: "p", permission: "read" });
    await expect(
      resolveShare("tok/en", { baseUrl: "http://x" }),
    ).resolves.toEqual({ spaceId: "p", permission: "read" });
    expect(fetch.mock.calls[0]![0]).toBe("http://x/api/share/tok%2Fen");
  });

  it("passes the view token through for edit tokens", async () => {
    mockFetch(200, { spaceId: "p", permission: "write", viewToken: "v" });
    await expect(resolveShare("e")).resolves.toEqual({
      spaceId: "p",
      permission: "write",
      viewToken: "v",
    });
  });

  it("ignores a malformed view token", async () => {
    mockFetch(200, { spaceId: "p", permission: "write", viewToken: 5 });
    await expect(resolveShare("e")).resolves.toEqual({
      spaceId: "p",
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
    expect(url).toBe("/api/s/tok/assets");
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

describe("storage and rate limits", () => {
  const stored = { hash: "sha256:00", size: 1 };
  const bytes = new Uint8Array([1]);

  it("says the project is full on a 507, without retrying", async () => {
    const fetch = mockFetch(507);
    await expect(uploadBlob("tok", bytes, "a.png")).rejects.toMatchObject({
      status: 507,
      message: STORAGE_FULL_MESSAGE,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries an upload after a 429 with the same body", async () => {
    vi.useFakeTimers();
    const fetch = mockFetchSequence([429, 429, 201], stored);
    const upload = uploadBlob("tok", bytes, "a.png");
    await vi.runAllTimersAsync();
    await expect(upload).resolves.toEqual(stored);
    expect(fetch).toHaveBeenCalledTimes(3);
    const [first, last] = [fetch.mock.calls[0]!, fetch.mock.calls[2]!];
    expect(last[1]?.body).toEqual(first[1]?.body);
  });

  it("gives up after a few 429s with a friendly message", async () => {
    vi.useFakeTimers();
    const fetch = mockFetchSequence([429], stored);
    const created = createSpace().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await created;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, message: RATE_LIMITED_MESSAGE });
    expect(fetch).toHaveBeenCalledTimes(RATE_LIMIT_RETRIES + 1);
  });

  it("backs off, or waits as long as Retry-After says", async () => {
    vi.useFakeTimers();
    let fetch = mockFetchSequence([429, 429, 201], stored);
    let upload = uploadBlob("tok", bytes, "a.png");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The second wait doubles.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(upload).resolves.toEqual(stored);

    fetch = mockFetchSequence([429, 201], stored, { "retry-after": "5" });
    upload = uploadBlob("tok", bytes, "a.png");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(upload).resolves.toEqual(stored);
  });

  it("stops waiting when aborted", async () => {
    vi.useFakeTimers();
    const fetch = mockFetchSequence([429], stored);
    const abort = new AbortController();
    const created = createSpace({ signal: abort.signal }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new Error("gone"));
    await expect(created).resolves.toMatchObject({ message: "gone" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads Retry-After as seconds or as a date", () => {
    const res = (value?: string) =>
      new Response(null, {
        status: 429,
        headers: value === undefined ? {} : { "retry-after": value },
      });
    expect(retryAfterMs(res())).toBeNull();
    expect(retryAfterMs(res("3"))).toBe(3000);
    expect(retryAfterMs(res("soon"))).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs(res("Thu, 01 Jan 2026 00:00:10 GMT"), now)).toBe(
      10_000,
    );
    expect(retryAfterMs(res("Wed, 31 Dec 2025 00:00:00 GMT"), now)).toBe(0);
  });
});

describe("blobUrl", () => {
  it("encodes the hash into the path", () => {
    expect(blobUrl("tok", "sha256:ab", { baseUrl: "http://h" })).toBe(
      "http://h/api/s/tok/blobs/sha256%3Aab",
    );
  });
});

describe("protocol version", () => {
  it("goes with every call", async () => {
    const fetch = mockFetch(200, { spaceId: "p", permission: "read" });
    await resolveShare("t");
    mockFetch(201, { spaceId: "p", editToken: "e", viewToken: "v" });
    await createSpace();
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
