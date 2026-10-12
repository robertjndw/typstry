import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RetryQueue } from "@/project/retry";

import {
  DsClient,
  DsDisconnectedError,
  type DsClientOptions,
  type Hello,
} from "./ds-client";
import { frames } from "./test-utils";

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }

  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: ArrayBuffer) {
    this.onmessage?.({ data });
  }

  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The binary frames sent, without keepalive text. */
  get frames(): Uint8Array[] {
    return this.sent
      .filter((d) => typeof d !== "string")
      .map((d) => new Uint8Array(d as ArrayBuffer));
  }
}

/** A retry queue that runs what is scheduled only when told to. */
class ManualRetry {
  scheduled: (() => void)[] = [];
  schedule(_key: string, run: () => void) {
    this.scheduled.push(run);
  }
  succeeded() {}
  dispose() {}
  runNext() {
    this.scheduled.shift()?.();
  }
}

function setup(overrides: Partial<DsClientOptions> = {}) {
  const retry = new ManualRetry();
  const messages: unknown[] = [];
  const events = { ready: 0, down: 0, fatal: [] as number[] };
  let hello: Hello | null = { incarnation: 2, sinceEpoch: 7 };
  const client = new DsClient({
    token: () => "tok",
    hello: () => hello,
    onMessage: (m) => messages.push(m),
    onReady: () => events.ready++,
    onDown: () => events.down++,
    onFatal: (code) => events.fatal.push(code),
    url: "ws://test/ws/mls?protocol=1",
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    retry: retry as unknown as RetryQueue,
    keepaliveMs: 1_000_000,
    ...overrides,
  });
  return {
    client,
    retry,
    messages,
    events,
    setHello: (h: Hello | null) => (hello = h),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const last = () => FakeSocket.all.at(-1)!;

beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("DsClient", () => {
  it("says hello with the token and the epoch it holds", async () => {
    const { client } = setup();
    client.start();
    await flush();
    const socket = last();
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    const [hello] = socket.frames;
    expect(hello![0]).toBe(1);
    expect(new TextDecoder().decode(hello)).toContain("tok");
    client.stop();
  });

  it("matches answers to requests by their number", async () => {
    const { client, events } = setup();
    client.start();
    await flush();
    const socket = last();
    socket.open();
    socket.receive(frames.ready(2, 7));
    expect(events.ready).toBe(1);

    const first = client.request({
      type: "submit",
      epoch: 7,
      commit: new Uint8Array(),
      groupInfo: new Uint8Array([1]),
    });
    const second = client.request({
      type: "submit",
      epoch: 7,
      commit: new Uint8Array(),
      groupInfo: new Uint8Array([2]),
    });
    await flush();
    const reqs = socket.frames.slice(1).map((f) => f[1]);
    expect(reqs).toEqual([1, 2]);

    // Answered out of order, each reaches its own caller.
    socket.receive(frames.conflict(2, 9));
    socket.receive(frames.accepted(1));
    await expect(first).resolves.toEqual({ type: "accepted" });
    await expect(second).resolves.toEqual({ type: "conflict", head: 9 });
    client.stop();
  });

  it("sends a signed rotation and hears the server refuse it as not the owner's", async () => {
    const { client } = setup();
    client.start();
    await flush();
    const socket = last();
    socket.open();
    socket.receive(frames.ready(1, 3));

    const reply = client.request({
      type: "submit",
      epoch: 3,
      commit: new Uint8Array([1]),
      groupInfo: new Uint8Array([2]),
      keyring: new Uint8Array([3]),
      envelope: new Uint8Array([4]),
      rotate: {
        editToken: "e",
        viewToken: "v",
        nextOwnerKey: new Uint8Array(32).fill(5),
        ownerProof: new Uint8Array(64).fill(6),
      },
    });
    await flush();
    const sent = socket.frames.at(-1)!;
    // Both owner fields go out whole.
    expect(sent.join(",")).toContain(new Array(32).fill(5).join(","));
    expect(sent.join(",")).toContain(new Array(64).fill(6).join(","));
    socket.receive(frames.refused(sent[1]!, "notOwner"));
    await expect(reply).resolves.toEqual({
      type: "refused",
      code: "notOwner",
    });
    client.stop();
  });

  it("passes everything else to the owner", async () => {
    const { client, messages } = setup();
    client.start();
    await flush();
    const socket = last();
    socket.open();
    socket.receive(frames.ready(0, 1));
    socket.receive(frames.commit(3, new Uint8Array([9, 9])));
    socket.receive(
      frames.commit(4, new Uint8Array([8]), new Uint8Array(32).fill(5)),
    );
    socket.receive(frames.reinitialized(5));
    expect(messages).toEqual([
      { type: "commit", epoch: 3, commit: new Uint8Array([9, 9]) },
      {
        type: "commit",
        epoch: 4,
        commit: new Uint8Array([8]),
        ownerKey: new Uint8Array(32).fill(5),
      },
      { type: "reinitialized", incarnation: 5 },
    ]);
    client.stop();
  });

  it("makes a request wait for the socket to be ready", async () => {
    const { client } = setup();
    client.start();
    await flush();
    const socket = last();
    socket.open();
    const pending = client.request({
      type: "submit",
      epoch: 1,
      commit: new Uint8Array(),
      groupInfo: new Uint8Array(),
    });
    await flush();
    expect(socket.frames).toHaveLength(1);
    socket.receive(frames.ready(0, 1));
    await flush();
    expect(socket.frames).toHaveLength(2);
    socket.receive(frames.accepted(1));
    await expect(pending).resolves.toEqual({ type: "accepted" });
    client.stop();
  });

  it("fails what was in flight when the socket drops, then reconnects", async () => {
    const { client, retry, events, setHello } = setup();
    client.start();
    await flush();
    const first = last();
    first.open();
    first.receive(frames.ready(2, 7));
    const pending = client.request({
      type: "submit",
      epoch: 1,
      commit: new Uint8Array(),
      groupInfo: new Uint8Array(),
    });
    await flush();
    first.drop();
    await expect(pending).rejects.toBeInstanceOf(DsDisconnectedError);
    expect(events.down).toBe(1);
    expect(retry.scheduled).toHaveLength(1);

    // The hello is made again, from what the owner knows by then.
    setHello({ incarnation: 2, sinceEpoch: 12 });
    retry.runNext();
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    expect(client.ready).toBeNull();
    client.stop();
  });

  it("gives up on a request the server never answers and restarts the socket", async () => {
    const { client } = setup({ replyTimeoutMs: 50 });
    client.start();
    await flush();
    const first = last();
    first.open();
    first.receive(frames.ready(2, 7));
    const pending = client.request({
      type: "submit",
      epoch: 1,
      commit: new Uint8Array(),
      groupInfo: new Uint8Array(),
    });
    await expect(pending).rejects.toBeInstanceOf(DsDisconnectedError);
    await flush();
    // A silent socket may be half dead: it is replaced, not kept.
    expect(first.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    client.stop();
  });

  it("does not retry a token the server closed on", async () => {
    const { client, retry, events } = setup();
    client.start();
    await flush();
    last().open();
    last().drop(1008, "auth_failed");
    expect(events.fatal).toEqual([1008]);
    expect(retry.scheduled).toHaveLength(0);
  });

  it("waits and tries again when there is nothing to say hello with", async () => {
    const { client, retry, setHello } = setup();
    setHello(null);
    client.start();
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    expect(retry.scheduled).toHaveLength(1);
    setHello({ incarnation: 0, sinceEpoch: 0 });
    retry.runNext();
    await flush();
    expect(FakeSocket.all).toHaveLength(1);
    client.stop();
  });

  it("moves to a new socket on restart", async () => {
    const { client } = setup();
    client.start();
    await flush();
    const first = last();
    first.open();
    first.receive(frames.ready(0, 1));
    client.restart();
    await flush();
    expect(first.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    // Late frames of the old socket are ignored.
    first.receive(frames.ready(0, 5));
    expect(client.ready).toBeNull();
    client.stop();
  });

  it("sends a keepalive while connected", async () => {
    vi.useFakeTimers();
    const { client } = setup({ keepaliveMs: 30_000 });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = last();
    socket.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.filter((d) => d === "ping")).toHaveLength(1);
    client.stop();
  });
});
