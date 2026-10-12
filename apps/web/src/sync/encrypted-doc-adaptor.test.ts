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

import { SpaceCrypto } from "@/crypto/space-crypto";
import { editorOf, newProject, viewerOf } from "@/crypto/test-utils";
import { DocKeys } from "@/crypto/wasm";

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
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.adaptor.destroy();
});

async function settle() {
  await new Promise((r) => setTimeout(r, 20));
}

function makeClient(
  server: FakeServer,
  crypto: SpaceCrypto,
  opts: {
    canWrite?: boolean;
    compactAfterDeltas?: number;
    compactIntervalMs?: number;
    pushDelayMs?: number;
    doc?: LoroDoc;
    compactOnJoin?: boolean;
    onUnknownGeneration?: (generation: number) => void;
    accept?: (doc: LoroDoc) => boolean | undefined;
    onRefused?: () => void;
  } = {},
): Client {
  const doc = opts.doc ?? new LoroDoc();
  const onDecryptError = vi.fn();
  const adaptor = new EncryptedDocAdaptor(doc, {
    crypto,
    canWrite: opts.canWrite ?? true,
    compactAfterDeltas: opts.compactAfterDeltas,
    compactOnJoin: opts.compactOnJoin,
    compactIntervalMs: opts.compactIntervalMs ?? 0,
    pushDelayMs: opts.pushDelayMs ?? 0,
    retryMs: 10,
    onDecryptError,
    onUnknownGeneration: opts.onUnknownGeneration,
    accept: opts.accept,
    onRefused: opts.onRefused,
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

const project = newProject();

describe("EncryptedDocAdaptor", () => {
  it("syncs through a server that only ever sees ciphertext", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto);
    write(a.doc, "top secret thesis");
    await a.join();
    await settle();

    const b = makeClient(server, project.crypto);
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

  describe("accept", () => {
    /** Undecided while the doc has no kind, like the real callers. */
    const kindIs = (want: string) => (doc: LoroDoc) => {
      const kind = doc.getMap("meta").get("kind");
      return kind === undefined ? undefined : kind === want;
    };

    function directoryClient(server: FakeServer) {
      const dir = makeClient(server, project.crypto);
      dir.doc.getMap("meta").set("kind", "directory");
      write(dir.doc, "directory secrets");
      return dir;
    }

    it("never sends local ops into a space of another kind", async () => {
      const server = new FakeServer();
      const dir = directoryClient(server);
      await dir.join();
      await settle();
      const sent = server.received.length;

      const onRefused = vi.fn();
      const local = makeClient(server, project.crypto, {
        accept: kindIs("project"),
        onRefused,
      });
      write(local.doc, "local project history");
      await local.join();
      await settle();
      write(local.doc, " and more");
      await settle();

      expect(onRefused).toHaveBeenCalledTimes(1);
      expect(server.received).toHaveLength(sent);
      expect(local.ctx.send).not.toHaveBeenCalled();
      expect(local.adaptor.hasPendingPush).toBe(false);
    });

    it("pushes as before when the doc is accepted", async () => {
      const server = new FakeServer();
      const dir = directoryClient(server);
      await dir.join();
      await settle();

      const accept = vi.fn(kindIs("directory"));
      const onRefused = vi.fn();
      const local = makeClient(server, project.crypto, { accept, onRefused });
      local.doc.getText("mine").insert(0, "entry");
      local.doc.commit();
      await local.join();
      await settle();

      expect(accept).toHaveLastReturnedWith(true);
      expect(onRefused).not.toHaveBeenCalled();
      const fresh = makeClient(server, project.crypto);
      await fresh.join();
      await fresh.adaptor.waitForReachingServerVersion();
      expect(fresh.doc.getText("mine").toString()).toBe("entry");
    });

    it("holds ops made during catch-up and sends them once accepted", async () => {
      const server = new FakeServer();
      const dir = directoryClient(server);
      await dir.join();
      await settle();

      const accept = vi.fn(kindIs("directory"));
      const local = makeClient(server, project.crypto, { accept });
      const { res, backfill } = server.join(local.adaptor.getVersion());
      const joined = local.adaptor.handleJoinOk(res);
      write(local.doc, "typed while catching up");
      await settle();
      expect(local.ctx.send).not.toHaveBeenCalled();
      expect(accept).not.toHaveReturnedWith(true);

      local.adaptor.applyUpdate(backfill);
      await joined;
      await local.adaptor.waitForReachingServerVersion();
      await settle();
      // Decided on the backfill, not the empty doc.
      expect(accept).toHaveLastReturnedWith(true);
      expect(local.ctx.send).toHaveBeenCalled();

      const fresh = makeClient(server, project.crypto);
      await fresh.join();
      await fresh.adaptor.waitForReachingServerVersion();
      const text = fresh.doc.getText("t").toString();
      expect(text).toContain("typed while catching up");
      expect(text).toContain("directory secrets");
    });

    it("sends once the kind is known, even if a record never decrypts", async () => {
      const server = new FakeServer();
      const owner = makeClient(server, project.crypto);
      owner.doc.getMap("meta").set("kind", "project");
      write(owner.doc, "start");
      await owner.join();
      await settle();
      // A record nobody with this project's keys can open keeps every
      // reader from catching up with the server for good.
      const stranger = makeClient(server, newProject().crypto);
      write(stranger.doc, "junk");
      await stranger.join();
      await settle();

      const local = makeClient(server, project.crypto, {
        accept: kindIs("project"),
      });
      await local.join();
      await settle();
      expect(local.onDecryptError).toHaveBeenCalled();
      write(local.doc, " and mine");
      await vi.waitFor(() => expect(local.ctx.send).toHaveBeenCalled());

      await settle();
      expect(owner.doc.getText("t").toString()).toContain("and mine");
    });

    it("stays refused across a reconnect", async () => {
      const server = new FakeServer();
      const dir = directoryClient(server);
      await dir.join();
      await settle();
      const local = makeClient(server, project.crypto, {
        accept: kindIs("project"),
      });
      await local.join();
      await settle();
      write(local.doc, "after refusal");
      await local.join();
      await settle();
      expect(local.ctx.send).not.toHaveBeenCalled();
    });
  });

  it("uploads edits made before joining", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto);
    await a.join();
    await a.adaptor.waitForReachingServerVersion();

    const offline = new LoroDoc();
    offline.import(a.doc.export({ mode: "snapshot" }));
    write(offline, "written on a train");
    const back = makeClient(server, project.crypto, { doc: offline });
    await back.join();
    await settle();

    const fresh = makeClient(server, project.crypto);
    await fresh.join();
    await fresh.adaptor.waitForReachingServerVersion();
    expect(fresh.doc.getText("t").toString()).toBe("written on a train");
  });

  it("reports data sealed with another key and never syncs", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto);
    write(a.doc, "hello");
    await a.join();
    await settle();

    const c = makeClient(server, newProject().crypto);
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
    const a = makeClient(server, project.crypto);
    await a.join();
    for (let i = 0; i < 5; i++) {
      write(a.doc, `${i}`);
      await settle();
    }
    expect(server.deltas.length).toBeGreaterThanOrEqual(5);

    const b = makeClient(server, project.crypto, { compactAfterDeltas: 3 });
    await b.join();
    // Verifying the backfill and signing the snapshot takes a few crypto
    // round trips, more than a fixed settle reliably covers.
    await vi.waitFor(() => {
      expect(server.snapshot).not.toBeNull();
      expect(server.deltas).toHaveLength(0);
    });

    const fresh = makeClient(server, project.crypto);
    await fresh.join();
    await fresh.adaptor.waitForReachingServerVersion();
    expect(fresh.doc.getText("t").toString()).toBe("01234");
  });

  it("keeps compacting as its own sends grow the log", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, { compactAfterDeltas: 3 });
    await a.join();
    await a.adaptor.waitForReachingServerVersion();
    for (let i = 0; i < 7; i++) {
      write(a.doc, `${i}`);
      await settle();
    }
    await vi.waitFor(() => {
      expect(server.snapshot).not.toBeNull();
      // Two rounds of compaction: without the second the log would hold
      // everything after the first snapshot.
      expect(server.deltas.length).toBeLessThan(3);
    });
    const snapshots = server.received.filter((c) =>
      decodeEloContainer(c).some(
        (r) => parseEloRecordHeader(r).header.kind === EloRecordKind.Snapshot,
      ),
    );
    expect(snapshots.length).toBeGreaterThanOrEqual(2);

    const fresh = makeClient(server, project.crypto);
    await fresh.join();
    await fresh.adaptor.waitForReachingServerVersion();
    expect(fresh.doc.getText("t").toString()).toBe("0123456");
  });

  it("waits between compactions while connected", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, {
      compactAfterDeltas: 3,
      compactIntervalMs: 60_000,
    });
    await a.join();
    await a.adaptor.waitForReachingServerVersion();
    for (let i = 0; i < 7; i++) {
      write(a.doc, `${i}`);
      await settle();
    }
    expect(server.snapshot).not.toBeNull();
    const snapshots = server.received.filter((c) =>
      decodeEloContainer(c).some(
        (r) => parseEloRecordHeader(r).header.kind === EloRecordKind.Snapshot,
      ),
    );
    expect(snapshots).toHaveLength(1);
    expect(server.deltas.length).toBeGreaterThanOrEqual(3);
  });

  it("never snapshots ops that did not go out as deltas", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, {
      compactAfterDeltas: 1,
      pushDelayMs: 60_000,
    });
    const b = makeClient(server, project.crypto);
    await a.join();
    await b.join();
    await b.adaptor.waitForReachingServerVersion();

    // The first two encryptions each see a new commit land as they start:
    // the second one belongs to the push right before the snapshot.
    let calls = 0;
    const encrypt = project.crypto.encryptDelta.bind(project.crypto);
    vi.spyOn(project.crypto, "encryptDelta").mockImplementation((...args) => {
      calls++;
      if (calls <= 2) write(a.doc, `${calls + 1}`);
      return encrypt(...args);
    });
    write(a.doc, "1");
    await a.adaptor.flush();
    await vi.waitFor(() => expect(server.snapshot).not.toBeNull());
    await a.adaptor.flush();
    await settle();

    // A snapshot holding "3" before its delta was sent would have made the
    // server swallow that delta, and b never sees snapshots.
    expect(a.doc.getText("t").toString()).toBe("123");
    expect(b.doc.getText("t").toString()).toBe("123");
  });

  it("counts a push still encrypting as pending", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, { pushDelayMs: 0 });
    await a.join();
    await a.adaptor.waitForReachingServerVersion();
    write(a.doc, "queued");
    // The push timer is not involved, but the commit has not been sent yet.
    expect(a.adaptor.hasPendingPush).toBe(true);
    await a.adaptor.flush();
    expect(a.adaptor.hasPendingPush).toBe(false);
    expect(server.deltas).toHaveLength(1);
  });

  it("gathers quick commits into one record", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, { pushDelayMs: 30 });
    await a.join();
    await a.adaptor.waitForReachingServerVersion();
    for (const ch of "typing") write(a.doc, ch);
    expect(a.ctx.send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(server.deltas).toHaveLength(1));
    expect(a.ctx.send).toHaveBeenCalledTimes(1);
  });

  it("sends pending commits right away on flush", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, { pushDelayMs: 60_000 });
    await a.join();
    write(a.doc, "before closing");
    expect(a.adaptor.hasPendingPush).toBe(true);
    await a.adaptor.flush();
    expect(a.adaptor.hasPendingPush).toBe(false);
    expect(server.deltas).toHaveLength(1);
  });

  it("resends spans the server refused for a passing reason", async () => {
    const server = new FakeServer();
    const a = makeClient(server, project.crypto);
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
    const viewer = makeClient(server, viewerOf(project), { canWrite: false });
    write(viewer.doc, "local only");
    await viewer.join();
    await settle();
    expect(viewer.ctx.send).not.toHaveBeenCalled();
  });

  it("uploads exactly one snapshot right after joining when asked to", async () => {
    const snapshotsIn = (server: FakeServer) =>
      server.received.filter((c) =>
        decodeEloContainer(c).some(
          (r) => parseEloRecordHeader(r).header.kind === EloRecordKind.Snapshot,
        ),
      ).length;

    // After a rotation the new connection says so, whatever the log length.
    const server = new FakeServer();
    const a = makeClient(server, project.crypto, {
      compactAfterDeltas: 1000,
      compactOnJoin: true,
    });
    write(a.doc, "history");
    await a.join();
    await a.adaptor.waitForReachingServerVersion();
    await vi.waitFor(() => expect(snapshotsIn(server)).toBe(1));
    await settle();
    expect(snapshotsIn(server)).toBe(1);

    // Otherwise a short log is left alone.
    const quiet = new FakeServer();
    const b = makeClient(quiet, project.crypto, { compactAfterDeltas: 1000 });
    write(b.doc, "history");
    await b.join();
    await b.adaptor.waitForReachingServerVersion();
    await settle();
    expect(snapshotsIn(quiet)).toBe(0);
  });

  it("reports a record from a newer generation without calling it a decrypt error", async () => {
    const server = new FakeServer();
    const rotated = new SpaceCrypto(
      project.link,
      new DocKeys(project.keyring.next(project.link)),
    );
    const a = makeClient(server, rotated);
    write(a.doc, "rotated");
    await a.join();
    await settle();

    const unknown = vi.fn();
    const b = makeClient(server, editorOf(project), {
      onUnknownGeneration: unknown,
    });
    await b.join();
    await settle();
    expect(unknown).toHaveBeenCalledWith(2);
    expect(b.onDecryptError).not.toHaveBeenCalled();
    expect(b.doc.getText("t").toString()).toBe("");
  });
});
