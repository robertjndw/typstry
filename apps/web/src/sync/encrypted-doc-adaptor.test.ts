// @vitest-environment node
import { LoroDoc, VersionVector, type PeerID } from "loro-crdt";
import {
  EloRecordKind,
  UpdateStatusCode,
  decodeEloContainer,
  encodeEloContainer,
  parseEloRecordHeader,
  type JoinResponseOk,
} from "loro-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateEditSecret,
  importProjectKey,
  type ProjectKey,
} from "@/crypto/project-key";

import { EncryptedDocAdaptor } from "./encrypted-doc-adaptor";

const decoder = new TextDecoder();

interface Delta {
  peer: PeerID;
  start: number;
  end: number;
  bytes: Uint8Array;
}

/**
 * The storage rules of crates/typstry-server's `%ELO` rooms, reduced to
 * what the client relies on. Like the real one it only reads headers.
 */
class FakeServer {
  deltas: Delta[] = [];
  snapshot: { vv: Map<PeerID, number>; bytes: Uint8Array } | null = null;
  /** Every payload a client sent, to check nothing readable got through. */
  received: Uint8Array[] = [];

  coverage(): Map<PeerID, number> {
    const cov = new Map(this.snapshot?.vv ?? []);
    const sorted = [...this.deltas].sort((a, b) => a.start - b.start);
    for (const d of sorted) {
      const have = cov.get(d.peer) ?? 0;
      if (d.start <= have && d.end > have) cov.set(d.peer, d.end);
    }
    return cov;
  }

  join(version: Uint8Array): { res: JoinResponseOk; backfill: Uint8Array[] } {
    const client = version.length
      ? VersionVector.decode(version).toJSON()
      : new Map<PeerID, number>();
    const records: Uint8Array[] = [];
    if (
      this.snapshot &&
      [...this.snapshot.vv].some(([p, c]) => (client.get(p) ?? 0) < c)
    )
      records.push(this.snapshot.bytes);
    for (const d of this.deltas)
      if (d.end > (client.get(d.peer) ?? 0)) records.push(d.bytes);
    return {
      res: {
        type: 0x01,
        crdt: "%ELO",
        roomId: "room",
        permission: "write",
        version: new VersionVector(this.coverage()).encode(),
        extra: new TextEncoder().encode(
          JSON.stringify({ deltas: this.deltas.length }),
        ),
      } as unknown as JoinResponseOk,
      backfill: records.length ? [encodeEloContainer(records)] : [],
    };
  }

  /** Returns the container to relay to other peers, if any. */
  receive(container: Uint8Array): Uint8Array | null {
    this.received.push(container);
    const fresh: Uint8Array[] = [];
    for (const record of decodeEloContainer(container)) {
      const { header } = parseEloRecordHeader(record);
      if (header.kind === EloRecordKind.DeltaSpan) {
        const peer = decoder.decode(header.peerId) as PeerID;
        if (header.end <= (this.coverage().get(peer) ?? 0)) continue;
        this.deltas.push({
          peer,
          start: header.start,
          end: header.end,
          bytes: record,
        });
        fresh.push(record);
      } else {
        const vv = new Map(
          header.vv.map((e) => [decoder.decode(e.peerId) as PeerID, e.counter]),
        );
        const dominates = [...this.coverage()].every(
          ([p, c]) => (vv.get(p) ?? 0) >= c,
        );
        if (!dominates) continue;
        this.snapshot = { vv, bytes: record };
        this.deltas = this.deltas.filter((d) => d.end > (vv.get(d.peer) ?? 0));
      }
    }
    return fresh.length ? encodeEloContainer(fresh) : null;
  }
}

interface Client {
  doc: LoroDoc;
  adaptor: EncryptedDocAdaptor;
  ctx: {
    send: ReturnType<typeof vi.fn>;
    onJoinFailed: ReturnType<typeof vi.fn>;
    onImportError: ReturnType<typeof vi.fn>;
  };
  onDecryptError: ReturnType<typeof vi.fn>;
  join(): Promise<void>;
}

const clients: Client[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.adaptor.destroy();
});

async function settle() {
  await new Promise((r) => setTimeout(r, 20));
}

function makeClient(
  server: FakeServer,
  key: ProjectKey,
  opts: { canWrite?: boolean; compactAfterDeltas?: number; doc?: LoroDoc } = {},
): Client {
  const doc = opts.doc ?? new LoroDoc();
  const onDecryptError = vi.fn();
  const adaptor = new EncryptedDocAdaptor(doc, {
    key,
    canWrite: opts.canWrite ?? true,
    compactAfterDeltas: opts.compactAfterDeltas,
    retryMs: 10,
    onDecryptError,
  });
  const ctx = {
    send: vi.fn((updates: Uint8Array[]) => {
      for (const u of updates) {
        const relay = server.receive(u);
        if (!relay) continue;
        for (const other of clients)
          if (other.adaptor !== adaptor) other.adaptor.applyUpdate([relay]);
      }
    }),
    onJoinFailed: vi.fn(),
    onImportError: vi.fn(),
  };
  adaptor.setCtx(ctx);
  const client: Client = {
    doc,
    adaptor,
    ctx,
    onDecryptError,
    async join() {
      const { res, backfill } = server.join(adaptor.getVersion());
      const joined = adaptor.handleJoinOk(res);
      adaptor.applyUpdate(backfill);
      await joined;
    },
  };
  clients.push(client);
  return client;
}

function write(doc: LoroDoc, text: string) {
  const t = doc.getText("t");
  t.insert(t.length, text);
  doc.commit();
}

const key = await importProjectKey(generateEditSecret());

describe("EncryptedDocAdaptor", () => {
  it("syncs through a server that only ever sees ciphertext", async () => {
    const server = new FakeServer();
    const a = makeClient(server, key);
    write(a.doc, "top secret thesis");
    await a.join();
    await settle();

    const b = makeClient(server, key);
    await b.join();
    await b.adaptor.waitForReachingServerVersion();
    expect(b.doc.getText("t").toString()).toBe("top secret thesis");

    write(a.doc, ", chapter two");
    await settle();
    expect(b.doc.getText("t").toString()).toBe(
      "top secret thesis, chapter two",
    );

    const leaked = server.received.some((bytes) =>
      decoder.decode(bytes).includes("secret"),
    );
    expect(leaked).toBe(false);
  });

  it("uploads edits made before joining", async () => {
    const server = new FakeServer();
    const a = makeClient(server, key);
    await a.join();
    await a.adaptor.waitForReachingServerVersion();

    const offline = new LoroDoc();
    offline.import(a.doc.export({ mode: "snapshot" }));
    write(offline, "written on a train");
    const back = makeClient(server, key, { doc: offline });
    await back.join();
    await settle();

    const fresh = makeClient(server, key);
    await fresh.join();
    await fresh.adaptor.waitForReachingServerVersion();
    expect(fresh.doc.getText("t").toString()).toBe("written on a train");
  });

  it("reports data sealed with another key and never syncs", async () => {
    const server = new FakeServer();
    const a = makeClient(server, key);
    write(a.doc, "hello");
    await a.join();
    await settle();

    const other = await importProjectKey(generateEditSecret());
    const c = makeClient(server, other);
    const synced = vi.fn();
    void c.adaptor.waitForReachingServerVersion().then(synced);
    await c.join();
    await settle();
    expect(c.onDecryptError).toHaveBeenCalled();
    expect(c.doc.getText("t").toString()).toBe("");
    expect(synced).not.toHaveBeenCalled();
  });

  it("compacts the server log with a snapshot once it grows", async () => {
    const server = new FakeServer();
    const a = makeClient(server, key);
    await a.join();
    for (let i = 0; i < 5; i++) {
      write(a.doc, `${i}`);
      await settle();
    }
    expect(server.deltas.length).toBeGreaterThanOrEqual(5);

    const b = makeClient(server, key, { compactAfterDeltas: 3 });
    await b.join();
    // Verifying the backfill and signing the snapshot takes a few crypto
    // round trips, more than a fixed settle reliably covers.
    await vi.waitFor(() => {
      expect(server.snapshot).not.toBeNull();
      expect(server.deltas).toHaveLength(0);
    });

    const fresh = makeClient(server, key);
    await fresh.join();
    await fresh.adaptor.waitForReachingServerVersion();
    expect(fresh.doc.getText("t").toString()).toBe("01234");
  });

  it("resends spans the server refused for a passing reason", async () => {
    const server = new FakeServer();
    const a = makeClient(server, key);
    await a.join();
    const receive = vi.spyOn(server, "receive");
    // Make the first send look refused: it never reaches the fake, and the
    // client hears a rate-limit ack for it.
    a.ctx.send.mockImplementationOnce((updates: Uint8Array[]) => {
      a.adaptor.onUpdateError(updates, UpdateStatusCode.RateLimited);
    });
    write(a.doc, "again");
    await settle();
    await settle();
    expect(receive).toHaveBeenCalled();
    expect(server.deltas).toHaveLength(1);
  });

  it("never sends from a view link", async () => {
    const server = new FakeServer();
    const viewer = makeClient(server, key, { canWrite: false });
    write(viewer.doc, "local only");
    await viewer.join();
    await settle();
    expect(viewer.ctx.send).not.toHaveBeenCalled();
  });
});
