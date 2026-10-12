// The client of the MLS delivery service (crates/typstry-wire/src/ds.rs).
// The server is a dumb sequencer, so this is a socket that says hello, hands
// every message it receives to its owner, and turns requests (submit, init,
// reset) into promises by their `req` number.
//
// It reconnects like the rest of the app does (project/retry.ts) and says
// hello again every time, which is how a returning client gets the commits it
// missed: the hello names the epoch it holds, and the server replays from
// there. What to put in the hello is the owner's call, since it changes
// as the group moves. `createGroup` is the one-shot use: say hello, send
// the `init` of a new project, hang up.
import { ownBuffer } from "@/crypto/bytes";
import {
  decodeServerMessage,
  dsPath,
  encodeClientMessage,
  type ClientMessage,
  type InitMessage,
  type ServerMessage,
} from "@/crypto/wasm";
import { toError } from "@/lib/errors";
import { RetryQueue } from "@/project/retry";
import { ApiError } from "@/sync/api";
import { socketUrl } from "@/sync/protocol";

export type ReadyMessage = Extract<ServerMessage, { type: "ready" }>;

export type RefusalCode = Extract<ServerMessage, { type: "refused" }>["code"];

/** The server's answer to a request. */
export type Reply =
  | { type: "accepted" }
  | { type: "conflict"; head: number }
  | { type: "refused"; code: RefusalCode };

export type Requestable = Extract<ClientMessage, { req: number }>;
export type Unsent<M> = M extends unknown ? Omit<M, "req"> : never;

/** A request was cut off, or could not start, because the socket is down. */
export class DsDisconnectedError extends Error {
  constructor(message = "the delivery service is not connected") {
    super(message);
    this.name = "DsDisconnectedError";
  }
}

export interface Hello {
  incarnation: number;
  sinceEpoch: number;
}

export interface DsClientOptions {
  /** The token to say hello with, read again on every connect. */
  token: () => string;
  /**
   * What to put in the hello, read on every connect. Null means there is
   * nothing to connect for right now; the connect is tried again later.
   */
  hello: () => Hello | null | Promise<Hello | null>;
  /** Everything but the answers to requests. */
  onMessage: (message: ServerMessage) => void;
  /** The socket opened and the server accepted the hello. */
  onReady?: (ready: ReadyMessage) => void;
  /** Called when the socket went down, whether or not it will come back. */
  onDown?: () => void;
  /** The server closed for good (its token is refused); no retry follows. */
  onFatal?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  /** Defaults to the delivery service path on the page's origin. */
  url?: string;
  createSocket?: (url: string) => WebSocket;
  retry?: RetryQueue;
  /** How often to send a keepalive; the server drops a silent socket. */
  keepaliveMs?: number;
  /** How long a request waits for the socket to become ready. */
  readyTimeoutMs?: number;
  /**
   * How long a request waits for the server's answer. A socket can stay
   * open and say nothing, which would hold whoever waits (and the Web Lock
   * they hold) for good.
   */
  replyTimeoutMs?: number;
}

const KEEPALIVE_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const REPLY_TIMEOUT_MS = 15_000;
const RETRY_KEY = "ds";

/**
 * Close codes that mean retrying the same token is pointless: the server
 * refused it (1008), or says it is rotated away (the 44xx family).
 */
function isFatalClose(code: number): boolean {
  return code === 1008 || (code >= 4400 && code < 4500);
}

type Waiter = {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
};

export class DsClient {
  private readonly opts: DsClientOptions;
  private readonly retry: RetryQueue;
  private socket: WebSocket | null = null;
  private running = false;
  private readyInfo: ReadyMessage | null = null;
  private readyWaiters: ((ok: boolean) => void)[] = [];
  private readonly pending = new Map<number, Waiter>();
  private nextReq = 1;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  /** Tells a connect that was overtaken by `stop` or `restart`. */
  private generation = 0;

  constructor(opts: DsClientOptions) {
    this.opts = opts;
    this.retry = opts.retry ?? new RetryQueue();
  }

  get ready(): ReadyMessage | null {
    return this.readyInfo;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  /** Reconnects right away, e.g. after the token or the epoch changed. */
  restart(): void {
    if (!this.running) return this.start();
    this.drop();
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.drop();
    this.retry.dispose();
  }

  private drop(): void {
    this.generation++;
    const socket = this.socket;
    this.teardown();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    let hello: Hello | null;
    try {
      hello = await this.opts.hello();
    } catch (error) {
      if (generation === this.generation && this.running) {
        this.opts.onError?.(toError(error));
        this.retry.schedule(RETRY_KEY, () => void this.connect());
      }
      return;
    }
    // A restart or a retry timer may have connected meanwhile.
    if (generation !== this.generation || !this.running || this.socket) return;
    if (!hello) {
      this.retry.schedule(RETRY_KEY, () => void this.connect());
      return;
    }

    const url = this.opts.url ?? socketUrl(window.location, dsPath());
    const socket = (this.opts.createSocket ?? ((u) => new WebSocket(u)))(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      const token = this.opts.token();
      this.sendRaw({ type: "hello", token, ...hello });
      this.keepalive = setInterval(
        () => socket.readyState === 1 && socket.send("ping"),
        this.opts.keepaliveMs ?? KEEPALIVE_MS,
      );
    };
    socket.onerror = () =>
      this.opts.onError?.(new Error("delivery service socket error"));
    socket.onmessage = (event) => this.onFrame(socket, event);
    socket.onclose = (event) => this.onClose(socket, event);
  }

  private onFrame(socket: WebSocket, event: MessageEvent): void {
    if (socket !== this.socket || !(event.data instanceof ArrayBuffer)) return;
    let message: ServerMessage;
    try {
      message = decodeServerMessage(new Uint8Array(event.data));
    } catch (error) {
      this.opts.onError?.(toError(error));
      return;
    }
    switch (message.type) {
      case "ready":
        this.readyInfo = message;
        this.retry.succeeded(RETRY_KEY);
        this.settleReady(true);
        this.opts.onReady?.(message);
        return;
      case "accepted":
      case "conflict":
      case "refused": {
        const waiter = this.pending.get(message.req);
        if (waiter) {
          this.pending.delete(message.req);
          waiter.resolve(
            message.type === "accepted"
              ? { type: "accepted" }
              : message.type === "conflict"
                ? { type: "conflict", head: message.head }
                : { type: "refused", code: message.code },
          );
          return;
        }
        break;
      }
    }
    this.opts.onMessage(message);
  }

  private onClose(socket: WebSocket, event: CloseEvent): void {
    if (socket !== this.socket) return;
    this.teardown();
    this.opts.onDown?.();
    if (!this.running) return;
    if (isFatalClose(event.code)) {
      this.running = false;
      this.opts.onFatal?.(event.code, event.reason);
      return;
    }
    this.retry.schedule(RETRY_KEY, () => void this.connect());
  }

  /** Forgets the socket and fails everyone waiting on it. */
  private teardown(): void {
    this.socket = null;
    this.readyInfo = null;
    this.clearKeepalive();
    this.failPending(new DsDisconnectedError());
    this.settleReady(false);
  }

  private clearKeepalive(): void {
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private failPending(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  private settleReady(ok: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter(ok);
  }

  private sendRaw(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) throw new DsDisconnectedError();
    socket.send(ownBuffer(encodeClientMessage(message)));
  }

  private untilReady(): Promise<void> {
    if (this.readyInfo) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new DsDisconnectedError("the delivery service did not answer"));
      }, this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      const waiter = (ok: boolean) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new DsDisconnectedError());
      };
      this.readyWaiters.push(waiter);
    });
  }

  /**
   * Sends a message that gets an answer (`submit`, `init`, `reset`) and
   * resolves with it. Waits for the socket to be ready first. Rejects with a
   * `DsDisconnectedError` when the socket goes down or stays silent before
   * the answer comes; the caller cannot tell whether the server took the
   * message, and finds out from the log after reconnecting. A silent socket
   * is restarted, since it may be half dead.
   */
  async request(message: Unsent<Requestable>): Promise<Reply> {
    await this.untilReady();
    const req = this.nextReq++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(req)) return;
        reject(new DsDisconnectedError("the delivery service did not answer"));
        this.restart();
      }, this.opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS);
      this.pending.set(req, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.sendRaw({ ...message, req } as ClientMessage);
      } catch (error) {
        this.pending.delete(req);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  /** Asks for the commits from `since` on again. */
  fetch(since: number): void {
    if (!this.readyInfo) return;
    this.sendRaw({ type: "fetch", since });
  }
}

/**
 * Creates the group of a new project on the server, which needs it before
 * anyone can open the project: it holds the keyring they all start from.
 * Rejects with an `ApiError` when the server refuses or cannot be reached.
 */
export async function createGroup(
  editToken: string,
  init: InitMessage,
  opts: Pick<
    DsClientOptions,
    "url" | "createSocket" | "retry" | "readyTimeoutMs" | "replyTimeoutMs"
  > = {},
): Promise<void> {
  const client = new DsClient({
    ...opts,
    token: () => editToken,
    hello: () => ({ incarnation: 0, sinceEpoch: 0 }),
    onMessage: () => {},
  });
  client.start();
  try {
    const reply = await client.request(init);
    if (reply.type === "accepted") return;
    throw new ApiError(
      reply.type === "refused" && reply.code === "forbidden" ? 403 : 409,
      reply.type === "refused"
        ? `the server refused the group: ${reply.code}`
        : "the project already has a group",
    );
  } catch (error) {
    if (error instanceof DsDisconnectedError)
      throw new ApiError(502, "could not reach the delivery service");
    throw error;
  } finally {
    client.stop();
  }
}
