import { afterEach, describe, expect, it, vi } from "vitest";

import { frames } from "@/mls/test-utils";
import { MemoryBackend } from "@/persist/local-doc-store";
import { loadSpaceKey } from "@/space/space-links";

import { loadBinding } from "./binding";
import { ensureSpace } from "./ensure-space";
import { token } from "./test-utils";

class ServerSocket {
  binaryType = "";
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: Uint8Array) {
    if (data[0] === 1) this.reply(frames.ready(0, 0, "write"));
    if (data[0] === 4) this.reply(frames.accepted(1));
  }

  private reply(data: ArrayBuffer) {
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function server() {
  const fetchMock = vi.fn(async () =>
    Response.json(
      { spaceId: "space", editToken: token(1), viewToken: token(2) },
      { status: 201 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ds = { createSocket: () => new ServerSocket() as unknown as WebSocket };

describe("ensureSpace", () => {
  it("creates the space once and keeps the owner secrets and binding", async () => {
    const fetchMock = server();
    const backend = new MemoryBackend();
    const [a, b] = await Promise.all([
      ensureSpace({ backend, ds }),
      ensureSpace({ backend, ds }),
    ]);

    // Two callers (tabs) must not make two spaces.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(loadBinding()).toEqual(a);
    expect(a.spaceId).toBe("space");
    expect(loadSpaceKey("space")).toBe(a.secret);
    expect((await backend.loadMls("space"))?.ownerSecrets).toBeInstanceOf(
      Uint8Array,
    );
    // Later calls find the binding and ask nobody.
    await ensureSpace({ backend, ds });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves no binding when the server refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    await expect(
      ensureSpace({ backend: new MemoryBackend() }),
    ).rejects.toThrow();
    expect(loadBinding()).toBeNull();
  });
});
