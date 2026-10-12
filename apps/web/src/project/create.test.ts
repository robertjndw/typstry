import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectGroup } from "@/crypto/wasm";
import { frames } from "@/mls/test-utils";
import { MemoryBackend } from "@/persist/local-doc-store";
import { decodeProfile, provisionalIdentity } from "@/presence/identity";

import { createLocalProject } from "./create";
import { loadProjectKey } from "./recent";

/** Plays the delivery service: ready on hello, accepted on the init. */
class ServerSocket {
  binaryType = "";
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  tags: number[] = [];

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: Uint8Array) {
    this.tags.push(data[0]!);
    if (data[0] === 1) this.reply(frames.ready(0, 0, "write"));
    if (data[0] === 4) this.reply(frames.accepted(1));
  }

  protected reply(data: ArrayBuffer) {
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("createLocalProject", () => {
  it("keeps the group the server was given, so the creator is its first member", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { projectId: "proj", editToken: "edit", viewToken: "view" },
          { status: 201 },
        ),
      ),
    );
    const backend = new MemoryBackend();
    const sockets: ServerSocket[] = [];
    const created = await createLocalProject("Title", {
      backend,
      ds: {
        createSocket: () => {
          const socket = new ServerSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      },
    });

    // hello, then init
    expect(sockets[0]!.tags).toEqual([1, 4]);
    expect(loadProjectKey("proj")).toBe(created.key);

    const stored = await backend.loadMls("proj");
    expect(stored?.removed).toBe(false);
    const group = ProjectGroup.importState(stored!.state!);
    expect(group.isActive).toBe(true);
    expect(group.members()).toHaveLength(1);
    expect(group.members()[0]!.isSelf).toBe(true);
    expect(group.link().toBase64url()).toBe(created.key);
    // The device is kept apart, for a rejoin after lost state.
    expect(stored!.device).not.toBeNull();
    // With no name picked yet, the profile is the one the project page will
    // show, so opening the project does not change it.
    expect(decodeProfile(group.members()[0]!.profile!)).toEqual(
      provisionalIdentity(),
    );
  });

  it("fails with an API error when the server refuses the group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { projectId: "proj", editToken: "edit", viewToken: "view" },
          { status: 201 },
        ),
      ),
    );
    class Refusing extends ServerSocket {
      override send(data: Uint8Array) {
        if (data[0] === 4) this.reply(frames.refused(1, "forbidden"));
        else super.send(data);
      }
    }
    await expect(
      createLocalProject("Title", {
        backend: new MemoryBackend(),
        ds: { createSocket: () => new Refusing() as unknown as WebSocket },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
