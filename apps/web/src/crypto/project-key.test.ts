// @vitest-environment node
import { BytesWriter, parseEloRecordHeader } from "loro-protocol";
import { describe, expect, it } from "vitest";

import {
  BadSignatureError,
  BLOB_CONTEXT,
  decryptRecord,
  encryptDelta,
  encryptSnapshot,
  fromBase64Url,
  generateEditSecret,
  importProjectKey,
  isEditSecret,
  isProjectSecret,
  KeyMismatchError,
  open,
  PRESENCE_CONTEXT,
  seal,
  SEAL_OVERHEAD,
  toBase64Url,
} from "./project-key";

const encoder = new TextEncoder();

describe("project keys", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
    expect(fromBase64Url("not base64!")).toBeNull();
  });

  it("generates 256-bit edit secrets in URL-safe form", async () => {
    const raw = generateEditSecret();
    expect(raw).toHaveLength(43);
    expect(isEditSecret(raw)).toBe(true);
    expect(isProjectSecret(raw.slice(1))).toBe(false);
    const key = await importProjectKey(raw);
    expect(key.editSecret).toBe(raw);
    expect(key.sign).not.toBeNull();
    // Same key, same fingerprint; another key, another one.
    expect((await importProjectKey(raw)).keyId).toBe(key.keyId);
    expect((await importProjectKey(generateEditSecret())).keyId).not.toBe(
      key.keyId,
    );
  });

  it("derives a view secret that reads but cannot sign", async () => {
    const editor = await importProjectKey(generateEditSecret());
    expect(editor.viewSecret).toHaveLength(86);
    expect(isProjectSecret(editor.viewSecret)).toBe(true);
    expect(isEditSecret(editor.viewSecret)).toBe(false);
    const viewer = await importProjectKey(editor.viewSecret);
    expect(viewer.editSecret).toBeNull();
    expect(viewer.sign).toBeNull();
    expect(viewer.keyId).toBe(editor.keyId);
    expect(viewer.viewSecret).toBe(editor.viewSecret);

    const record = await encryptDelta(
      editor,
      { peer: "7", start: 0, end: 3 },
      encoder.encode("ops"),
    );
    expect((await decryptRecord(viewer, record)).plaintext).toEqual(
      encoder.encode("ops"),
    );
    await expect(
      encryptDelta(
        viewer,
        { peer: "7", start: 0, end: 3 },
        encoder.encode("x"),
      ),
    ).rejects.toThrow(/view-only/);
    await expect(
      encryptSnapshot(viewer, [], encoder.encode("x")),
    ).rejects.toThrow(/view-only/);
  });

  it("rejects malformed secrets", async () => {
    await expect(importProjectKey("short")).rejects.toThrow(/malformed/);
    await expect(
      importProjectKey(toBase64Url(new Uint8Array(48))),
    ).rejects.toThrow(/malformed/);
  });

  it("refuses records signed by anyone but an editor", async () => {
    const editor = await importProjectKey(generateEditSecret());
    const viewer = await importProjectKey(editor.viewSecret);
    // A forger holding the read key re-signs a valid record with a key of
    // their own: the only thing a view link would let them do.
    const forger = await importProjectKey(generateEditSecret());
    const record = await encryptDelta(
      editor,
      { peer: "7", start: 0, end: 3 },
      encoder.encode("ops"),
    );
    const parsed = parseEloRecordHeader(record);
    const body = parsed.ct.subarray(0, parsed.ct.length - 64);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        forger.sign!,
        new Uint8Array([
          ...encoder.encode("typstry:v2:record-signature"),
          ...parsed.aad,
          ...body,
        ]),
      ),
    );
    const w = new BytesWriter();
    w.pushBytes(parsed.headerBytes);
    w.pushVarBytes(new Uint8Array([...body, ...signature]));
    await expect(decryptRecord(viewer, w.finalize())).rejects.toBeInstanceOf(
      BadSignatureError,
    );

    const tampered = record.slice();
    tampered[tampered.length - 65]! ^= 1;
    await expect(decryptRecord(editor, tampered)).rejects.toBeInstanceOf(
      BadSignatureError,
    );
    await expect(decryptRecord(forger, record)).rejects.toBeInstanceOf(
      KeyMismatchError,
    );
  });

  it("seals and opens, bound to key and context", async () => {
    const key = await importProjectKey(generateEditSecret());
    const viewer = await importProjectKey(key.viewSecret);
    const other = await importProjectKey(generateEditSecret());
    const plaintext = encoder.encode("= Hello");
    const sealed = await seal(key, plaintext, BLOB_CONTEXT);
    expect(sealed.length).toBe(plaintext.length + SEAL_OVERHEAD);
    expect(await open(key, sealed, BLOB_CONTEXT)).toEqual(plaintext);
    expect(await open(viewer, sealed, BLOB_CONTEXT)).toEqual(plaintext);
    await expect(open(key, sealed, PRESENCE_CONTEXT)).rejects.toThrow();
    await expect(open(other, sealed, BLOB_CONTEXT)).rejects.toThrow();
    // Fresh salt and IV every time.
    const again = await seal(key, plaintext, BLOB_CONTEXT);
    expect(again.subarray(0, 16)).not.toEqual(sealed.subarray(0, 16));
  });
});
