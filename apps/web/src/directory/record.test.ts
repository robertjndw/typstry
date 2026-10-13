import { describe, expect, it, vi } from "vitest";

import { toHex } from "@/crypto/bytes";
import {
  ownerPublicKeyOf,
  ownerSecretList,
  withOwnerSecrets,
} from "@/crypto/wasm";

import { directory } from "./store";
import { editSecret, token, viewSecret } from "./test-utils";
import {
  recordAdopted,
  recordForgotten,
  recordOpened,
  recordOwnerSecret,
  recordResolved,
  recordRetired,
  recordRotation,
  recordStatus,
  withDirectoryOwnerKeys,
} from "./record";

const edit = { token: token(1), secret: editSecret(1), edit: true };

async function only() {
  const [entry, ...rest] = (await directory()).list(Date.now());
  expect(rest).toEqual([]);
  return entry!;
}

describe("directory records", () => {
  it("never throws, so a broken directory cannot stop a project opening", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordOpened("p", { token: "short", secret: "x", edit: true }, "T"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect((await directory()).list(Date.now())).toEqual([]);
    warn.mockRestore();
  });

  it("opening lists the project and brings back one that was removed", async () => {
    await recordOpened("p", edit, "Thesis");
    await recordStatus(token(1), "removed");
    expect((await only()).state).toBe("removed");
    await recordOpened("p", edit, "Thesis");
    expect(await only()).toMatchObject({
      title: "Thesis",
      state: "listed",
      link: { token: token(1), edit: true },
    });
  });

  it("leaves a directory of another kind or a newer layout alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await directory();
    dir.doc.getMap("meta").set("schema", 99);
    dir.doc.commit();
    const before = dir.doc.oplogVersion();
    await recordOpened("p", edit, "T");
    await expect(recordForgotten("p")).rejects.toThrow(/unsupported directory/);
    await recordOwnerSecret("p", new Uint8Array(32).fill(7));
    expect(dir.doc.oplogVersion().compare(before)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("adopting a link lists it without marking it opened", async () => {
    await recordAdopted(
      "p",
      { token: token(2), secret: viewSecret(), edit: false },
      "Shared",
    );
    expect(await only()).toMatchObject({ title: "Shared", openedAt: null });
  });

  it("a rotation lists the new link and retires the best one before it", async () => {
    await recordOpened("p", edit, "T");
    await recordRotation("p", {
      link: editSecret(2),
      token: token(2),
      viewToken: token(3),
      canEdit: true,
    });
    expect((await only()).link).toEqual({
      token: token(2),
      secret: editSecret(2),
      edit: true,
      retired: false,
    });
    expect((await directory()).doc.getMap("retired").get(token(1))).toBeTypeOf(
      "number",
    );
  });

  it("records a rotation in one commit", async () => {
    await recordOpened("p", edit, "T");
    const dir = await directory();
    const peer = dir.doc.peerIdStr;
    const changes = dir.doc.getAllChanges().get(peer)?.length ?? 0;
    await recordRotation("p", {
      link: editSecret(2),
      token: token(2),
      viewToken: null,
      canEdit: true,
    });
    expect(dir.doc.getAllChanges().get(peer)).toHaveLength(changes + 1);
  });

  it("a view rotation is not an edit link", async () => {
    await recordRotation("p", {
      link: viewSecret(2),
      token: token(2),
      viewToken: null,
      canEdit: false,
    });
    expect((await only()).link.edit).toBe(false);
  });

  it("knows retired, gone and forgotten", async () => {
    await recordOpened("p", edit, "T");
    await recordStatus(token(1), "gone");
    expect((await only()).state).toBe("gone");
    // Unknown tokens are ignored.
    await recordStatus(token(9), "removed");
    await recordRetired(token(1));
    expect((await only()).link.retired).toBe(true);
    await recordForgotten("p");
    expect((await only()).state).toBe("forgotten");
  });

  it("records an owner key once, and leaves the directory alone when it is there", async () => {
    const secret = new Uint8Array(32).fill(7);
    await recordOwnerSecret("p", secret);
    const dir = await directory();
    expect(dir.ownerKeys("p", Date.now()).map((k) => k.publicKey)).toEqual([
      toHex(ownerPublicKeyOf(secret)),
    ]);
    const before = dir.doc.oplogVersion().toJSON();
    await recordOwnerSecret("p", secret);
    expect(dir.doc.oplogVersion().toJSON()).toEqual(before);
  });

  it("moves a token the directory files under another project", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordOpened("p", edit, "T");
    await recordResolved(token(1), "p");
    expect((await only()).projectId).toBe("p");
    await recordResolved(token(1), "other");
    // Re-filed with its secret, not retired.
    expect(await only()).toMatchObject({
      projectId: "other",
      link: { token: token(1), secret: editSecret(1), retired: false },
    });
    // A token the directory never saw is not its business.
    await recordResolved(token(9), "other");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("adds directory owner keys in free room only", async () => {
    const mine = Array.from({ length: 8 }, (_, i) =>
      new Uint8Array(32).fill(i + 1),
    );
    const held = withOwnerSecrets(undefined, mine)!;
    const dir = await directory();
    for (const [i, key] of Array.from({ length: 8 }, (_, i) =>
      new Uint8Array(32).fill(100 + i),
    ).entries())
      dir.addOwnerKey("p", key, 1000 + i);
    const merged = await withDirectoryOwnerKeys("p", held);
    // Everything held stays, in order, whatever the directory planted.
    expect(ownerSecretList(merged).slice(0, mine.length)).toEqual(
      ownerSecretList(held),
    );
    expect(await withDirectoryOwnerKeys("none", held)).toBe(held);
  });
});
