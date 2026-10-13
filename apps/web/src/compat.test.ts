// @vitest-environment node
// Reads the frozen fixtures in fixtures/compat/v<N>/ with the current web
// code. They are written once by crates/typstry-cli/tests/compat.rs and
// never regenerated; a format bump adds a new v<N>. See
// docs/compatibility.md. The crypto runs through the wasm build, which
// test-setup.ts initializes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { LoroDoc, LoroText } from "loro-crdt";
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "./crypto/bytes";
import { SpaceCrypto } from "./crypto/space-crypto";
import {
  DocKeys,
  dsVersion,
  Keyring,
  LinkSecret,
  SpaceGroup,
  recordVersion,
  sealVersion,
} from "./crypto/wasm";
import { Directory } from "./directory/directory";
import { DIRECTORY_SCHEMA_VERSION, ROOT } from "./directory/schema";
import { buildPathIndex } from "./doc/paths";
import { versionAt } from "./doc/restore";
import {
  isSchemaTooNew,
  migrate,
  NODE,
  ProjectDoc,
  SCHEMA_VERSION,
} from "./doc/schema";
import { listVersions } from "./doc/versions";
import { PROTOCOL_VERSION } from "./sync/protocol";

const COMPAT = path.resolve(import.meta.dirname, "../../../fixtures/compat");

function compatDirs(): [number, string][] {
  if (!existsSync(COMPAT)) throw new Error(`${COMPAT} is missing`);
  const dirs = readdirSync(COMPAT)
    .map((name) => [Number(/^v(\d+)$/.exec(name)?.[1]), name] as const)
    .filter(
      ([n, name]) =>
        Number.isInteger(n) && statSync(path.join(COMPAT, name)).isDirectory(),
    )
    .map(([n, name]): [number, string] => [n, path.join(COMPAT, name)])
    .sort(([a], [b]) => a - b);
  if (dirs.length === 0) throw new Error("no compat/v<N> fixtures found");
  return dirs;
}

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
}

type FileFixture =
  | { path: string; kind: "text"; text: string }
  | { path: string; kind: "asset"; hash: string; size: number; mime: string };

interface DocFixture {
  schema: number;
  title: string;
  mainFile: string;
  peers: Record<string, { name: string; color: string }>;
  dirs: string[];
  files: FileFixture[];
  versions: {
    index: number;
    id: string;
    name: string;
    createdAt: number;
    author: string;
    files: FileFixture[];
  }[];
  deletedVersions: {
    index: number;
    id: string;
    name: string;
    deletedAt: number;
  }[];
}

/** Every file of `project` the way doc.json lists them, sorted by path. */
function filesOf(project: ProjectDoc): FileFixture[] {
  const out: FileFixture[] = [];
  for (const [id, entry] of buildPathIndex(project).byId) {
    const data = project.fs.getNodeByID(id)!.data;
    if (entry.kind === "text") {
      const content: unknown = data.get(NODE.content);
      if (!(content instanceof LoroText)) throw new Error(entry.path);
      out.push({ path: entry.path, kind: "text", text: content.toString() });
    } else if (entry.kind === "asset") {
      out.push({
        path: entry.path,
        kind: "asset",
        hash: data.get(NODE.hash) as string,
        size: data.get(NODE.size) as number,
        mime: data.get(NODE.mime) as string,
      });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const bytes = (value: string) => fromBase64Url(value)!;

interface CryptoFixture {
  editSecret: string;
  viewSecret: string;
  fingerprint: string;
  keyring: { signed: string; keyId: string; generation: number };
  signer: { publicKey: string };
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
    plaintextFile: string;
  };
  blob: { sealed: string; plaintext: string };
}

interface CliFixture {
  mls: { epoch: number };
}

describe.each(compatDirs())("compat v%i", (_n, dir) => {
  const expected = readJson<DocFixture>(dir, "doc.json");
  const snapshot = readFileSync(path.join(dir, "doc.loro"));

  it("reads the project doc", () => {
    const doc = new LoroDoc();
    doc.import(snapshot);
    const project = new ProjectDoc(doc);
    expect(project.schemaVersion).toBe(expected.schema);
    expect(isSchemaTooNew(project.schemaVersion)).toBe(false);
    expect(project.title).toBe(expected.title);

    const index = buildPathIndex(project);
    expect(index.byId.get(project.mainFile!)?.path).toBe(expected.mainFile);
    const dirs = [...index.byId.values()]
      .filter((e) => e.kind === "dir")
      .map((e) => e.path)
      .sort();
    expect(dirs).toEqual(expected.dirs);
    expect(filesOf(project)).toEqual(expected.files);
    for (const [peer, info] of Object.entries(expected.peers)) {
      expect(project.getPeer(peer)).toEqual(info);
    }

    const versions = listVersions(project);
    expect(
      versions.map(({ index, id, name, createdAt, author }) => ({
        index,
        id,
        name,
        createdAt,
        author,
      })),
    ).toEqual(
      expected.versions.map(({ index, id, name, createdAt, author }) => ({
        index,
        id,
        name,
        createdAt,
        author,
      })),
    );
    versions.forEach((version, i) => {
      expect(filesOf(versionAt(project, version.frontiers))).toEqual(
        expected.versions[i]!.files,
      );
    });

    for (const gone of expected.deletedVersions) {
      expect(versions.some((v) => v.index === gone.index)).toBe(false);
      expect(project.deletedVersions.get(gone.id)).toBe(gone.deletedAt);
      const entry = project.versions.get(gone.index) as { name?: unknown };
      expect(entry.name).toBe(gone.name);
    }

    // Migrating leaves a current doc alone and loses nothing on an older one.
    const fork = new ProjectDoc(doc.fork());
    expect(migrate(fork)).toBe(expected.schema < SCHEMA_VERSION);
    expect(fork.schemaVersion).toBe(SCHEMA_VERSION);
    expect(filesOf(fork)).toEqual(expected.files);
    expect(listVersions(fork)).toEqual(versions);
  });
});

describe.each(compatDirs())("compat crypto v%i", (_n, dir) => {
  const fixture = readJson<CryptoFixture>(dir, "crypto.json");

  it("reads links, the keyring, records and blobs", () => {
    const edit = LinkSecret.parse(fixture.editSecret);
    expect(edit.canAttest()).toBe(true);
    expect(edit.viewSecret()).toBe(fixture.viewSecret);
    expect(edit.fingerprint()).toBe(fixture.fingerprint);
    const view = LinkSecret.parse(fixture.viewSecret);
    expect(view.canAttest()).toBe(false);
    expect(view.fingerprint()).toBe(fixture.fingerprint);

    const signed = bytes(fixture.keyring.signed);
    for (const secret of [fixture.editSecret, fixture.viewSecret]) {
      const crypto = SpaceCrypto.open(secret, signed);
      expect(crypto.generation).toBe(fixture.keyring.generation);
      expect(
        new DocKeys(Keyring.openVerified(LinkSecret.parse(secret), signed))
          .keyId,
      ).toBe(fixture.keyring.keyId);

      const delta = crypto.decryptRecord(bytes(fixture.delta.record));
      expect(delta).toMatchObject({
        kind: "delta",
        peer: fixture.delta.peer,
        start: fixture.delta.start,
        end: fixture.delta.end,
      });
      expect(delta.plaintext).toEqual(bytes(fixture.delta.plaintext));
      expect(delta.signer).toEqual(bytes(fixture.signer.publicKey));

      const snapshot = crypto.decryptRecord(bytes(fixture.snapshot.record));
      expect(snapshot.kind).toBe("snapshot");
      if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
      expect(
        snapshot.vv.map(({ peer, counter }) => [peer, counter]).sort(),
      ).toEqual([...fixture.snapshot.vv].sort());
      expect(snapshot.plaintext).toEqual(
        new Uint8Array(
          readFileSync(path.join(dir, fixture.snapshot.plaintextFile)),
        ),
      );

      expect(crypto.openBlob(bytes(fixture.blob.sealed))).toEqual(
        bytes(fixture.blob.plaintext),
      );
    }
  });

  it("loads the CLI's saved group state", () => {
    const cli = readJson<CliFixture>(dir, "cli.json");
    const group = SpaceGroup.importState(
      new Uint8Array(readFileSync(path.join(dir, "cli", "mls.bin"))),
    );
    expect(group.epoch).toBe(cli.mls.epoch);
    expect(group.isActive).toBe(true);
    expect(group.link().toBase64url()).toBe(fixture.editSecret);
  });
});

// What compat.rs in typstry-doc wrote directory.json from: the list, the
// owner keys and the project of every token, read at the same time.
const DIRECTORY_NOW = 1_000_000;

describe.each(compatDirs())("compat directory v%i", (_n, dir) => {
  it("reads the directory", () => {
    const expected = readJson<Record<string, unknown>>(dir, "directory.json");
    const doc = new LoroDoc();
    doc.import(readFileSync(path.join(dir, "directory.loro")));
    const directory = new Directory(doc);
    expect(directory.unsupported()).toBeNull();
    const list = directory.list(DIRECTORY_NOW);
    const tokens = Object.keys(doc.getMap(ROOT.links).toJSON()).sort();
    expect({
      schema: directory.schemaVersion,
      list,
      ownerKeys: Object.fromEntries(
        list.map((e) => [
          e.projectId,
          directory
            .ownerKeys(e.projectId, DIRECTORY_NOW)
            .map((k) => [k.publicKey, toBase64Url(k.secret)]),
        ]),
      ),
      projectOfToken: Object.fromEntries(
        tokens.map((t) => [t, directory.projectOfToken(t, DIRECTORY_NOW)]),
      ),
    }).toEqual(expected);
  });
});

// Without this, a format bump with no new fixture would pass on the old
// ones while nothing reads the new format.
it("has a compat fixture for every current format", () => {
  const [n, newest] = compatDirs().at(-1)!;
  const frozen = readJson<Record<string, number>>(newest, "versions.json");
  for (const [name, current] of [
    ["schema", SCHEMA_VERSION],
    ["directory", DIRECTORY_SCHEMA_VERSION],
    ["seal", sealVersion()],
    ["record", recordVersion()],
    ["ds", dsVersion()],
    ["protocol", PROTOCOL_VERSION],
  ] as const) {
    expect(
      current,
      `the ${name} version is ${current} but fixtures/compat/v${n} froze ${frozen[name]}; add fixtures/compat/v${n + 1} with \`TYPSTRY_WRITE_COMPAT=${n + 1} cargo test -p typstry-cli --test compat\` (see docs/compatibility.md)`,
    ).toBeLessThanOrEqual(frozen[name]!);
  }
});
