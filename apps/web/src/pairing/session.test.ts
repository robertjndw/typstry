import { describe, expect, it, vi } from "vitest";

import {
  DeviceKey,
  PairingCode,
  PersonGraph,
  deviceFingerprint,
} from "@/crypto/wasm";

import { MemoryBackend } from "@/persist/local-doc-store";

import {
  GrantRefusedError,
  PairSession,
  type Grant,
  type PairRole,
  type PairingDevice,
} from "./session";
import { someSpace } from "./test-utils";

/** Two sockets joined like the relay does, which holds frames for a late peer. */
class FakeRelay {
  private seats: FakeSocket[] = [];

  socket(): WebSocket {
    const socket = new FakeSocket(this);
    this.seats.push(socket);
    return socket as unknown as WebSocket;
  }

  forward(from: FakeSocket, frame: Uint8Array) {
    const to = this.seats.find((s) => s !== from);
    queueMicrotask(() => to?.deliver(frame));
  }

  closeAll(code: number, reason: string) {
    for (const s of this.seats) s.serverClose(code, reason);
  }
}

class FakeSocket {
  binaryType = "blob";
  readyState = 1;
  pings = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  private readonly relay: FakeRelay;

  constructor(relay: FakeRelay) {
    this.relay = relay;
    queueMicrotask(() => this.onopen?.());
  }

  send(frame: Uint8Array | string) {
    if (typeof frame === "string") {
      this.pings++;
      return;
    }
    this.relay.forward(this, frame);
  }

  close() {
    this.closed = true;
  }

  deliver(frame: Uint8Array) {
    const copy = frame.slice().buffer;
    this.onmessage?.({ data: copy });
  }

  serverClose(code: number, reason: string) {
    this.onclose?.({ code, reason });
  }
}

const DEVICE = DeviceKey.generate();
const GRAPH = PersonGraph.genesis(DEVICE.export()).encode();
const SPACE = await someSpace(new MemoryBackend());

function holder(onGrant?: (device: PairingDevice) => void): PairRole {
  return {
    kind: "holder",
    grant: async (device) => {
      onGrant?.(device);
      return { graph: GRAPH, holderName: "Desk", space: SPACE };
    },
  };
}

function newDevice(
  onGrant: (grant: Grant) => Promise<void> = async () => {},
  devicePub: Uint8Array = DeviceKey.generate().publicKey(),
): PairRole {
  return { kind: "new", deviceName: "Laptop", devicePub, onGrant };
}

function pair(
  codes: [PairingCode, PairingCode],
  roles: [PairRole, PairRole],
  keepaliveMs?: number,
) {
  const relay = new FakeRelay();
  const sessions = roles.map(
    (role, i) =>
      new PairSession({
        code: codes[i]!,
        role,
        url: "wss://relay.test",
        createSocket: () => relay.socket(),
        keepaliveMs,
      }),
  );
  for (const s of sessions) s.start();
  return { relay, a: sessions[0]!, b: sessions[1]! };
}

async function until(session: PairSession, status: string) {
  for (let i = 0; i < 200; i++) {
    if (session.state.status === status) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`stuck at ${session.state.status}, wanted ${status}`);
}

function codes(): [PairingCode, PairingCode] {
  const text = PairingCode.generate(42).toString();
  return [PairingCode.parse(text), PairingCode.parse(text)];
}

describe("PairSession", () => {
  it("hands the graph and the space to the new device after approval", async () => {
    let received: Uint8Array | null = null;
    let holderName = "";
    let space: Grant["space"] | null = null;
    const devicePub = DeviceKey.generate().publicKey();
    const { a, b } = pair(codes(), [
      holder(),
      newDevice(async (grant) => {
        received = grant.graph.slice();
        holderName = grant.holderName;
        space = grant.space;
      }, devicePub),
    ]);
    await until(a, "awaitingApproval");
    // Both sides derive the same fingerprint from the key, which is what the
    // user compares.
    expect(a.state).toEqual({
      status: "awaitingApproval",
      deviceName: "Laptop",
      fingerprint: deviceFingerprint(devicePub),
    });
    expect(b.ownFingerprint).toBe(deviceFingerprint(devicePub));
    expect(a.ownFingerprint).toBeNull();
    await a.approve();
    await until(b, "done");
    expect(received).toEqual(GRAPH);
    expect(holderName).toBe("Desk");
    expect(space).toEqual(SPACE);
    expect(b.state).toEqual({ status: "done" });
    expect(a.state).toEqual({ status: "done" });
  });

  it("gives the holder the name and key of the device it approves", async () => {
    const pub = DeviceKey.generate().publicKey();
    let asked: PairingDevice | null = null;
    const { a, b } = pair(codes(), [
      holder((device) => (asked = device)),
      newDevice(undefined, pub),
    ]);
    await until(a, "awaitingApproval");
    await a.approve();
    await until(b, "done");
    expect(asked).toEqual({ name: "Laptop", pub });
  });

  it("tells the new device when the holder rejects it", async () => {
    const { a, b } = pair(codes(), [holder(), newDevice()]);
    await until(a, "awaitingApproval");
    a.reject();
    await until(b, "rejected");
    expect(a.state.status).toBe("rejected");
  });

  it("fails on both sides for a wrong code", async () => {
    const right = PairingCode.generate(42).toString();
    // Same channel, other words (retry until they differ).
    let wrong = right;
    while (wrong === right) wrong = PairingCode.generate(42).toString();
    const { a, b } = pair(
      [PairingCode.parse(right), PairingCode.parse(wrong)],
      [holder(), newDevice()],
    );
    await until(a, "failed");
    await until(b, "failed");
    expect(a.state).toMatchObject({ reason: "wrongCode" });
    expect(b.state).toMatchObject({ reason: "wrongCode" });
  });

  it("reports a role conflict when both devices are holders", async () => {
    const { a, b } = pair(codes(), [holder(), holder()]);
    await until(a, "failed");
    await until(b, "failed");
    expect(a.state).toMatchObject({ reason: "roleConflict" });
  });

  it("fails when the new device refuses the grant", async () => {
    const { a, b } = pair(codes(), [
      holder(),
      newDevice(async () => {
        throw new GrantRefusedError("other person");
      }),
    ]);
    await until(a, "awaitingApproval");
    await a.approve();
    await until(b, "failed");
    expect(b.state).toMatchObject({ reason: "refused" });
  });

  it("ignores a second approve and a reject while the grant is built", async () => {
    let release!: () => void;
    let grants = 0;
    const slow: PairRole = {
      kind: "holder",
      grant: async () => {
        grants++;
        await new Promise<void>((resolve) => (release = resolve));
        return { graph: GRAPH, holderName: "Desk", space: SPACE };
      },
    };
    const devicePub = DeviceKey.generate().publicKey();
    const { a, b } = pair(codes(), [slow, newDevice(undefined, devicePub)]);
    await until(a, "awaitingApproval");
    const first = a.approve();
    expect(a.state).toEqual({
      status: "approving",
      deviceName: "Laptop",
      fingerprint: deviceFingerprint(devicePub),
    });
    await a.approve();
    a.reject();
    expect(a.state.status).toBe("approving");
    release();
    await first;
    await until(b, "done");
    expect(grants).toBe(1);
    expect(a.state.status).toBe("done");
  });

  it("fails an approval whose grant the holder refuses", async () => {
    const refusing: PairRole = {
      kind: "holder",
      grant: async () => {
        throw new GrantRefusedError("removed");
      },
    };
    const { a } = pair(codes(), [refusing, newDevice()]);
    await until(a, "awaitingApproval");
    await a.approve();
    expect(a.state).toMatchObject({ status: "failed", reason: "refused" });
  });

  describe("keepalive", () => {
    it("pings while the holder's user decides, and stops when over", async () => {
      vi.useFakeTimers();
      try {
        const { relay, a } = pair(codes(), [holder(), newDevice()], 30_000);
        const socket = (relay as unknown as { seats: FakeSocket[] }).seats[0]!;
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(95_000);
        expect(socket.pings).toBe(3);
        a.close();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(socket.pings).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("maps the relay's closes to a reason", async () => {
    const closes: [number, string, string][] = [
      [1008, "no_channel", "expired"],
      [1008, "expired", "expired"],
      [1008, "rate_limited", "rateLimited"],
      [1008, "too_many_frames", "stalled"],
      [1000, "peer_left", "peerLeft"],
      [1006, "", "network"],
    ];
    for (const [code, reason, expected] of closes) {
      const { relay, a } = pair(codes(), [holder(), newDevice()]);
      relay.closeAll(code, reason);
      expect(a.state).toMatchObject({ status: "failed", reason: expected });
    }
  });

  it("closes the socket and ignores a close after it is over", async () => {
    const { relay, a, b } = pair(codes(), [holder(), newDevice()]);
    await until(a, "awaitingApproval");
    await a.approve();
    await until(b, "done");
    relay.closeAll(1000, "peer_left");
    expect(a.state.status).toBe("done");
    expect(b.state.status).toBe("done");
  });
});
