// @vitest-environment node
// Cross-language check of the encryption. js-records.json is written here
// and decrypted by crates/typstry-wire/tests/fixture.rs; rust-records.json
// comes from that test and is decrypted here. Regenerate with
// `pnpm --filter web fixtures` and
// `TYPSTRY_WRITE_FIXTURES=1 cargo test -p typstry-wire --test fixture`.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LoroDoc } from "loro-crdt";
import {
  EloRecordKind,
  type EloDeltaHeader,
  type EloSnapshotHeader,
} from "loro-protocol";
import { describe, expect, it } from "vitest";

import {
  BLOB_CONTEXT,
  decryptRecord,
  encryptDelta,
  encryptSnapshot,
  fromBase64Url,
  importProjectKey,
  open,
  seal,
  SECRET_EDIT_V1,
  toBase64Url,
} from "./project-key";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../crates/typstry-wire/tests/fixtures",
);
const JS_RECORDS = path.join(FIXTURES, "js-records.json");
const RUST_RECORDS = path.join(FIXTURES, "rust-records.json");

// The edit kind byte, then key bytes 0..32, shared with the Rust side.
const RAW_KEY = toBase64Url(
  Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? SECRET_EDIT_V1 : i - 1)),
);

// Peers 9 and 10 sort differently as text and as numbers, so the snapshot
// header only parses if both sides order its version vector by bytes.
const PEER_A = "10";
const PEER_B = "9";

interface Fixture {
  key: string;
  viewKey: string;
  keyId: string;
  delta: {
    peer: string;
    start: number;
    end: number;
    record: string;
    plaintext: string;
  };
  snapshot: {
    vv: [string, number][];
    record: string;
    plaintext: string;
  };
  blob: { sealed: string; plaintext: string };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  const out = fromBase64Url(text);
  if (!out) throw new Error(`not base64url: ${text}`);
  return out;
}

function readFixture(file: string): Fixture {
  return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}

function buildDoc() {
  const a = new LoroDoc();
  a.setPeerId(PEER_A);
  a.getText("text").insert(0, "hello");
  a.commit();
  const b = new LoroDoc();
  b.setPeerId(PEER_B);
  b.import(a.export({ mode: "snapshot" }));
  b.getText("text").insert(5, " world");
  b.commit();
  return { a, b };
}

async function writeJsFixture() {
  const key = await importProjectKey(RAW_KEY);
  const { a, b } = buildDoc();
  const end = a.oplogVersion().get(PEER_A) ?? 0;
  const deltaPlain = a.export({
    mode: "updates-in-range",
    spans: [{ id: { peer: PEER_A, counter: 0 }, len: end }],
  });
  const delta = await encryptDelta(
    key,
    { peer: PEER_A, start: 0, end },
    deltaPlain,
    { iv: new Uint8Array(12).fill(1), salt: new Uint8Array(16).fill(3) },
  );
  const vv = [...b.oplogVersion().toJSON()];
  const snapshotPlain = b.export({ mode: "snapshot" });
  const snapshot = await encryptSnapshot(
    key,
    vv.map(([peer, counter]) => ({ peerId: encoder.encode(peer), counter })),
    snapshotPlain,
    { iv: new Uint8Array(12).fill(2), salt: new Uint8Array(16).fill(4) },
  );
  const blobPlain = encoder.encode("#set page(width: 10cm)\n");
  const fixture: Fixture = {
    key: RAW_KEY,
    viewKey: key.viewSecret,
    keyId: key.keyId,
    delta: {
      peer: PEER_A,
      start: 0,
      end,
      record: toBase64Url(delta),
      plaintext: toBase64Url(deltaPlain),
    },
    snapshot: {
      vv,
      record: toBase64Url(snapshot),
      plaintext: toBase64Url(snapshotPlain),
    },
    blob: {
      sealed: toBase64Url(await seal(key, blobPlain, BLOB_CONTEXT)),
      plaintext: toBase64Url(blobPlain),
    },
  };
  writeFileSync(JS_RECORDS, JSON.stringify(fixture, null, 2) + "\n");
}

/** Decrypts every part of a fixture and checks it against its own claims. */
async function checkFixture(fixture: Fixture) {
  expect(fixture.key).toBe(RAW_KEY);
  const editor = await importProjectKey(fixture.key);
  expect(editor.keyId).toBe(fixture.keyId);
  expect(editor.viewSecret).toBe(fixture.viewKey);
  // Everything below must work with the view secret alone.
  const key = await importProjectKey(fixture.viewKey);
  expect(key.keyId).toBe(fixture.keyId);

  const delta = await decryptRecord(key, bytes(fixture.delta.record));
  expect(delta.kind).toBe(EloRecordKind.DeltaSpan);
  const deltaHeader = delta.header as EloDeltaHeader;
  expect(decoder.decode(deltaHeader.peerId)).toBe(fixture.delta.peer);
  expect([deltaHeader.start, deltaHeader.end]).toEqual([
    fixture.delta.start,
    fixture.delta.end,
  ]);
  expect(delta.plaintext).toEqual(bytes(fixture.delta.plaintext));

  const snapshot = await decryptRecord(key, bytes(fixture.snapshot.record));
  expect(snapshot.kind).toBe(EloRecordKind.Snapshot);
  const vv = (snapshot.header as EloSnapshotHeader).vv.map(
    ({ peerId, counter }) => [decoder.decode(peerId), counter],
  );
  expect(vv).toEqual(
    [...fixture.snapshot.vv].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  );
  expect(snapshot.plaintext).toEqual(bytes(fixture.snapshot.plaintext));

  expect(await open(key, bytes(fixture.blob.sealed), BLOB_CONTEXT)).toEqual(
    bytes(fixture.blob.plaintext),
  );
  return { delta: delta.plaintext, snapshot: snapshot.plaintext };
}

describe("encryption fixtures", () => {
  it.runIf(process.env.TYPSTRY_WRITE_FIXTURES === "1")(
    "regenerates the JS fixture",
    writeJsFixture,
  );

  it("decrypts the committed JS fixture into the expected doc", async () => {
    const plain = await checkFixture(readFixture(JS_RECORDS));
    const fromDelta = new LoroDoc();
    fromDelta.import(plain.delta);
    expect(fromDelta.getText("text").toString()).toBe("hello");
    const fromSnapshot = new LoroDoc();
    fromSnapshot.import(plain.snapshot);
    expect(fromSnapshot.getText("text").toString()).toBe("hello world");
  });

  it("decrypts what the Rust side encrypted", async () => {
    const plain = await checkFixture(readFixture(RUST_RECORDS));
    expect(decoder.decode(plain.delta)).toBe("delta from rust");
    expect(decoder.decode(plain.snapshot)).toBe("snapshot from rust");
  });
});
