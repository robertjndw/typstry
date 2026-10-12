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
  NewerVersionError,
  open,
  PRESENCE_CONTEXT,
  seal,
  SEAL_OVERHEAD,
  SEAL_VERSION,
  RECORD_VERSION,
  SECRET_EDIT_V1,
  SECRET_VIEW_V1,
  secretKind,
  toBase64Url,
  type ProjectKey,
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
    expect(raw).toHaveLength(44);
    expect(secretKind(raw)).toBe("edit");
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
    expect(editor.viewSecret).toHaveLength(87);
    expect(secretKind(editor.viewSecret)).toBe("view");
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
    const editKey = new Uint8Array(33).fill(5);
    editKey[0] = SECRET_EDIT_V1;
    const viewKey = new Uint8Array(65).fill(5);
    viewKey[0] = SECRET_VIEW_V1;
    for (const bad of [
      "",
      "short",
      toBase64Url(new Uint8Array(16)),
      toBase64Url(editKey.subarray(0, 32)),
      toBase64Url(viewKey.subarray(0, 33)),
      // Secrets from before the kind byte.
      toBase64Url(editKey.subarray(1)),
      toBase64Url(viewKey.subarray(1)),
    ]) {
      expect(secretKind(bad)).toBeNull();
      expect(isProjectSecret(bad)).toBe(false);
      await expect(importProjectKey(bad)).rejects.toThrow(/malformed/);
    }
  });

  it("reports a newer secret kind", async () => {
    const newer = new Uint8Array(33).fill(7);
    newer[0] = 0x7f;
    const raw = toBase64Url(newer);
    expect(secretKind(raw)).toBe("newer");
    expect(isProjectSecret(raw)).toBe(false);
    await expect(importProjectKey(raw)).rejects.toBeInstanceOf(
      NewerVersionError,
    );
    // A zero kind byte is corruption, not a newer kind.
    newer[0] = 0;
    expect(secretKind(toBase64Url(newer))).toBeNull();
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
    expect(again.subarray(1, 17)).not.toEqual(sealed.subarray(1, 17));
    await expect(open(key, new Uint8Array(), BLOB_CONTEXT)).rejects.toThrow(
      /truncated/,
    );
  });

  it("reports unknown version bytes as a newer version", async () => {
    const key = await importProjectKey(generateEditSecret());
    const sealed = await seal(key, encoder.encode("blob"), BLOB_CONTEXT);
    expect(sealed[0]).toBe(SEAL_VERSION);
    sealed[0] = SEAL_VERSION + 1;
    await expect(open(key, sealed, BLOB_CONTEXT)).rejects.toBeInstanceOf(
      NewerVersionError,
    );
    await expect(
      open(key, Uint8Array.of(SEAL_VERSION + 1), BLOB_CONTEXT),
    ).rejects.toBeInstanceOf(NewerVersionError);
    sealed[0] = 0;
    await expect(open(key, sealed, BLOB_CONTEXT)).rejects.toThrow(/malformed/);

    const record = await encryptDelta(
      key,
      { peer: "7", start: 0, end: 3 },
      encoder.encode("ops"),
    );
    const parsed = parseEloRecordHeader(record);
    expect(parsed.ct[0]).toBe(RECORD_VERSION);
    const ct = parsed.ct.slice();
    ct[0] = RECORD_VERSION + 1;
    const w = new BytesWriter();
    w.pushBytes(parsed.headerBytes);
    w.pushVarBytes(ct);
    const error = await decryptRecord(key, w.finalize()).catch((e) => e);
    expect(error).toBeInstanceOf(NewerVersionError);
    expect((error as NewerVersionError).version).toBe(RECORD_VERSION + 1);
    expect((error as Error).message).toMatch(/newer version of typstry/);
  });

  // A newer format relabelled as the current one must fail authentication.
  it("authenticates the version bytes", async () => {
    const key = await importProjectKey(generateEditSecret());
    const salt = new Uint8Array(16).fill(2);
    const iv = new Uint8Array(12).fill(1);
    const blob = await gcm(key, salt, iv, BLOB_CONTEXT, "blob", [
      SEAL_VERSION + 1,
      ...encoder.encode(BLOB_CONTEXT),
    ]);
    const relabelled = new Uint8Array([SEAL_VERSION, ...salt, ...iv, ...blob]);
    await expect(open(key, relabelled, BLOB_CONTEXT)).rejects.toThrow();
    await expect(
      open(key, relabelled, BLOB_CONTEXT),
    ).rejects.not.toBeInstanceOf(NewerVersionError);

    // A record's version is both signed and in the AEAD, so a relabelled
    // record fails either check.
    const record = await encryptDelta(
      key,
      { peer: "7", start: 0, end: 3 },
      encoder.encode("ops"),
      { iv, salt },
    );
    const header = parseEloRecordHeader(record).headerBytes;
    const ct = await gcm(key, salt, iv, "typstry:v2:record", "ops", [
      RECORD_VERSION + 1,
      ...header,
    ]);
    const signBody = async (body: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          key.sign!,
          new Uint8Array([
            ...encoder.encode("typstry:v2:record-signature"),
            ...header,
            ...body,
          ]),
        ),
      );
    const newerBody = new Uint8Array([RECORD_VERSION + 1, ...salt, ...ct]);
    const signature = await signBody(newerBody);
    const body = newerBody.slice();
    body[0] = RECORD_VERSION;
    const recordOf = (signature: Uint8Array) => {
      const w = new BytesWriter();
      w.pushBytes(header);
      w.pushVarBytes(new Uint8Array([...body, ...signature]));
      return w.finalize();
    };
    await expect(
      decryptRecord(key, recordOf(signature)),
    ).rejects.toBeInstanceOf(BadSignatureError);
    const resigned = recordOf(await signBody(body));
    await expect(decryptRecord(key, resigned)).rejects.toThrow();
    await expect(decryptRecord(key, resigned)).rejects.not.toBeInstanceOf(
      BadSignatureError,
    );
  });
});

/** AES-GCM under the per-message key, the way project-key.ts derives it. */
async function gcm(
  key: ProjectKey,
  salt: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  context: string,
  plaintext: string,
  aad: number[],
): Promise<Uint8Array> {
  const messageKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(context) },
    key.read,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new Uint8Array(aad) },
      messageKey,
      encoder.encode(plaintext),
    ),
  );
}
