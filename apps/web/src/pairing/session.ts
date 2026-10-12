// Runs one pairing over the relay socket and exposes where it stands. One
// attempt only: any failure closes the socket and the person starts over
// with a new code, which is also what the protocol enforces.
import {
  Pairing,
  deviceFingerprint,
  fitGrantProjects,
  relayCloseReasons,
  type PairingCode,
  type PairingProject,
} from "@/crypto/wasm";
import { toError } from "@/lib/errors";

export type PairFailure =
  /** The other device typed another code, or someone else answered. */
  | "wrongCode"
  /** Both devices have a person graph, or neither has. */
  | "roleConflict"
  /** The channel is unknown, used up or too old. */
  | "expired"
  | "peerLeft"
  /** The relay held all it would for a peer that never took it. */
  | "stalled"
  | "rateLimited"
  | "network"
  | "outdated"
  /** This device already belongs to another person, or was removed. */
  | "refused"
  | "protocol";

export type PairState =
  | { status: "waitingForPeer" }
  | { status: "verifying" }
  | { status: "awaitingApproval"; deviceName: string; fingerprint: string }
  /** The holder's user said yes and the grant is being built and sent. */
  | { status: "approving"; deviceName: string; fingerprint: string }
  | { status: "done"; projects: PairedProject[] }
  | { status: "rejected" }
  | { status: "failed"; reason: PairFailure; detail?: string };

/** What the done screen lists of a project; no secrets beyond the link. */
export interface PairedProject {
  title: string;
  link: string;
}

/** The device asking to be added, as the holder's user sees it. */
export interface PairingDevice {
  name: string;
  /** Its device public key. */
  pub: Uint8Array;
}

export interface Grant {
  /** `PersonGraph.encode` bytes with the new device added. */
  graph: Uint8Array;
  projects: PairingProject[];
  /** How the new device labels the one that paired it. */
  holderName: string;
}

/** Thrown by `onGrant` to say why this device cannot take the grant. */
export class GrantRefusedError extends Error {}

export type PairRole =
  /** Has the person graph: adds the device and hands the graph over after
   * the user approves. */
  | { kind: "holder"; grant: (device: PairingDevice) => Promise<Grant> }
  /** Wants to become a device of the person. `onGrant` stores what arrives
   * and returns the projects that can be opened now. */
  | {
      kind: "new";
      deviceName: string;
      devicePub: Uint8Array;
      onGrant: (grant: Grant) => Promise<PairedProject[]>;
    };

export interface PairSessionOptions {
  code: PairingCode;
  role: PairRole;
  url: string;
  createSocket?: (url: string) => WebSocket;
  keepaliveMs?: number;
}

const CLOSE_POLICY = 1008;
// The relay drops a socket that is silent for 90 s, and the holder's user
// may take longer than that to decide.
const KEEPALIVE_MS = 30_000;

const PAIR_ERRORS: Record<string, PairFailure> = {
  WrongCode: "wrongCode",
  RoleConflict: "roleConflict",
  NewerVersion: "outdated",
};

export class PairSession {
  private current: PairState = { status: "waitingForPeer" };
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private pairing: Pairing | null = null;
  /** Who the holder's user is asked about. */
  private requester: PairingDevice | null = null;
  /** Set once the machine reached its end, so a close after it is no news. */
  private over = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  private readonly opts: PairSessionOptions;

  constructor(opts: PairSessionOptions) {
    this.opts = opts;
  }

  get state(): PairState {
    return this.current;
  }

  /**
   * The new device's own fingerprint, for the user to compare with what the
   * holder shows. Null for a holder, which has nothing to prove.
   */
  get ownFingerprint(): string | null {
    const { role } = this.opts;
    return role.kind === "new" ? deviceFingerprint(role.devicePub) : null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    const { role, code } = this.opts;
    try {
      this.pairing =
        role.kind === "holder"
          ? Pairing.startHolder(code)
          : Pairing.startNew(code, role.deviceName, role.devicePub);
    } catch (error) {
      this.fail("protocol", toError(error).message);
      return;
    }
    const socket = (this.opts.createSocket ?? ((u) => new WebSocket(u)))(
      this.opts.url,
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    // The relay holds frames for a peer that has not arrived yet.
    socket.onopen = () => {
      // A text frame the relay answers itself instead of passing it on.
      this.keepalive = setInterval(
        () => socket.readyState === 1 && socket.send("ping"),
        this.opts.keepaliveMs ?? KEEPALIVE_MS,
      );
      const first = this.pairing?.firstFrame();
      if (first) socket.send(first as Uint8Array<ArrayBuffer>);
    };
    socket.onmessage = (event) => {
      if (socket === this.socket && event.data instanceof ArrayBuffer)
        void this.onFrame(new Uint8Array(event.data));
    };
    socket.onerror = () => {
      // The close that follows says why.
    };
    socket.onclose = (event) => {
      if (socket === this.socket) this.onClose(event.code, event.reason);
    };
  }

  /** The holder's user said yes. */
  async approve(): Promise<void> {
    const pairing = this.pairing;
    const requester = this.requester;
    if (this.current.status !== "awaitingApproval" || !pairing || !requester)
      return;
    // Set before the first await, so a second click or a reject that comes
    // while the grant is built finds the verdict already taken.
    this.set({
      status: "approving",
      deviceName: requester.name,
      fingerprint: deviceFingerprint(requester.pub),
    });
    try {
      const grant = await this.holderRole().grant(requester);
      if (this.over) return;
      this.send(pairing.approve(grant.graph, grant.projects, grant.holderName));
      this.finish({
        status: "done",
        // What the grant really carried, which `approve` cut to fit.
        projects: fitGrantProjects(grant.projects),
      });
    } catch (error) {
      if (this.over) return;
      this.fail(
        error instanceof GrantRefusedError ? "refused" : "protocol",
        toError(error).message,
      );
    }
  }

  reject(): void {
    const pairing = this.pairing;
    if (this.current.status !== "awaitingApproval" || !pairing) return;
    try {
      this.send(pairing.reject());
      this.finish({ status: "rejected" });
    } catch (error) {
      this.fail("protocol", toError(error).message);
    }
  }

  /** Leaves without a verdict, e.g. when the dialog closes. */
  close(): void {
    this.over = true;
    this.teardown();
  }

  private holderRole() {
    if (this.opts.role.kind !== "holder") throw new Error("not the holder");
    return this.opts.role;
  }

  private async onFrame(frame: Uint8Array): Promise<void> {
    const pairing = this.pairing;
    if (this.over || !pairing) return;
    // The first frame is the peer's key exchange: someone is there.
    if (this.current.status === "waitingForPeer")
      this.set({ status: "verifying" });
    try {
      const step = pairing.handle(frame);
      if (step.send) this.send(step.send);
      const event = step.event;
      if (!event) return;
      switch (event.type) {
        case "verified":
          // Both know the code. What follows is the holder's user deciding.
          break;
        case "awaitApproval":
          this.requester = {
            name: event.deviceName,
            pub: event.devicePub,
          };
          this.set({
            status: "awaitingApproval",
            deviceName: event.deviceName,
            // The name is whatever the joining device chose to call itself;
            // the key is what the user can check against that device.
            fingerprint: deviceFingerprint(event.devicePub),
          });
          break;
        case "granted":
          await this.onGranted(event.graph, event.projects, event.holderName);
          break;
        case "rejected":
          this.finish({ status: "rejected" });
          break;
      }
    } catch (error) {
      const kind = (error as { kind?: string }).kind ?? "";
      this.fail(PAIR_ERRORS[kind] ?? "protocol", toError(error).message);
    }
  }

  private async onGranted(
    graph: Uint8Array,
    projects: PairingProject[],
    holderName: string,
  ): Promise<void> {
    if (this.opts.role.kind !== "new") throw new Error("not the new device");
    // The holder closes right after the grant; the close is no failure.
    this.over = true;
    try {
      const opened = await this.opts.role.onGrant({
        graph,
        projects,
        holderName,
      });
      this.finish({ status: "done", projects: opened });
    } catch (error) {
      this.fail(
        error instanceof GrantRefusedError ? "refused" : "protocol",
        toError(error).message,
      );
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.over) return;
    const reasons = relayCloseReasons();
    if (code === 1000 || reason === reasons.peerLeft)
      return this.fail("peerLeft");
    if (code === CLOSE_POLICY) {
      if (reason === reasons.rateLimited) return this.fail("rateLimited");
      if (reason === reasons.tooManyFrames) return this.fail("stalled");
      // `expired`, `noChannel`, and anything a newer server says.
      return this.fail("expired");
    }
    this.fail("network");
  }

  private send(frame: Uint8Array): void {
    // wasm-bindgen hands out plain ArrayBuffer-backed arrays.
    this.socket?.send(frame as Uint8Array<ArrayBuffer>);
  }

  private set(state: PairState): void {
    this.current = state;
    for (const listener of this.listeners) listener();
  }

  private finish(state: PairState): void {
    this.over = true;
    this.teardown();
    this.set(state);
  }

  private fail(reason: PairFailure, detail?: string): void {
    if (this.current.status === "done" || this.current.status === "rejected")
      return;
    this.over = true;
    this.teardown();
    this.set({ status: "failed", reason, detail });
  }

  private teardown(): void {
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    this.pairing?.free();
    this.pairing = null;
  }
}
