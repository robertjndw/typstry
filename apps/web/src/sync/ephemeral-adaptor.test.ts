// @vitest-environment node
import { EphemeralStore } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";

import {
  PRESENCE_CONTEXT,
  generateRawProjectKey,
  importProjectKey,
  open,
} from "@/crypto/project-key";

import { EphemeralStoreAdaptor } from "./ephemeral-adaptor";

function ctx() {
  return { send: vi.fn(), onJoinFailed: vi.fn(), onImportError: vi.fn() };
}

const key = await importProjectKey(generateRawProjectKey());

async function settle() {
  // Sealing and opening go through WebCrypto, which resolves on a later task.
  await new Promise((r) => setTimeout(r, 10));
}

describe("EphemeralStoreAdaptor", () => {
  it("sends only sealed own state, again on join", async () => {
    const store = new EphemeralStore(30_000);
    const adaptor = new EphemeralStoreAdaptor(store, key);
    const c = ctx();
    adaptor.setCtx(c);

    await adaptor.handleJoinOk();
    expect(c.send).not.toHaveBeenCalled();

    store.set("p:1", { name: "Ada" });
    await settle();
    expect(c.send).toHaveBeenCalledTimes(1);
    const sealed = c.send.mock.calls[0]![0][0] as Uint8Array;
    expect(new TextDecoder().decode(sealed)).not.toContain("Ada");

    await adaptor.handleJoinOk();
    expect(c.send).toHaveBeenCalledTimes(2);

    const peer = new EphemeralStore(30_000);
    peer.apply(await open(key, c.send.mock.calls[1]![0][0], PRESENCE_CONTEXT));
    expect(peer.get("p:1")).toEqual({ name: "Ada" });
    store.destroy();
    peer.destroy();
  });

  it("does not re-announce entries received from others", async () => {
    const remote = new EphemeralStore(30_000);
    const remoteAdaptor = new EphemeralStoreAdaptor(remote, key);
    const rc = ctx();
    remoteAdaptor.setCtx(rc);
    remote.set("p:2", "there");
    await settle();

    const store = new EphemeralStore(30_000);
    const adaptor = new EphemeralStoreAdaptor(store, key);
    const c = ctx();
    adaptor.setCtx(c);
    adaptor.applyUpdate([rc.send.mock.calls[0]![0][0]]);
    await settle();
    expect(store.get("p:2")).toBe("there");

    await adaptor.handleJoinOk();
    expect(c.send).not.toHaveBeenCalled();
    remote.destroy();
    store.destroy();
  });

  it("reports blobs that do not open with the key", async () => {
    const other = await importProjectKey(generateRawProjectKey());
    const remote = new EphemeralStore(30_000);
    const remoteAdaptor = new EphemeralStoreAdaptor(remote, other);
    const rc = ctx();
    remoteAdaptor.setCtx(rc);
    remote.set("p:2", "here");
    await settle();

    const store = new EphemeralStore(30_000);
    const adaptor = new EphemeralStoreAdaptor(store, key);
    const c = ctx();
    adaptor.setCtx(c);
    adaptor.applyUpdate([rc.send.mock.calls[0]![0][0], new Uint8Array([1, 2])]);
    await settle();
    expect(store.get("p:2")).toBeUndefined();
    expect(c.onImportError).toHaveBeenCalledTimes(2);
    remote.destroy();
    store.destroy();
  });

  it("leaves the store usable after destroy", async () => {
    const store = new EphemeralStore(30_000);
    const adaptor = new EphemeralStoreAdaptor(store, key);
    const c = ctx();
    adaptor.setCtx(c);
    adaptor.destroy();

    store.set("p:3", 1);
    await settle();
    expect(store.get("p:3")).toBe(1);
    expect(c.send).not.toHaveBeenCalled();
    store.destroy();
  });
});
