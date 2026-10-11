// A stand-in for the delivery service for tests of the session: sequences
// commits like crates/typstry-server's room does (the first submit for an
// epoch wins), relays them, and retires tokens on a rotation. It never looks
// inside a commit.
import { ownBuffer } from "@/crypto/bytes";
import type { MlsBootstrap } from "@/sync/api";

import {
  DsDisconnectedError,
  type DsClientOptions,
  type Hello,
  type ReadyMessage,
  type Reply,
  type Requestable,
  type Unsent,
} from "./ds-client";
import type { DsConnection } from "./session";

type Permission = ReadyMessage["permission"];

interface Logged {
  epoch: number;
  commit: Uint8Array;
  envelope?: Uint8Array;
}

export class FakeServer {
  incarnation = 0;
  head = 0;
  groupInfo: Uint8Array<ArrayBuffer> = new Uint8Array();
  keyring: Uint8Array<ArrayBuffer> = new Uint8Array();
  infoEpoch = 0;
  log: Logged[] = [];
  live = new Map<string, Permission>();
  retired = new Map<string, number>();
  conns = new Set<FakeConn>();
  /** Connections whose hello was answered, for tests to wait on. */
  hellos = 0;
  /**
   * Makes the next submit's reply get lost: the connection drops before the
   * client hears it. `landed` says whether the server took the commit first.
   */
  loseNextReply: { landed: boolean } | null = null;
  /** Runs when a submit arrives, before the server decides. */
  onSubmit: ((message: Unsent<Requestable>) => Promise<void>) | null = null;

  constructor(tokens: { edit: string; view: string }) {
    this.live.set(tokens.edit, "write");
    this.live.set(tokens.view, "read");
  }

  /** The creator's `init`, as the server stores it. */
  seed(init: { groupInfo: Uint8Array; keyring: Uint8Array }): void {
    this.groupInfo = ownBuffer(init.groupInfo);
    this.keyring = ownBuffer(init.keyring);
  }

  bootstrap = async (token: string): Promise<MlsBootstrap | null> => {
    if (!this.live.has(token)) return null;
    return {
      incarnation: this.incarnation,
      epoch: this.infoEpoch,
      groupInfo: this.groupInfo,
      keyring: this.keyring,
    };
  };

  /** Drops the log before `epoch`, as retention does. */
  prune(epoch: number): void {
    this.log = this.log.filter((c) => c.epoch >= epoch);
  }

  connect = (options: DsClientOptions): DsConnection => {
    const conn = new FakeConn(this, options);
    return conn;
  };

  permissionOf(token: string): Permission | null {
    if (this.live.has(token)) return this.live.get(token)!;
    if (this.retired.has(token)) return "retired";
    return null;
  }

  handle(conn: FakeConn, message: Unsent<Requestable>): Reply {
    const permission = conn.permission;
    switch (message.type) {
      case "init":
        this.groupInfo = ownBuffer(message.groupInfo);
        this.keyring = ownBuffer(message.keyring);
        this.head = 0;
        this.infoEpoch = 0;
        return { type: "accepted" };
      case "reset":
        this.incarnation = message.incarnation + 1;
        this.groupInfo = ownBuffer(message.groupInfo);
        this.keyring = ownBuffer(message.keyring);
        this.head = 0;
        this.infoEpoch = 0;
        this.log = [];
        for (const other of this.conns)
          if (other !== conn)
            other.options.onMessage({
              type: "reinitialized",
              incarnation: this.incarnation,
            });
        return { type: "accepted" };
      case "submit": {
        if (permission === "retired")
          return { type: "refused", code: "retired" };
        if (message.epoch !== this.head)
          return { type: "conflict", head: this.head };
        const logged = {
          epoch: message.epoch,
          commit: message.commit,
          envelope: message.envelope,
        };
        this.log.push(logged);
        this.head = message.epoch + 1;
        this.groupInfo = ownBuffer(message.groupInfo);
        this.infoEpoch = this.head;
        if (message.keyring) this.keyring = ownBuffer(message.keyring);
        for (const other of this.conns) {
          if (other === conn || other.permission === "retired") continue;
          other.options.onMessage({ type: "commit", ...logged });
        }
        if (message.rotate) this.rotate(message.rotate, message.epoch);
        return { type: "accepted" };
      }
    }
  }

  private rotate(
    next: { editToken: string; viewToken: string },
    epoch: number,
  ): void {
    for (const token of this.live.keys()) this.retired.set(token, epoch);
    this.live.clear();
    this.live.set(next.editToken, "write");
    this.live.set(next.viewToken, "read");
    for (const conn of this.conns) {
      if (conn.token && this.retired.has(conn.token)) {
        conn.permission = "retired";
        conn.options.onReady?.({
          type: "ready",
          incarnation: this.incarnation,
          head: this.head,
          permission: "retired",
          retired: epoch,
        });
      }
    }
  }
}

class FakeConn implements DsConnection {
  permission: Permission | null = null;
  token: string | null = null;
  private running = false;
  private generation = 0;
  private info: ReadyMessage | null = null;
  private readonly server: FakeServer;
  readonly options: DsClientOptions;

  constructor(server: FakeServer, options: DsClientOptions) {
    this.server = server;
    this.options = options;
  }

  get ready(): ReadyMessage | null {
    return this.info;
  }

  start(): void {
    this.running = true;
    void this.connect();
  }

  restart(): void {
    this.leave();
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.leave();
  }

  private leave(): void {
    this.generation++;
    this.server.conns.delete(this);
    this.permission = null;
    this.token = null;
    this.info = null;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    const hello: Hello | null = await this.options.hello();
    if (generation !== this.generation || !this.running || !hello) return;
    const token = this.options.token();
    const permission = this.server.permissionOf(token);
    if (!permission) {
      this.options.onFatal?.(1008, "auth_failed");
      return;
    }
    this.token = token;
    this.permission = permission;
    this.server.conns.add(this);
    this.server.hellos++;
    const ready: ReadyMessage = {
      type: "ready",
      incarnation: this.server.incarnation,
      head: this.server.head,
      permission,
      retired: this.server.retired.get(token),
    };
    this.info = ready;
    this.options.onReady?.(ready);
    if (hello.incarnation !== this.server.incarnation) {
      this.options.onMessage({
        type: "reinitialized",
        incarnation: this.server.incarnation,
      });
      return;
    }
    this.backfill(hello.sinceEpoch);
  }

  private backfill(since: number): void {
    // A retired token reads the log only up to the rotation that retired it.
    const until = this.server.retired.get(this.token ?? "") ?? Infinity;
    for (const logged of this.server.log)
      if (logged.epoch >= since && logged.epoch <= until)
        this.options.onMessage({ type: "commit", ...logged });
  }

  async request(message: Unsent<Requestable>): Promise<Reply> {
    if (!this.info) throw new Error("fake connection is not ready");
    // The server answers after the message went over the wire.
    await Promise.resolve();
    if (message.type === "submit") await this.server.onSubmit?.(message);
    const lost = message.type === "submit" ? this.server.loseNextReply : null;
    if (lost) {
      this.server.loseNextReply = null;
      if (lost.landed) this.server.handle(this, message);
      // The socket dies before the reply gets through, then comes back.
      queueMicrotask(() => this.restart());
      throw new DsDisconnectedError();
    }
    return this.server.handle(this, message);
  }

  fetch(since: number): void {
    this.backfill(since);
  }
}
