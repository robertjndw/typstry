// @vitest-environment node
// Cross-language checks against crates/typstry-doc/tests/directory.rs.
// directory.js.loro and directory.list.json are written here (regenerate
// with `pnpm --filter web fixtures`) and read by Rust; directory.rust.loro
// and directory.rust.list.json go the other way. Each side compares the
// other's snapshot against the list the writer computed, so both must
// resolve best links, states and ordering the same way.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

import { toBase64Url, toHex } from "@/crypto/bytes";
import { ownerPublicKeyOf } from "@/crypto/wasm";

import { Directory } from "./directory";
import { ROOT } from "./schema";
import { newDirectory, NOW } from "./test-utils";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../crates/typstry-doc/tests/fixtures",
);
const JS_DOC = path.join(FIXTURES, "directory.js.loro");
const JS_LIST = path.join(FIXTURES, "directory.list.json");
// Written by crates/typstry-doc/tests/directory.rs.
const RUST_DOC = path.join(FIXTURES, "directory.rust.loro");
const RUST_LIST = path.join(FIXTURES, "directory.rust.list.json");

const WRITE = process.env.TYPSTRY_WRITE_FIXTURES === "1";

// Real secrets from the Rust side: a view secret carries a public key that
// has to be a valid point, which only the wasm and Rust can check. Edit
// secrets are [1, 0x11 * 32], [1, 0x22 * 32], [1, 0x33 * 32].
const EDIT = [
  "ARERERERERERERERERERERERERERERERERERERERERER",
  "ASIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
  "ATMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz",
] as const;
const VIEW = [
  "ArweKu_m30uCUI2Y_lwoF4rNfORgGU1fe7M7XCsQgPwP5lJ1MZx5pKr1m35dT3p6T-7wo_Uf2-fPM-fRODWN_EY",
  "AvOExVOACB8Pg000FeTJ10-YnzW9Qz27jmuueWAf37C1wjSik9koN1RO6UdLQKmcPcGfn7ZlRD--97RfFIgkLwk",
  "AlA8HjoPIttxhYY9QeLBiVeJYkvpDvDBwtgitKLHW8Kg58eHdl1GTiHnQr_jYbuq3SG-sByxJ4Hn7TykBteI964",
] as const;

const tok = (n: number) => `JS${String(n).padStart(20, "0")}`;

function buildScenario(): Directory {
  const dir = newDirectory(10n);
  const add = (
    n: number,
    projectId: string,
    secret: string,
    edit: boolean,
    addedAt: number,
    generation?: number,
  ) =>
    dir.addLink({
      token: tok(n),
      projectId,
      secret,
      edit,
      addedAt,
      generation,
    });

  // Retired older link, newer edit link wins.
  add(1, "alpha", EDIT[0], true, 100, 1);
  add(2, "alpha", EDIT[1], true, 200, 2);
  dir.retire(tok(1), 300);
  dir.setTitle("alpha", " Alpha paper ");
  dir.touchOpened("alpha", 5000);

  // Edit beats a newer view link; a gone mark from the view link is
  // superseded.
  add(3, "beta", VIEW[0], false, 120);
  add(4, "beta", EDIT[2], true, 110);
  dir.setStatus("beta", "gone", 400, tok(3));

  add(5, "gamma", VIEW[1], false, 130);
  dir.setStatus("gamma", "forgotten", 410);
  dir.touchOpened("gamma", 9000);

  // Every link retired: the newest is the fallback, and removed applies.
  add(6, "delta", EDIT[0], true, 50, 3);
  add(7, "delta", EDIT[1], true, 60, 1);
  dir.retire(tok(6), 420);
  dir.retire(tok(7), 421);
  dir.setStatus("delta", "removed", 430, tok(7));

  // Without a generation, so the other side can fill it in.
  add(8, "epsilon", VIEW[2], false, 140);

  // A malformed entry and an unknown key and root map.
  dir.doc.getMap(ROOT.links).set(tok(9), {
    projectId: "junk",
    secret: "not a secret",
    edit: true,
    addedAt: 150,
  });
  const links = dir.doc.getMap(ROOT.links);
  links.set(tok(8), { ...(links.get(tok(8)) as object), note: "kept" });
  dir.doc.getMap("future").set("k", "v");

  // Two owner keys of one project and one of another, and a junk one: a
  // secret that does not derive the key it is filed under. Must match
  // directory.rs apart from the fills.
  dir.addOwnerKey("alpha", owner(JS_OWNER_FILLS[0]), 100);
  dir.addOwnerKey("alpha", owner(JS_OWNER_FILLS[1]), 200);
  dir.addOwnerKey("beta", owner(JS_OWNER_FILLS[2]), 300);
  dir.doc
    .getMap(ROOT.ownerKeys)
    .set(`alpha/${toHex(ownerPublicKeyOf(owner(JS_OWNER_FILLS[2])))}`, {
      secret: toBase64Url(owner(JS_OWNER_FILLS[0])),
      addedAt: 400,
    });
  dir.doc.commit();
  return dir;
}

// The owner secrets each side writes; the other reads them back.
const RUST_OWNER_FILLS = [0x77, 0x88, 0x99] as const;
const JS_OWNER_FILLS = [0x44, 0x55, 0x66] as const;

const owner = (fill: number) => new Uint8Array(32).fill(fill);

/** `ownerKeys` as `[hex, fill]` pairs. */
function ownerFills(dir: Directory, project: string): [string, number][] {
  return dir.ownerKeys(project, NOW).map((k) => [k.publicKey, k.secret[0]!]);
}

const fillsOf = (fills: readonly number[]): [string, number][] =>
  fills.map((f) => [toHex(ownerPublicKeyOf(owner(f))), f]);

describe("directory fixture written by TypeScript", () => {
  it.runIf(WRITE)("regenerates the fixture", () => {
    const dir = buildScenario();
    writeFileSync(JS_DOC, dir.doc.export({ mode: "snapshot" }));
    writeFileSync(JS_LIST, JSON.stringify(dir.list(NOW), null, 2) + "\n");
  });

  it("matches the committed snapshot", () => {
    const doc = new LoroDoc();
    doc.import(readFileSync(JS_DOC));
    const expected: unknown = JSON.parse(readFileSync(JS_LIST, "utf8"));
    expect(new Directory(doc).list(NOW)).toEqual(expected);
    expect(buildScenario().list(NOW)).toEqual(expected);
    expect(ownerFills(new Directory(doc), "alpha")).toEqual(
      ownerFills(buildScenario(), "alpha"),
    );
  });
});

describe("directory fixture written by Rust", () => {
  // Read per test: the file may not exist yet on the run that writes the JS
  // side, which Rust then bootstraps from.
  function load(): Directory {
    const doc = new LoroDoc();
    doc.import(readFileSync(RUST_DOC));
    return new Directory(doc);
  }

  it("lists what Rust listed", () => {
    const dir = load();
    const expected: unknown = JSON.parse(readFileSync(RUST_LIST, "utf8"));
    expect(dir.unsupported()).toBeNull();
    expect(dir.list(NOW)).toEqual(expected);
  });

  it("covers the cases the spec names", () => {
    const entries = new Map(
      load()
        .list(NOW)
        .map((e) => [e.projectId, e]),
    );
    expect(entries.has("junk")).toBe(false);
    expect(entries.get("alpha")?.link).toMatchObject({
      edit: true,
      retired: false,
    });
    expect(entries.get("beta")?.state).toBe("listed");
    expect(entries.get("gamma")?.state).toBe("forgotten");
    expect(entries.get("delta")).toMatchObject({
      state: "removed",
      link: { retired: true },
    });
  });

  it("reads the owner keys Rust wrote", () => {
    const [a, b, c] = RUST_OWNER_FILLS;
    const dir = load();
    // Newest first, and the junk entry filed under alpha is skipped.
    expect(ownerFills(dir, "alpha")).toEqual(fillsOf([b, a]));
    expect(ownerFills(dir, "beta")).toEqual(fillsOf([c]));
    expect(dir.ownerKeys("gamma", NOW)).toEqual([]);
  });

  it("keeps unknown keys and maps through a rewrite", () => {
    const own = load();
    const entry = own.list(NOW).find((e) => e.projectId === "epsilon")!;
    expect(
      own.addLink({
        token: entry.link.token,
        projectId: "epsilon",
        secret: entry.link.secret,
        edit: entry.link.edit,
        addedAt: 1,
        generation: 2,
      }),
    ).toBe(true);
    const stored = own.doc.getMap(ROOT.links).get(entry.link.token);
    expect(stored).toMatchObject({ note: "kept", generation: 2 });
    expect(own.doc.getMap("future").get("k")).toBe("v");
  });
});
