// @vitest-environment node
import { EphemeralStore } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";

import { ProjectCrypto } from "@/crypto/project-crypto";
import { newProject } from "@/crypto/test-utils";
import { LinkSecret, ProjectGroup } from "@/crypto/wasm";

import { EphemeralStoreAdaptor } from "./ephemeral-adaptor";

function ctx() {
  return { send: vi.fn(), onJoinFailed: vi.fn(), onImportError: vi.fn() };
}

const key = newProject().crypto;

async function settle() {
  // Sends are queued behind each other, so they land on a later task.
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
    peer.apply(key.openPresence(c.send.mock.calls[1]![0][0])!);
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
    const other = newProject().crypto;
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

  it("lets only records bind a peer, and drops presence posing as a bound one", async () => {
    // Two members of one group, each with its own device key.
    const link = LinkSecret.generateEdit();
    const profile = new TextEncoder().encode("{}");
    const { group: a, message: init } = ProjectGroup.create(link, profile);
    const { group: b, message: submit } = ProjectGroup.joinExternal(
      link,
      init.groupInfo,
      init.keyring,
      profile,
    );
    a.processCommit(submit.epoch, submit.commit);
    b.confirmPending();
    const memberOf = (group: ProjectGroup) => {
      const crypto = new ProjectCrypto(link, group.docKeys(), group.signer());
      crypto.setGroupKeys(group.docKeys(), group.signer(), group.presenceKey());
      return crypto;
    };
    const victim = memberOf(a);
    const attacker = memberOf(b);

    const send = async (crypto: ProjectCrypto, entries: string[]) => {
      const remote = new EphemeralStore(30_000);
      const adaptor = new EphemeralStoreAdaptor(remote, crypto);
      const rc = ctx();
      adaptor.setCtx(rc);
      for (const entry of entries) remote.set(entry, "posing");
      await settle();
      remote.destroy();
      return rc.send.mock.calls.map((c) => c[0][0] as Uint8Array);
    };
    const store = new EphemeralStore(30_000);
    const reader = new EphemeralStoreAdaptor(store, victim);
    reader.setCtx(ctx());

    // Before any record of peer 7, the claim is shown but binds nothing.
    reader.applyUpdate(await send(attacker, ["p:7"]));
    await settle();
    expect(store.get("p:7")).toBe("posing");
    expect(victim.signers.get("7")).toBeUndefined();

    // Peer 7 proves itself with a signed record.
    victim.decryptRecord(
      victim.encryptDelta({ peer: "7", start: 0, end: 1 }, new Uint8Array([1])),
    );
    store.delete("p:7");

    // The same claim from another device is dropped; a peer nobody has
    // proven is let through.
    reader.applyUpdate(await send(attacker, ["p:7", "p:8"]));
    await settle();
    expect(store.get("p:7")).toBeUndefined();
    expect(store.get("p:8")).toBe("posing");
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
