// Hand-built frames of the delivery service protocol (crates/typstry-wire/
// src/ds.rs), so tests can play the server without a codec for its side: the
// wasm only decodes what the server sends.
import type { RefusalCode } from "./ds-client";

function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

function varBytes(bytes: Uint8Array): number[] {
  return [...uleb(bytes.length), ...bytes];
}

const PERMISSION = { write: 1, read: 2, retired: 3 } as const;
const REFUSAL: Record<RefusalCode, number> = {
  malformed: 1,
  forbidden: 2,
  noGroup: 3,
  groupExists: 4,
  wrongIncarnation: 5,
  badCommit: 6,
  retired: 7,
  internal: 8,
  rateLimited: 9,
};

export const frames = {
  ready(
    incarnation: number,
    head: number,
    permission: keyof typeof PERMISSION = "write",
    retired?: number,
  ): ArrayBuffer {
    return buffer([
      0x81,
      1,
      ...uleb(incarnation),
      ...uleb(head),
      PERMISSION[permission],
      ...(retired === undefined ? [0] : [1, ...uleb(retired)]),
    ]);
  },
  commit(epoch: number, commit: Uint8Array): ArrayBuffer {
    return buffer([0x82, ...uleb(epoch), ...varBytes(commit), 0]);
  },
  accepted(req: number): ArrayBuffer {
    return buffer([0x84, ...uleb(req)]);
  },
  conflict(req: number, head: number): ArrayBuffer {
    return buffer([0x85, ...uleb(req), ...uleb(head)]);
  },
  refused(req: number, code: RefusalCode): ArrayBuffer {
    return buffer([0x86, ...uleb(req), REFUSAL[code]]);
  },
  reinitialized(incarnation: number): ArrayBuffer {
    return buffer([0x87, ...uleb(incarnation)]);
  },
};

function buffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
