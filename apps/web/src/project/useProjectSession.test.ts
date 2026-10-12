import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEditSecret } from "@/crypto/project-key";
import { OutdatedClientError, resolveShare } from "@/sync/api";
import { connectProject, type ConnectOptions } from "@/sync/connection";
import { RELOAD_MESSAGE } from "@/sync/protocol";

import { rememberShare } from "./recent";
import { useProjectSession } from "./useProjectSession";

vi.mock("@/sync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/sync/api")>()),
  resolveShare: vi.fn(),
}));
vi.mock("@/sync/connection", () => ({ connectProject: vi.fn() }));
vi.mock("@/persist/local-doc-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/persist/local-doc-store")>();
  return {
    ...real,
    defaultBackend: () => Promise.resolve(new real.MemoryBackend()),
  };
});

const share = { projectId: "p", permission: "write" as const };
// Generated once: a new secret on every render would reopen the project.
const secret = generateEditSecret();

afterEach(() => {
  vi.mocked(resolveShare).mockReset();
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
