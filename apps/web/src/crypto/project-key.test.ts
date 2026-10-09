// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  fromBase64Url,
  generateRawProjectKey,
  importProjectKey,
  isRawProjectKey,
  open,
  seal,
  SEAL_OVERHEAD,
  toBase64Url,
} from "./project-key";

describe("project keys", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
    expect(fromBase64Url("not base64!")).toBeNull();
  });

  it("generates 256-bit keys in URL-safe form", async () => {
    const raw = generateRawProjectKey();
    expect(raw).toHaveLength(43);
    expect(isRawProjectKey(raw)).toBe(true);
    expect(isRawProjectKey(raw.slice(1))).toBe(false);
    const key = await importProjectKey(raw);
    expect(key.raw).toBe(raw);
    // Same key, same fingerprint; another key, another one.
    expect((await importProjectKey(raw)).keyId).toBe(key.keyId);
    expect((await importProjectKey(generateRawProjectKey())).keyId).not.toBe(
      key.keyId,
    );
  });

  it("rejects malformed keys", async () => {
    await expect(importProjectKey("short")).rejects.toThrow(/malformed/);
  });

  it("seals and opens, bound to key and context", async () => {
    const key = await importProjectKey(generateRawProjectKey());
    const other = await importProjectKey(generateRawProjectKey());
    const plaintext = new TextEncoder().encode("= Hello");
    const sealed = await seal(key, plaintext, "ctx:a");
    expect(sealed.length).toBe(plaintext.length + SEAL_OVERHEAD);
    expect(await open(key, sealed, "ctx:a")).toEqual(plaintext);
    await expect(open(key, sealed, "ctx:b")).rejects.toThrow();
    await expect(open(other, sealed, "ctx:a")).rejects.toThrow();
    // Fresh IV every time.
    expect(await seal(key, plaintext, "ctx:a")).not.toEqual(sealed);
  });
});
