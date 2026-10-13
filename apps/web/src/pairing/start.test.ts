import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceKey, PersonGraph } from "@/crypto/wasm";
import { localIdentity, mergeOwnGraph } from "@/mls/identity";
import { MemoryBackend } from "@/persist/local-doc-store";
import { seedProject } from "@/directory/test-utils";
import { RateLimitedError } from "@/sync/api";

import { allocateChannel } from "./relay";
import { isDisposable, startShowing } from "./start";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isDisposable", () => {
  it("is false for a browser that is no person yet", async () => {
    expect(await isDisposable(new MemoryBackend())).toBe(false);
  });

  it("is true for a person with only this device that owns nothing", async () => {
    const backend = new MemoryBackend();
    await localIdentity(backend);
    await seedProject("p1", 1, { title: "Shared" });
    expect(await isDisposable(backend)).toBe(true);
  });

  it("is false once the person has another device", async () => {
    const backend = new MemoryBackend();
    const { deviceSeed, graph } = await localIdentity(backend);
    const grown = PersonGraph.decode(graph);
    grown.addDevice(deviceSeed, DeviceKey.generate().publicKey());
    await mergeOwnGraph(backend, grown.encode());
    grown.free();
    expect(await isDisposable(backend)).toBe(false);
  });

  it("is false when the person owns a project here", async () => {
    const backend = new MemoryBackend();
    const { graph } = await localIdentity(backend);
    const decoded = PersonGraph.decode(graph);
    const person = decoded.id();
    decoded.free();
    await seedProject("p1", 1, { title: "Mine" });
    await backend.saveMls("p1", {
      state: new Uint8Array([1]),
      device: null,
      removed: false,
      rotation: null,
      ownerPerson: person,
    });
    expect(await isDisposable(backend)).toBe(false);
  });
});

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

describe("allocateChannel", () => {
  it("retries a 429 and then reports it plainly", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(null, { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const allocated = allocateChannel().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await allocated).toBeInstanceOf(RateLimitedError);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
