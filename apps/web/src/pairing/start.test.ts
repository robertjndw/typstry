import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryBackend } from "@/persist/local-doc-store";

import { startShowing } from "./start";

afterEach(() => vi.unstubAllGlobals());

describe("startShowing", () => {
  it("opens the socket on the host that allocated the channel", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () =>
      Response.json({ channel: 7, claim: "c", expiresIn: 60 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const urls: string[] = [];
    const { session } = await startShowing("Laptop", {
      backend: new MemoryBackend(),
      baseUrl: "https://relay.example",
      createSocket: (url) => {
        urls.push(url);
        return { close() {} } as unknown as WebSocket;
      },
    });
    session.close();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://relay.example/api/relay");
    expect(urls).toHaveLength(1);
    const socket = new URL(urls[0]!);
    expect(socket.protocol).toBe("wss:");
    expect(socket.host).toBe("relay.example");
    expect(socket.searchParams.get("channel")).toBe("7");
  });
});
