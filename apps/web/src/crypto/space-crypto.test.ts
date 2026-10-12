// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url, toHex } from "./bytes";
import {
  BLOB_OVERHEAD,
  BadSignatureError,
  KeyMismatchError,
  NewerVersionError,
  NotEditorError,
  SpaceCrypto,
  UnknownGenerationError,
} from "./space-crypto";
import { secretKind } from "./secret";
import { editorOf, newProject, viewerOf } from "./test-utils";
import * as wasm from "./wasm";

const span = { peer: "7", start: 0, end: 3 };
const text = (s: string) => new TextEncoder().encode(s);

describe("secrets", () => {
  it("are told apart the same way in TypeScript and in the wasm", () => {
    const project = newProject();
    const edit = project.link.toBase64url();
    const view = project.link.viewSecret();
    const bytes = fromBase64Url(edit)!;
    const newer = Uint8Array.from([9, ...bytes.slice(1), 1]);
    const zeroKind = Uint8Array.from([0, ...bytes.slice(1), 1]);
    for (const raw of [
      edit,
      view,
      toBase64Url(newer),
      toBase64Url(zeroKind),
      "",
      "AAAA",
      edit.slice(1),
    ]) {
      expect(secretKind(raw), raw).toBe(wasm.secretKind(raw) ?? null);
    }
    expect(secretKind(edit)).toBe("edit");
    expect(secretKind(view)).toBe("view");
  });

  it("round trip and produce the view secret", () => {
    const { link } = newProject();
    const again = wasm.LinkSecret.parse(link.toBase64url());
    expect(again.canAttest()).toBe(true);
    expect(again.viewSecret()).toBe(link.viewSecret());
    expect(wasm.LinkSecret.parse(link.viewSecret()).canAttest()).toBe(false);
  });
});

describe("SpaceCrypto", () => {
  it("remembers which device signed what each peer wrote", () => {
    const project = newProject();
    const reader = viewerOf(project);
    const record = project.crypto.encryptDelta(span, text("ops"));
    const { signer } = reader.decryptRecord(record);
    expect(reader.signers.get("7")).toBe(toHex(signer));
    expect(reader.signers.get("8")).toBeUndefined();
  });

  it("lets editors write what other devices read", () => {
    const project = newProject();
    const record = project.crypto.encryptDelta(span, text("ops"));
    for (const reader of [editorOf(project), viewerOf(project)]) {
      const out = reader.decryptRecord(record);
      expect(out).toMatchObject({ kind: "delta", peer: "7", start: 0, end: 3 });
      expect(out.plaintext).toEqual(text("ops"));
    }

    const snapshot = project.crypto.encryptSnapshot(
      [
        { peer: "9", counter: 2 },
        { peer: "10", counter: 5 },
      ],
      text("snap"),
    );
    const out = editorOf(project).decryptRecord(snapshot);
    expect(out).toMatchObject({
      kind: "snapshot",
      vv: [
        { peer: "10", counter: 5 },
        { peer: "9", counter: 2 },
      ],
    });
  });

  it("keeps viewers read-only", () => {
    const project = newProject();
    const viewer = viewerOf(project);
    expect(viewer.canWrite).toBe(false);
    expect(viewer.editSecret).toBeNull();
    expect(() => viewer.encryptDelta(span, text("x"))).toThrow(/read-only/);
  });

  it("refuses a record from a device nobody attested", () => {
    const project = newProject();
    const stranger = newProject();
    // Same keys, but a signer attested by another project's link.
    const forger = new SpaceCrypto(
      project.link,
      new wasm.DocKeys(project.keyring),
      wasm.Signer.attested(stranger.link, 1),
    );
    const record = forger.encryptDelta(span, text("x"));
    expect(() => project.crypto.decryptRecord(record)).toThrow(NotEditorError);
  });

  it("throws typed errors", () => {
    const project = newProject();
    const other = newProject();
    const record = project.crypto.encryptDelta(span, text("x"));
    expect(() => other.crypto.decryptRecord(record)).toThrow(KeyMismatchError);
    expect(() =>
      SpaceCrypto.open(other.link.toBase64url(), project.signed),
    ).toThrow(BadSignatureError);

    const next = project.keyring.next(project.link);
    const rotated = new SpaceCrypto(project.link, new wasm.DocKeys(next));
    expect(() =>
      project.crypto.decryptRecord(rotated.encryptDelta(span, text("y"))),
    ).toThrow(UnknownGenerationError);
    expect(() =>
      project.crypto.decryptRecord(new Uint8Array([1, 2])),
    ).toThrow();

    const bytes = fromBase64Url(project.link.toBase64url())!;
    expect(() =>
      SpaceCrypto.open(
        toBase64Url(Uint8Array.from([9, ...bytes.slice(1), 1])),
        project.signed,
      ),
    ).toThrow(NewerVersionError);
  });

  it("seals blobs and presence", () => {
    const project = newProject();
    const blob = project.crypto.sealBlob(text("figure"));
    expect(blob.length).toBe(6 + BLOB_OVERHEAD);
    expect(BLOB_OVERHEAD).toBe(wasm.blobOverhead());
    expect(viewerOf(project).openBlob(blob)).toEqual(text("figure"));
    expect(() => newProject().crypto.openBlob(blob)).toThrow();

    const sealed = project.crypto.sealPresence(text("cursor"));
    expect(editorOf(project).openPresence(sealed)).toEqual(text("cursor"));
  });
});

describe("MLS group", () => {
  const profile = text(JSON.stringify({ name: "Ada", color: "#1d4ed8" }));

  it("creates, joins, removes and rotates through the wasm", () => {
    const link = wasm.LinkSecret.generateEdit();
    const device = wasm.DeviceKey.generate().export();
    const graph = wasm.PersonGraph.genesis(device).encode();
    const { group, message: init } = wasm.SpaceGroup.create(
      link,
      profile,
      device,
      graph,
    );
    expect(init.type).toBe("init");
    expect(group.epoch).toBe(0);
    expect(group.members()).toHaveLength(1);
    expect(group.members()[0]).toMatchObject({ role: "owner", isSelf: true });

    // The delivery service, reduced to storing what Init and Submit carry.
    const { group: joiner, message: submit } = wasm.SpaceGroup.joinExternal(
      link,
      init.groupInfo,
      init.keyring,
      init.ownerKey,
      profile,
    );
    expect(submit.type).toBe("submit");
    const outcome = group.processCommit(submit.epoch, submit.commit);
    expect(outcome.type).toBe("advanced");
    joiner.confirmPending();
    expect(group.members()).toHaveLength(2);

    const other = group.members().find((m) => !m.isSelf)!;
    const removal = group.removeAndRotate(Uint32Array.of(other.leaf));
    expect(removal.rotate).toBeDefined();
    group.confirmPending();
    const result = joiner.processCommit(
      removal.epoch,
      removal.commit,
      removal.envelope,
    );
    expect(result.type).toBe("removed");

    // The signer and doc keys feed SpaceCrypto.
    const crypto = new SpaceCrypto(
      group.link(),
      group.docKeys(),
      group.signer(),
    );
    expect(crypto.generation).toBe(2);
    const record = crypto.encryptDelta(span, text("after"));
    expect(crypto.decryptRecord(record).signer).toEqual(
      group.members()[0]!.sigPub,
    );

    const presence = group.presenceKey();
    const open = presence.open(presence.seal(text("hi")));
    expect(open.plaintext).toEqual(text("hi"));
    crypto.setGroupKeys(group.docKeys(), group.signer(), presence);
    expect(crypto.openPresence(crypto.sealPresence(text("x")))).toEqual(
      text("x"),
    );

    const restored = wasm.SpaceGroup.importState(group.exportState());
    expect(restored.epoch).toBe(group.epoch);
  });

  it("encodes delivery service messages", () => {
    const bytes = wasm.encodeClientMessage({
      type: "hello",
      token: "tok",
      incarnation: 0,
      sinceEpoch: 0,
    });
    expect(bytes.length).toBeGreaterThan(3);
    expect(() => wasm.decodeServerMessage(new Uint8Array([0xff]))).toThrow();
    expect(wasm.dsPath()).toBe("/ws/mls");
    expect(() => wasm.encodeClientMessage({ type: "nope" } as never)).toThrow();
  });
});
