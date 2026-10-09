// @vitest-environment node
import { LoroDoc } from "loro-crdt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateRawProjectKey, importProjectKey } from "@/crypto/project-key";

import { connectProject, projectWsUrl, type SyncStatus } from "./connection";

const key = await importProjectKey(generateRawProjectKey());

type StatusCb = (s: string) => void;

interface FakeJoin {
  roomId: string;
  crdtAdaptor: { crdtType: string; destroy(): void };
  auth: Uint8Array;
  onStatusChange?: StatusCb;
  resolve: (room: unknown) => void;
  reject: (err: Error) => void;
}

const fake = vi.hoisted(() => ({
  clients: [] as {
    url: string;
    statusCbs: Set<(s: string) => void>;
    joins: unknown[];
    destroyed: boolean;
  }[],
}));

vi.mock("loro-websocket", () => ({
  LoroWebsocketClient: class {
    statusCbs = new Set<StatusCb>();
    joins: FakeJoin[] = [];
    destroyed = false;
    url: string;
    constructor(opts: { url: string }) {
      this.url = opts.url;
      fake.clients.push(this);
    }
    onStatusChange(cb: StatusCb) {
      this.statusCbs.add(cb);
      cb("connecting");
      return () => this.statusCbs.delete(cb);
    }
    join(opts: Omit<FakeJoin, "resolve" | "reject">) {
      return new Promise((resolve, reject) => {
        this.joins.push({ ...opts, resolve, reject });
      });
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));

function lastClient() {
  const client = fake.clients.at(-1)!;
  return {
    ...client,
    joins: client.joins as FakeJoin[],
    setStatus: (s: string) => client.statusCbs.forEach((cb) => cb(s)),
  };
}

beforeEach(() => {
  fake.clients.length = 0;
});

describe("projectWsUrl", () => {
  it("follows the page protocol", () => {
    expect(projectWsUrl({ protocol: "https:", host: "a.b" })).toBe(
      "wss://a.b/ws",
    );
    expect(projectWsUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/ws",
    );
  });
});

describe("connectProject", () => {
  it("joins doc and presence rooms with the token as auth", () => {
    const conn = connectProject({
      projectId: "proj",
      token: "tok",
      key,
      canWrite: true,
      doc: new LoroDoc(),
      ephemeral: {} as never,
      url: "ws://x/ws",
    });
    const client = lastClient();
    expect(client.url).toBe("ws://x/ws");
    expect(client.joins.map((j) => j.crdtAdaptor.crdtType)).toEqual([
      "%ELO",
      "%EPH",
    ]);
    for (const join of client.joins) {
      expect(join.roomId).toBe("proj");
      expect(new TextDecoder().decode(join.auth)).toBe("tok");
    }
    conn.close();
  });

  it("is connected only once the socket is open and the doc room joined", () => {
    const conn = connectProject({
      projectId: "p",
      token: "t",
      key,
      canWrite: true,
      doc: new LoroDoc(),
      url: "ws://x/ws",
    });
    const seen: SyncStatus[] = [];
    conn.subscribe((s) => seen.push(s));
    const client = lastClient();
    const docJoin = client.joins[0]!;

    client.setStatus("connected");
    expect(conn.getStatus()).toBe("connecting");
    docJoin.onStatusChange?.("joined");
    expect(conn.getStatus()).toBe("connected");

    client.setStatus("disconnected");
    docJoin.onStatusChange?.("reconnecting");
    expect(conn.getStatus()).toBe("disconnected");
    client.setStatus("connecting");
    expect(conn.getStatus()).toBe("connecting");

    expect(seen).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connecting",
    ]);
    conn.close();
  });

  it("gives up and rejects synced when the join fails", async () => {
    const conn = connectProject({
      projectId: "p",
      token: "bad",
      key,
      canWrite: true,
      doc: new LoroDoc(),
      url: "ws://x/ws",
    });
    const client = lastClient();
    client.joins[0]!.onStatusChange?.("error");
    client.joins[0]!.reject(new Error("Join failed: 2 - auth_failed"));

    await expect(conn.synced).rejects.toThrow("auth_failed");
    expect(conn.getStatus()).toBe("disconnected");
    expect(fake.clients.at(-1)!.destroyed).toBe(true);
  });

  it("close() stops the client and detaches adaptors", () => {
    const conn = connectProject({
      projectId: "p",
      token: "t",
      key,
      canWrite: true,
      doc: new LoroDoc(),
      url: "ws://x/ws",
    });
    const client = lastClient();
    const destroy = vi.spyOn(client.joins[0]!.crdtAdaptor, "destroy");
    const listener = vi.fn();
    conn.subscribe(listener);
    conn.close();

    expect(destroy).toHaveBeenCalled();
    expect(fake.clients.at(-1)!.destroyed).toBe(true);
    expect(listener).toHaveBeenLastCalledWith("disconnected");
  });
});
