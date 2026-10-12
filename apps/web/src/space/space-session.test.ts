import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newProject } from "@/crypto/test-utils";
import { LocalDocStore, MemoryBackend } from "@/persist/local-doc-store";
import { fetchMlsBootstrap, resolveShare } from "@/sync/api";
import { connectSpace } from "@/sync/connection";

import {
  loadShare,
  loadSpaceKey,
  rememberShare,
  saveKeyring,
} from "./space-links";
import { SpaceSession } from "./space-session";

vi.mock("@/sync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/sync/api")>()),
  resolveShare: vi.fn(),
  fetchMlsBootstrap: vi.fn(),
}));
vi.mock("@/sync/connection", () => ({ connectSpace: vi.fn() }));

// The member group has its own tests (mls/session.test.ts); here it only
// has to be something the session can watch and start.
const group = vi.hoisted(() => ({
  instances: [] as { starts: unknown[]; stops: number }[],
}));
vi.mock("@/mls/session", () => ({
  IDLE: {
    phase: "idle",
    members: [],
    canCommit: false,
    holdsOwnerKey: false,
    stalled: false,
    error: null,
  },
  MlsSession: class {
    private readonly self = { starts: [] as unknown[], stops: 0 };
    constructor() {
      group.instances.push(this.self);
    }
    subscribe = () => () => {};
    getSnapshot = () => ({
      phase: "active",
      members: [],
      canCommit: false,
      holdsOwnerKey: false,
      stalled: false,
      error: null,
    });
    start = async (target: unknown) => {
      this.self.starts.push(target);
    };
    stop() {
      this.self.stops++;
    }
    keys() {
      return null;
    }
    onKeys() {
      return () => {};
    }
    updateProfile() {}
    catchUp() {}
  },
}));

const stored = vi.hoisted(() => ({
  /** Hands every caller its own browser storage, to stand in for two devices. */
  separate: false,
  backend: null as import("@/persist/local-doc-store").DocBackend | null,
}));
vi.mock("@/persist/local-doc-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/persist/local-doc-store")>();
  return {
    ...real,
    defaultBackend: () =>
      Promise.resolve(
        stored.separate
          ? new real.MemoryBackend()
          : (stored.backend ??= new real.MemoryBackend()),
      ),
  };
});

const share = { spaceId: "p", permission: "write" as const };
const keys = newProject();
const secret = keys.link.toBase64url();
const identity = { name: "Ada", color: "#ff0000" };

function session(doc = new LoroDoc(), token = "tok") {
  return new SpaceSession({ token, linkKey: secret, doc, identity });
}

beforeEach(() => {
  vi.mocked(fetchMlsBootstrap).mockResolvedValue({
    incarnation: 0,
    epoch: 0,
    groupInfo: new Uint8Array(),
    keyring: keys.signed,
    ownerKey: new Uint8Array(32),
  });
});

afterEach(() => {
  stored.backend = null;
  stored.separate = false;
  group.instances.length = 0;
  vi.mocked(resolveShare).mockReset();
  vi.mocked(fetchMlsBootstrap).mockReset();
  vi.mocked(connectSpace).mockReset();
  localStorage.clear();
});

function neverSynced() {
  const close = vi.fn();
  vi.mocked(connectSpace).mockImplementation(() => ({
    getStatus: () => "connecting",
    subscribe: (listener) => {
      listener("connecting");
      return () => {};
    },
    synced: new Promise(() => {}),
    syncNow: () => Promise.resolve("offline"),
    close,
  }));
  return close;
}

describe("SpaceSession", () => {
  it("resolves the share, then opens and syncs the doc", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    vi.mocked(connectSpace).mockImplementation(() => ({
      getStatus: () => "connected",
      subscribe: (listener) => {
        listener("connected");
        return () => {};
      },
      synced: Promise.resolve(),
      syncNow: () => Promise.resolve("synced"),
      close: () => {},
    }));
    const s = session();
    expect(s.snapshot().phase).toEqual({ phase: "resolving" });
    const seen: unknown[] = [];
    s.subscribe(() => seen.push(s.snapshot()));

    s.start();
    await vi.waitFor(() => expect(s.snapshot().phase.phase).toBe("opened"));

    const snap = s.snapshot();
    expect(snap).toMatchObject({ share, synced: true, status: "connected" });
    expect(snap.mls).not.toBeNull();
    // The share lookup is kept for the next offline visit, and so is the key.
    expect(loadShare("tok")).toEqual(share);
    expect(s.keepSecret()).toBe(true);
    expect(loadSpaceKey("p")).toBe(secret);
    // A new snapshot object per change, the same one in between.
    expect(new Set(seen).size).toBe(seen.length);
    expect(s.snapshot()).toBe(snap);
    expect(group.instances[0]!.starts).toEqual([
      { token: "tok", link: secret },
    ]);
    s.stop();
  });

  it("reports an unknown token and a missing key", async () => {
    vi.mocked(resolveShare).mockResolvedValue(null);
    const unknown = session();
    unknown.start();
    await vi.waitFor(() =>
      expect(unknown.snapshot().phase).toEqual({ phase: "not-found" }),
    );
    unknown.stop();

    vi.mocked(resolveShare).mockResolvedValue(share);
    const keyless = new SpaceSession({
      token: "tok2",
      linkKey: null,
      doc: new LoroDoc(),
      identity,
    });
    keyless.start();
    await vi.waitFor(() =>
      expect(keyless.snapshot().phase).toEqual({ phase: "missing-key" }),
    );
    keyless.stop();
  });

  it("retries a failed lookup and leaves the error phase", async () => {
    vi.mocked(resolveShare)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(share);
    neverSynced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = session();
    s.start();
    await vi.waitFor(() =>
      expect(s.snapshot().phase).toEqual({
        phase: "error",
        message: "The server could not be reached.",
      }),
    );

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(s.snapshot().phase.phase).toBe("syncing"));
    expect(s.snapshot().share).toEqual(share);
    s.stop();
    errors.mockRestore();
  });

  it("stops retrying once stopped", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolveShare).mockRejectedValue(new TypeError("offline"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const s = session();
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveShare).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolveShare).toHaveBeenCalledTimes(2);
      // Backed off: the next try waits twice as long.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolveShare).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolveShare).toHaveBeenCalledTimes(3);

      s.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      window.dispatchEvent(new Event("online"));
      expect(resolveShare).toHaveBeenCalledTimes(3);
      errors.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the saved copy offline", async () => {
    const backend = new MemoryBackend();
    stored.backend = backend;
    const seed = new LoroDoc();
    const store = new LocalDocStore("p", seed, backend);
    await store.load();
    seed.getMap("m").set("hello", "world");
    seed.commit();
    await store.flush();
    saveKeyring("p", keys.signed);
    rememberShare("tok", share);
    vi.mocked(resolveShare).mockRejectedValue(new Error("offline"));
    vi.mocked(fetchMlsBootstrap).mockResolvedValue(null);
    neverSynced();

    const doc = new LoroDoc();
    const s = session(doc);
    s.start();
    await vi.waitFor(() => expect(s.snapshot().phase.phase).toBe("opened"));

    expect(s.snapshot().synced).toBe(false);
    expect(doc.getMap("m").get("hello")).toBe("world");
    s.stop();
  });

  it("carries two sessions' edits to each other", async () => {
    stored.separate = true;
    vi.mocked(resolveShare).mockResolvedValue(share);
    // A relay in place of the server: whatever one doc commits, the others get.
    const docs: LoroDoc[] = [];
    vi.mocked(connectSpace).mockImplementation(({ doc }) => {
      for (const other of docs) {
        doc.import(other.export({ mode: "update" }));
        other.import(doc.export({ mode: "update" }));
      }
      docs.push(doc);
      const stop = doc.subscribeLocalUpdates((update) => {
        for (const other of docs) if (other !== doc) other.import(update);
      });
      return {
        getStatus: () => "connected",
        subscribe: (listener) => {
          listener("connected");
          return () => {};
        },
        synced: Promise.resolve(),
        syncNow: () => Promise.resolve("synced"),
        close: stop,
      };
    });
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    const a = session(docA);
    const b = session(docB);
    a.start();
    b.start();
    await vi.waitFor(() => {
      expect(a.snapshot().synced).toBe(true);
      expect(b.snapshot().synced).toBe(true);
    });

    docA.getMap("m").set("from", "a");
    docA.commit();
    expect(docB.getMap("m").get("from")).toBe("a");
    await expect(a.syncNow()).resolves.toBe("synced");
    a.stop();
    b.stop();
  });

  it("leaves saving the doc to the caller with persist off", async () => {
    const backend = new MemoryBackend();
    stored.backend = backend;
    vi.mocked(resolveShare).mockResolvedValue(share);
    neverSynced();
    const doc = new LoroDoc();
    const s = new SpaceSession({
      token: "tok",
      linkKey: secret,
      doc,
      identity,
      persist: false,
    });
    s.start();
    // Counts as loaded without a stored copy.
    await vi.waitFor(() => expect(s.snapshot().phase.phase).toBe("opened"));
    doc.getMap("m").set("a", 1);
    doc.commit();
    await s.syncNow();
    expect((await backend.load("p")).updates).toEqual([]);
    expect((await backend.load("p")).snapshot).toBeNull();
    s.stop();
  });

  it("survives a stop and start with its doc and group", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    const close = neverSynced();
    const doc = new LoroDoc();
    const s = session(doc);
    s.start();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(s.snapshot().crypto).not.toBeNull());
    const mls = s.snapshot().mls;

    s.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(group.instances[0]!.stops).toBe(1);
    // Stopped for good: no socket, and a late result changes nothing.
    await expect(s.syncNow()).resolves.toBe("offline");

    s.start();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalledTimes(2));
    expect(vi.mocked(connectSpace).mock.calls[1]![0].doc).toBe(doc);
    expect(s.snapshot().mls).toBe(mls);
    expect(group.instances).toHaveLength(1);
    await vi.waitFor(() => expect(group.instances[0]!.starts).toHaveLength(2));
    s.stop();
  });

  it("ends in an error phase when the doc is refused", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    let refuse!: () => void;
    let accept: ((doc: LoroDoc) => boolean | undefined) | undefined;
    vi.mocked(connectSpace).mockImplementation((o) => {
      accept = o.accept;
      refuse = () => o.onRefused?.();
      return {
        getStatus: () => "connecting",
        subscribe: (listener) => {
          listener("connecting");
          return () => {};
        },
        synced: new Promise(() => {}),
        syncNow: () => Promise.resolve("offline"),
        close: () => {},
      };
    });
    const onRefused = vi.fn();
    const check = vi.fn(() => false);
    const s = new SpaceSession({
      token: "tok",
      linkKey: secret,
      doc: new LoroDoc(),
      identity,
      accept: check,
      refusedMessage: "Not for here.",
      onRefused,
    });
    s.start();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalled());
    expect(accept).toBe(check);

    refuse();
    expect(s.snapshot().phase).toEqual({
      phase: "error",
      message: "Not for here.",
    });
    expect(onRefused).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("falls back to a generic message for a refusal", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    let refuse!: () => void;
    vi.mocked(connectSpace).mockImplementation((o) => {
      refuse = () => o.onRefused?.();
      return {
        getStatus: () => "connecting",
        subscribe: () => () => {},
        synced: new Promise(() => {}),
        syncNow: () => Promise.resolve("offline"),
        close: () => {},
      };
    });
    const s = session();
    s.start();
    await vi.waitFor(() => expect(connectSpace).toHaveBeenCalled());
    refuse();
    expect(s.snapshot().phase).toMatchObject({ phase: "error" });
    s.stop();
  });
});
