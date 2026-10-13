// @vitest-environment node
import { describe, expect, it } from "vitest";

import { toBase64Url } from "@/crypto/bytes";
import * as wasm from "@/crypto/wasm";

import { linkSecretKind } from "./link-secret";

function view(key: number[]): string {
  return toBase64Url(new Uint8Array([2, ...new Array(32).fill(7), ...key]));
}

describe("linkSecretKind", () => {
  it("accepts the view secrets Rust parses and no others", () => {
    const keys: number[][] = [
      // y = 1: x = 0, with either sign bit.
      [1, ...new Array(31).fill(0)],
      [1, ...new Array(30).fill(0), 0x80],
      // y = p and y = p + 1, encoded without reducing.
      [0xed, ...new Array(30).fill(0xff), 0x7f],
      [0xee, ...new Array(30).fill(0xff), 0x7f],
      new Array(32).fill(0xff),
      new Array(32).fill(0),
    ];
    // Deterministic, so a failure reproduces.
    let seed = 1;
    for (let i = 0; i < 200; i++)
      keys.push(
        Array.from({ length: 32 }, () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed >> 16;
        }),
      );
    const kinds = new Set<string | null>();
    for (const key of keys) {
      const raw = view(key);
      const kind = linkSecretKind(raw);
      kinds.add(kind);
      expect(kind, raw).toBe(wasm.secretKind(raw) ?? null);
    }
    expect(kinds).toEqual(new Set(["view", null]));
  });

  it("leaves other kinds to secretKind", () => {
    const edit = wasm.LinkSecret.generateEdit();
    expect(linkSecretKind(edit.toBase64url())).toBe("edit");
    expect(linkSecretKind(edit.viewSecret())).toBe("view");
    expect(linkSecretKind("junk")).toBeNull();
  });
});
