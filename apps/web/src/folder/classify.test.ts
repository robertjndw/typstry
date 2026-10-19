// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MAX_TEXT_BYTES } from "@/assets/upload";

import { asText, digest, mimeForPath } from "./classify";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("asText", () => {
  it("keeps line endings and a BOM", () => {
    expect(asText(bytes("= Hi\r\n"))).toBe("= Hi\r\n");
    expect(asText(bytes("﻿a"))).toBe("﻿a");
  });

  it("rejects invalid UTF-8, NUL bytes and big files", () => {
    expect(asText(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(asText(bytes("a\0b"))).toBeNull();
    expect(asText(new Uint8Array(MAX_TEXT_BYTES).fill(97))).not.toBeNull();
    expect(asText(new Uint8Array(MAX_TEXT_BYTES + 1).fill(97))).toBeNull();
  });
});

describe("mimeForPath", () => {
  it("goes by extension", () => {
    expect(mimeForPath("fig/Logo.PNG")).toBe("image/png");
    expect(mimeForPath(".png")).toBe("application/octet-stream");
    expect(mimeForPath("README")).toBe("application/octet-stream");
  });
});

describe("digest", () => {
  it("is the blob hash", async () => {
    expect(await digest(bytes("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
