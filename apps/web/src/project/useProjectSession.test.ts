import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newProject } from "@/crypto/test-utils";
import {
  fetchMlsBootstrap,
  OutdatedClientError,
  resolveShare,
} from "@/sync/api";
import { connectProject, type ConnectOptions } from "@/sync/connection";
import { RELOAD_MESSAGE } from "@/sync/protocol";

import type { MlsSnapshot } from "@/mls/session";

import { LoroDoc } from "loro-crdt";

import { initProject } from "@/doc/schema";
import { LocalDocStore, MemoryBackend } from "@/persist/local-doc-store";

import {
  loadProjectKey,
  loadShare,
  rememberShare,
  saveKeyring,
} from "./recent";
import { useProjectSession } from "./useProjectSession";

vi.mock("@/sync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/sync/api")>()),
  resolveShare: vi.fn(),
  fetchMlsBootstrap: vi.fn(),
}));
vi.mock("@/sync/connection", () => ({ connectProject: vi.fn() }));

// The member group has its own tests (mls/session.test.ts); here it only
// has to be something the hook can watch and be told about.
const group = vi.hoisted(() => ({
  instances: [] as {
    options: import("@/mls/session").MlsSessionOptions;
    snapshot: MlsSnapshot;
    listeners: Set<() => void>;
    caught: number;
  }[],
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
    private readonly self: (typeof group.instances)[number];
    constructor(options: import("@/mls/session").MlsSessionOptions) {
      this.self = {
        options,
        snapshot: {
          phase: "active",
          members: [],
          canCommit: false,
          holdsOwnerKey: false,
          stalled: false,
          error: null,
        },
        listeners: new Set(),
        caught: 0,
      };
      group.instances.push(this.self);
    }
    subscribe = (l: () => void) => {
      this.self.listeners.add(l);
      return () => this.self.listeners.delete(l);
    };
    getSnapshot = () => this.self.snapshot;
    start = async () => {};
    stop() {}
    keys() {
      return null;
    }
    onKeys() {
      return () => {};
    }
    updateProfile() {}
    catchUp() {
      this.self.caught++;
    }
  },
}));

function connectedForever() {
  vi.mocked(connectProject).mockReturnValue({
    getStatus: () => "connected",
    subscribe: () => () => {},
    synced: new Promise(() => {}),
    syncNow: () => Promise.resolve("synced"),
    close: () => {},
  });
}
const stored = vi.hoisted(() => ({
  backend: null as import("@/persist/local-doc-store").DocBackend | null,
}));
vi.mock("@/persist/local-doc-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/persist/local-doc-store")>();
  return {
    ...real,
    defaultBackend: () =>
      Promise.resolve((stored.backend ??= new real.MemoryBackend())),
  };
});

const share = { projectId: "p", permission: "write" as const };
// Generated once: a new secret on every render would reopen the project.
const keys = newProject();
const secret = keys.link.toBase64url();

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
  group.instances.length = 0;
  vi.mocked(resolveShare).mockReset();
  vi.mocked(fetchMlsBootstrap).mockReset();
  vi.mocked(connectProject).mockReset();
  localStorage.clear();
});

describe("useProjectSession on an outdated page", () => {
  it("asks for a reload when the API refuses it, even with local data", async () => {
    rememberShare("tok", share);
    vi.mocked(resolveShare).mockRejectedValue(new OutdatedClientError());
    vi.mocked(connectProject).mockReturnValue({
      getStatus: () => "connecting",
      subscribe: () => () => {},
      synced: new Promise(() => {}),
      syncNow: () => Promise.resolve("offline"),
      close: () => {},
    });
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() =>
      expect(result.current.state).toEqual({
        phase: "error",
        message: RELOAD_MESSAGE,
      }),
    );
  });

  it("asks for a reload when the socket finds the server refuses it", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    let rejectSynced: (err: Error) => void = () => {};
    let opts: ConnectOptions | undefined;
    vi.mocked(connectProject).mockImplementation((o) => {
      opts = o;
      return {
        getStatus: () => "disconnected",
        subscribe: () => () => {},
        synced: new Promise((_, reject) => (rejectSynced = reject)),
        syncNow: () => Promise.resolve("offline"),
        close: () => {},
      };
    });
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(opts).toBeDefined());
    opts!.onOutdated!();
    // Stopping the connection fails its join, which must not hide why.
    rejectSynced(new Error("Disconnected"));
    await waitFor(() =>
      expect(result.current.state).toEqual({
        phase: "error",
        message: RELOAD_MESSAGE,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state).toEqual({
      phase: "error",
      message: RELOAD_MESSAGE,
    });
  });
});

describe("useProjectSession and the member group", () => {
  it("keeps the new links of a rotation and asks to be moved to them", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    connectedForever();
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(group.instances).toHaveLength(1));
    expect(result.current.following).toBeNull();

    act(() =>
      group.instances[0]!.options.onRotated!({
        link: "newsecret",
        token: "tok-new",
        viewToken: "view-new",
        canEdit: true,
      }),
    );

    expect(result.current.following).toEqual({
      token: "tok-new",
      link: "newsecret",
    });
    // Stored before anything else happens, since nothing else holds them.
    expect(loadShare("tok-new")).toEqual({
      projectId: "p",
      permission: "write",
      viewToken: "view-new",
    });
    expect(loadShare("view-new")?.permission).toBe("read");
  });

  it("stops asking once the page is on the new token", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    connectedForever();
    const { result, rerender } = renderHook(
      ({ token }) => useProjectSession(token, secret),
      { initialProps: { token: "tok" } },
    );
    await waitFor(() => expect(group.instances).toHaveLength(1));
    act(() =>
      group.instances[0]!.options.onRotated!({
        link: secret,
        token: "tok-new",
        viewToken: "view-new",
        canEdit: true,
      }),
    );
    expect(result.current.following).not.toBeNull();
    rerender({ token: "tok-new" });
    expect(result.current.following).toBeNull();
    // One group for the whole visit: the rotation does not restart it.
    expect(group.instances).toHaveLength(1);
    expect(loadProjectKey("p")).toBe(secret);
  });

  it("shows the removal ahead of the sockets' errors", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    connectedForever();
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(group.instances).toHaveLength(1));
    act(() => {
      const instance = group.instances[0]!;
      instance.snapshot = { ...instance.snapshot, phase: "removed" };
      instance.listeners.forEach((l) => l());
    });
    expect(result.current.state).toEqual({ phase: "removed" });
  });

  it("explains a replaced link that no group can account for", async () => {
    vi.mocked(resolveShare).mockResolvedValue({ ...share, retired: true });
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(group.instances).toHaveLength(1));
    act(() => {
      const instance = group.instances[0]!;
      instance.snapshot = { ...instance.snapshot, phase: "unavailable" };
      instance.listeners.forEach((l) => l());
    });
    expect(result.current.state).toMatchObject({ phase: "error" });
    // No doc connection for a token that only reads the log.
    expect(connectProject).not.toHaveBeenCalled();
  });

  it("explains a replaced link even when the group is still active", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    connectedForever();
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(group.instances).toHaveLength(1));
    act(() => {
      const instance = group.instances[0]!;
      instance.snapshot = { ...instance.snapshot, phase: "lost" };
      instance.listeners.forEach((l) => l());
    });
    expect(result.current.state).toMatchObject({
      phase: "error",
      message: expect.stringContaining("replaced"),
    });
  });

  it("opens the local copy of a project whose cached token was replaced, without a server", async () => {
    // A copy this browser kept, and the keyring it cached with it.
    const backend = new MemoryBackend();
    stored.backend = backend;
    const doc = new LoroDoc();
    const store = new LocalDocStore("p", doc, backend);
    await store.load();
    initProject(doc, { title: "Offline", starter: true });
    await store.flush();
    saveKeyring("p", keys.signed);

    rememberShare("tok", { ...share, retired: true });
    vi.mocked(resolveShare).mockRejectedValue(new Error("offline"));
    vi.mocked(fetchMlsBootstrap).mockResolvedValue(null);
    const { result } = renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    // Reading is all a replaced token allows; nothing is synced with it.
    expect(connectProject).not.toHaveBeenCalled();
  });

  it("sends a record of a newer key generation to the group instead of refetching a keyring", async () => {
    vi.mocked(resolveShare).mockResolvedValue(share);
    connectedForever();
    renderHook(() => useProjectSession("tok", secret));
    await waitFor(() => expect(connectProject).toHaveBeenCalled());
    const opts = vi.mocked(connectProject).mock.calls[0]![0];
    const before = vi.mocked(fetchMlsBootstrap).mock.calls.length;
    opts.onUnknownGeneration!(2);
    expect(group.instances[0]!.caught).toBe(1);
    expect(vi.mocked(fetchMlsBootstrap).mock.calls.length).toBe(before);
  });
});
