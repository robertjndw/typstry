// @vitest-environment node
// Reads the frozen fixtures in fixtures/compat/v<N>/ with the current web
// code. They are written once by crates/typstry-cli/tests/compat.rs and
// never regenerated; a format bump adds a new v<N>. See
// docs/compatibility.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EphemeralStore, LoroDoc, LoroText } from "loro-crdt";
import {
  EloRecordKind,
  type EloDeltaHeader,
  type EloSnapshotHeader,
} from "loro-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  BLOB_CONTEXT,
  decryptRecord,
  fromBase64Url,
  importProjectKey,
  open,
  PRESENCE_CONTEXT,
  RECORD_VERSION,
  SEAL_VERSION,
  secretKind,
} from "./crypto/project-key";
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
import { parsePresence } from "./presence/presence";
import { projectUrl } from "./project/recent";
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

function bytes(text: string): Uint8Array {
  const out = fromBase64Url(text);
  if (!out) throw new Error(`not base64url: ${text}`);
  return out;
}

interface CryptoFixture {
  editSecret: string;
  viewSecret: string;
  keyId: string;
  editLink: string;
  viewLink: string;
  delta: {
    peer: string;
    start: number;
    end: number;
    record: string;
    plaintext: string;
    title: string;
  };
  snapshot: { vv: [string, number][]; record: string; plaintextFile: string };
  blob: { sealed: string; plaintext: string };
  presence: {
    sealed: string;
    plaintext: string;
    key: string;
    state: { name: string; color: string; fileId: string };
  };
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

describe.each(compatDirs())("compat v%i", (_n, dir) => {
  const crypto = readJson<CryptoFixture>(dir, "crypto.json");
  const expected = readJson<DocFixture>(dir, "doc.json");
  const snapshot = readFileSync(path.join(dir, "doc.loro"));

  it("parses the secrets and share links", async () => {
    expect(secretKind(crypto.editSecret)).toBe("edit");
    expect(secretKind(crypto.viewSecret)).toBe("view");
    const editor = await importProjectKey(crypto.editSecret);
    expect(editor.keyId).toBe(crypto.keyId);
    expect(editor.editSecret).toBe(crypto.editSecret);
    expect(editor.viewSecret).toBe(crypto.viewSecret);
    const viewer = await importProjectKey(crypto.viewSecret);
    expect(viewer.keyId).toBe(crypto.keyId);
    expect(viewer.editSecret).toBeNull();

    for (const [link, secret] of [
      [crypto.editLink, crypto.editSecret],
      [crypto.viewLink, crypto.viewSecret],
    ] as const) {
      const url = new URL(link);
      expect(url.hash.slice(1)).toBe(secret);
      const token = decodeURIComponent(url.pathname.replace(/^\/p\//, ""));
      expect(projectUrl(token, secret, url.origin)).toBe(link);
    }
  });

  it("decrypts records, blob and presence with either secret", async () => {
    for (const secret of [crypto.editSecret, crypto.viewSecret]) {
      const key = await importProjectKey(secret);

      const delta = await decryptRecord(key, bytes(crypto.delta.record));
      expect(delta.kind).toBe(EloRecordKind.DeltaSpan);
      const header = delta.header as EloDeltaHeader;
      expect(new TextDecoder().decode(header.peerId)).toBe(crypto.delta.peer);
      expect([header.start, header.end]).toEqual([
        crypto.delta.start,
        crypto.delta.end,
      ]);
      expect(delta.plaintext).toEqual(bytes(crypto.delta.plaintext));
      const fromDelta = new ProjectDoc(new LoroDoc());
      fromDelta.doc.import(delta.plaintext);
      expect(fromDelta.title).toBe(crypto.delta.title);

      const record = await decryptRecord(key, bytes(crypto.snapshot.record));
      expect(record.kind).toBe(EloRecordKind.Snapshot);
      const vv = (record.header as EloSnapshotHeader).vv.map(
        ({ peerId, counter }) => [new TextDecoder().decode(peerId), counter],
      );
      expect(vv).toEqual(
        [...crypto.snapshot.vv].sort(([x], [y]) =>
          x < y ? -1 : x > y ? 1 : 0,
        ),
      );
      expect(record.plaintext).toEqual(
        new Uint8Array(
          readFileSync(path.join(dir, crypto.snapshot.plaintextFile)),
        ),
      );

      expect(await open(key, bytes(crypto.blob.sealed), BLOB_CONTEXT)).toEqual(
        bytes(crypto.blob.plaintext),
      );

      const presence = await open(
        key,
        bytes(crypto.presence.sealed),
        PRESENCE_CONTEXT,
      );
      expect(presence).toEqual(bytes(crypto.presence.plaintext));
      // The update carries the time it was made, which a store with the
      // usual timeout would treat as long expired. A store that keeps it
      // also schedules its expiry sweep at half that timeout, which no
      // timer can hold, and nothing here needs the sweep anyway.
      const sweep = vi
        .spyOn(globalThis, "setInterval")
        .mockReturnValue(undefined as never);
      const store = new EphemeralStore(Number.MAX_SAFE_INTEGER);
      try {
        store.apply(presence);
        const states = store.getAllStates() as Record<string, unknown>;
        expect(parsePresence(states[crypto.presence.key])).toEqual(
          crypto.presence.state,
        );
      } finally {
        store.destroy();
        sweep.mockRestore();
      }
    }
  });

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

// Without this, a format bump with no new fixture would pass on the old
// ones while nothing reads the new format.
it("has a compat fixture for every current format", () => {
  const [n, newest] = compatDirs().at(-1)!;
  const frozen = readJson<Record<string, number>>(newest, "versions.json");
  for (const [name, current] of [
    ["schema", SCHEMA_VERSION],
    ["seal", SEAL_VERSION],
    ["record", RECORD_VERSION],
    ["protocol", PROTOCOL_VERSION],
  ] as const) {
    expect(
      current,
      `the ${name} version is ${current} but fixtures/compat/v${n} froze ${frozen[name]}; add fixtures/compat/v${n + 1} with \`TYPSTRY_WRITE_COMPAT=${n + 1} cargo test -p typstry-cli --test compat\` (see docs/compatibility.md)`,
    ).toBeLessThanOrEqual(frozen[name]!);
  }
});
