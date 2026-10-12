// @vitest-environment node
import { describe, expect, it } from "vitest";

import { toBase64Url, toHex } from "@/crypto/bytes";
import { ownerPublicKeyOf } from "@/crypto/wasm";

import { initProject, ProjectDoc } from "@/doc/schema";

import { Directory } from "./directory";
import {
  DIRECTORY_SCHEMA_VERSION,
  FUTURE_SLACK_MS,
  OPENED_REFRESH_MS,
  OWNER_KEYS_KEEP,
  RETIRED_KEEP_MS,
  ROOT,
} from "./schema";
import {
  editSecret,
  link,
  newDirectory,
  NOW,
  sync,
  token,
  viewSecret,
} from "./test-utils";

const P1 = "project-one";
const P2 = "project-two";

const best = (dir: Directory, project: string) =>
  dir.bestLink(project, NOW)?.token;

function unchanged(dir: Directory, write: () => void): void {
  const before = dir.doc.oplogVersion();
  write();
  expect(dir.doc.oplogVersion().compare(before)).toBe(0);
}

describe("init", () => {
  it("marks the doc and is idempotent", () => {
    const dir = newDirectory(1, false);
    expect(dir.unsupported()).toBeNull();
    dir.init();
    expect(dir.kind).toBe("directory");
    expect(dir.schemaVersion).toBe(DIRECTORY_SCHEMA_VERSION);
    unchanged(dir, () => dir.init());
  });

  it("merges when two devices initialize at once", () => {
    const a = newDirectory(1);
    const b = newDirectory(2);
    sync(a, b);
    expect(a.kind).toBe("directory");
    expect(b.schemaVersion).toBe(DIRECTORY_SCHEMA_VERSION);
  });

  it("refuses a project and a newer layout", () => {
    const project = new ProjectDoc(newDirectory(1, false).doc);
    initProject(project, { title: "T" });
    expect(new Directory(project.doc).unsupported()).toEqual({
      reason: "not-directory",
      found: "project",
    });

    const dir = newDirectory(2);
    dir.doc.getMap(ROOT.meta).set("schema", DIRECTORY_SCHEMA_VERSION + 1);
    expect(dir.unsupported()).toMatchObject({ reason: "too-new" });
  });
});

describe("links", () => {
  it("lists a project with a valid link", () => {
    const dir = newDirectory(1);
    expect(dir.addLink(link(1, P1))).toBe(true);
    expect(dir.list(NOW)).toEqual([
      {
        projectId: P1,
        title: null,
        link: {
          token: token(1),
          secret: editSecret(1),
          edit: true,
          retired: false,
        },
        state: "listed",
        openedAt: null,
        addedAt: 100,
      },
    ]);
    expect(dir.projectOfToken(token(1), NOW)).toBe(P1);
    expect(dir.projectOfToken(token(2), NOW)).toBeNull();
  });

  it("rejects invalid links", () => {
    const dir = newDirectory(1);
    for (const bad of [
      link(1, P1, { token: "short" }),
      link(1, P1, { projectId: "" }),
      link(1, P1, { secret: "not a secret" }),
      link(1, P1, { secret: viewSecret(), edit: true }),
    ])
      expect(() => dir.addLink(bad)).toThrow("not a valid link");
    expect(dir.list(NOW)).toEqual([]);
  });

  it("records an edit secret as view only when asked", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { edit: false }));
    expect(dir.list(NOW)[0]!.link.edit).toBe(false);
  });

  it("prefers edit, then newest, then token", () => {
    const dir = newDirectory(1);
    dir.addLink(
      link(1, P1, { secret: viewSecret(), edit: false, addedAt: 500 }),
    );
    dir.addLink(link(2, P1));
    expect(best(dir, P1)).toBe(token(2));
    dir.addLink(link(3, P1, { addedAt: 50, generation: 1 }));
    expect(best(dir, P1)).toBe(token(2));
    dir.addLink(link(4, P1, { addedAt: 200, generation: 1 }));
    expect(best(dir, P1)).toBe(token(4));
    dir.addLink(link(5, P1, { addedAt: 200, generation: 1 }));
    expect(best(dir, P1)).toBe(token(4));

    dir.addLink(link(6, P2, { secret: viewSecret(), edit: false }));
    expect(best(dir, P2)).toBe(token(6));
    expect(dir.bestLink("nope", NOW)).toBeNull();
  });

  it("stores a generation but never ranks on it", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { addedAt: 100, generation: 999 }));
    dir.addLink(link(2, P1, { addedAt: 200, generation: 1 }));
    expect(best(dir, P1)).toBe(token(2));
    dir.retire(token(1), 1);
    dir.retire(token(2), 1);
    expect(best(dir, P1)).toBe(token(2));
  });

  it("ignores entries dated in the future", () => {
    const dir = newDirectory(1);
    const future = NOW + FUTURE_SLACK_MS + 1;
    dir.addLink(link(1, P1, { addedAt: 100 }));
    dir.addLink(link(2, P1, { addedAt: future }));
    dir.addLink(link(3, P2, { addedAt: future }));
    expect(best(dir, P1)).toBe(token(1));
    expect(dir.bestLink(P2, NOW)).toBeNull();
    expect(dir.projectOfToken(token(2), NOW)).toBeNull();
    expect(dir.list(NOW).map((e) => e.projectId)).toEqual([P1]);
    // Within the slack is honest clock skew.
    dir.addLink(link(4, P1, { addedAt: NOW + FUTURE_SLACK_MS }));
    expect(best(dir, P1)).toBe(token(4));
    expect(dir.bestLink(P2, future)?.token).toBe(token(3));
  });

  it("ranks retired links last but keeps them as a fallback", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { generation: 1 }));
    dir.addLink(
      link(2, P1, { secret: viewSecret(), edit: false, addedAt: 50 }),
    );
    dir.retire(token(1), 1000);
    expect(dir.bestLink(P1, NOW)).toMatchObject({
      token: token(2),
      retired: false,
    });
    dir.retire(token(2), 1001);
    const fallback = dir.bestLink(P1, NOW)!;
    expect(fallback).toMatchObject({ token: token(1), retired: true });
    expect(dir.list(NOW)[0]!.link).toEqual(fallback);
  });

  it("fills a missing generation once and never changes other facts", () => {
    const dir = newDirectory(1);
    const stored = () =>
      (dir.doc.getMap(ROOT.links).get(token(1)) as { generation?: number })
        .generation;
    dir.addLink(link(1, P1));
    expect(stored()).toBeUndefined();
    expect(dir.addLink(link(1, P1, { generation: 4 }))).toBe(true);
    expect(stored()).toBe(4);
    unchanged(dir, () => {
      expect(dir.addLink(link(1, P1, { generation: 5 }))).toBe(false);
      expect(dir.addLink(link(1, P1, { addedAt: 999 }))).toBe(false);
    });
  });

  it("tells the project of a token", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1));
    dir.addLink(link(2, P2));
    expect(dir.projectOfToken(token(2), NOW)).toBe(P2);
  });
});

describe("status", () => {
  it("scopes removed and gone to the link that saw them", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1));
    const state = () => dir.list(NOW)[0]!.state;

    dir.setStatus(P1, "removed", 5, token(1));
    expect(state()).toBe("removed");
    dir.setStatus(P1, "gone", 6, token(1));
    expect(state()).toBe("gone");

    // A newer link learned later supersedes what the old one saw.
    dir.addLink(link(2, P1, { addedAt: 200, generation: 2 }));
    expect(state()).toBe("listed");
    dir.setStatus(P1, "gone", 7, token(2));
    expect(state()).toBe("gone");

    dir.setStatus(P1, "forgotten", 8);
    expect(state()).toBe("forgotten");
    dir.addLink(link(3, P1, { addedAt: 300, generation: 3 }));
    expect(state()).toBe("forgotten");

    dir.setStatus(P1, "removed", 9);
    expect(state()).toBe("listed");
    dir.setStatus(P1, "listed", 10);
    expect(state()).toBe("listed");
  });
});

describe("list", () => {
  it("orders by last open, then newest link, then id", () => {
    const dir = newDirectory(1);
    for (const [n, id, at] of [
      [1, "a", 10],
      [2, "b", 20],
      [3, "c", 20],
      [4, "d", 5],
    ] as const)
      dir.addLink(link(n, id, { addedAt: at }));
    dir.touchOpened("d", 1000);
    dir.touchOpened("a", 2000);
    expect(dir.list(NOW).map((e) => e.projectId)).toEqual(["a", "d", "b", "c"]);
    expect(dir.list(NOW)[1]!.openedAt).toBe(1000);
  });

  it("reports the earliest link as when the project was added", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { addedAt: 300 }));
    dir.addLink(link(2, P1, { addedAt: 100 }));
    expect(dir.list(NOW)[0]!.addedAt).toBe(100);
  });

  it("trims titles and ignores empty ones", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1));
    expect(dir.setTitle(P1, "   ")).toBe(false);
    expect(dir.setTitle(P1, "  Thesis ")).toBe(true);
    expect(dir.list(NOW)[0]!.title).toBe("Thesis");
    expect(dir.setTitle(P1, "Paper")).toBe(true);
    expect(dir.list(NOW)[0]!.title).toBe("Paper");
  });
});

describe("refileLink", () => {
  it("moves a link and keeps its facts", () => {
    const dir = newDirectory(1);
    const secret = editSecret(1);
    dir.addLink(link(1, P1, { secret, edit: true, addedAt: 100 }));
    expect(dir.refileLink(token(1), P2)).toBe(true);
    const entries = dir.list(NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.projectId).toBe(P2);
    expect(entries[0]!.link.token).toBe(token(1));
    expect(entries[0]!.link.secret).toBe(secret);
    expect(entries[0]!.link.edit).toBe(true);
    expect(entries[0]!.addedAt).toBe(100);

    unchanged(dir, () => {
      expect(dir.refileLink(token(1), P2)).toBe(false);
      expect(dir.refileLink(token(9), P2)).toBe(false);
      expect(dir.refileLink(token(1), "")).toBe(false);
    });
  });
});

describe("no-op writes", () => {
  it("add no ops", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { generation: 2 }));
    dir.retire(token(1), 5);
    dir.setTitle(P1, "T");
    dir.touchOpened(P1, 1000);
    dir.setStatus(P1, "gone", 9, token(1));

    unchanged(dir, () => {
      expect(dir.addLink(link(1, P1, { generation: 2 }))).toBe(false);
      expect(dir.addLink(link(1, P1, { generation: 7, addedAt: 9 }))).toBe(
        false,
      );
      expect(dir.retire(token(1), 99)).toBe(false);
      expect(dir.setTitle(P1, " T ")).toBe(false);
      expect(dir.setTitle(P1, "")).toBe(false);
      expect(dir.touchOpened(P1, 1000 + OPENED_REFRESH_MS - 1)).toBe(false);
      expect(dir.setStatus(P1, "gone", 99, token(1))).toBe(false);
      expect(dir.pruneRetired(6)).toBe(0);
    });

    expect(dir.touchOpened(P1, 1000 + OPENED_REFRESH_MS)).toBe(true);
    expect(dir.setStatus(P1, "gone", 99, token(2))).toBe(true);
    expect(dir.setStatus(P1, "gone", 99)).toBe(true);
  });
});

describe("untrusted data", () => {
  it("skips malformed entries", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { secret: viewSecret(), edit: false }));
    const links = dir.doc.getMap(ROOT.links);
    const good = {
      projectId: "x",
      secret: editSecret(2),
      edit: true,
      addedAt: 5,
    };
    links.set("short", good);
    links.set(token(2), { ...good, secret: "junk" });
    links.set(token(3), { ...good, secret: viewSecret() });
    links.set(token(4), "not a map");
    links.set(token(5), { ...good, addedAt: undefined });
    links.set(token(6), { ...good, projectId: undefined });
    links.set(token(7), { ...good, edit: "yes" });
    links.set(token(8), { ...good, secret: editSecret(2).slice(0, 20) });
    dir.doc.getMap(ROOT.retired).set(token(1), "soon");
    dir.doc.getMap(ROOT.status).set(P1, "gone");
    dir.doc.getMap(ROOT.opened).set(P1, "yesterday");
    dir.doc.getMap(ROOT.titles).set(P1, 5);
    dir.doc.commit();

    const entries = dir.list(NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectId: P1,
      title: null,
      state: "listed",
      openedAt: null,
    });
    expect(entries[0]!.link).toMatchObject({
      token: token(1),
      retired: false,
    });
    expect(dir.projectOfToken(token(4), NOW)).toBeNull();
    expect(dir.bestLink("x", NOW)).toBeNull();
  });

  it("keeps unknown keys and maps when rewriting an entry", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1));
    const links = dir.doc.getMap(ROOT.links);
    links.set(token(1), { ...(links.get(token(1)) as object), future: "kept" });
    dir.doc.getMap("somethingNew").set("k", "v");
    dir.doc.commit();

    expect(dir.addLink(link(1, P1, { generation: 3 }))).toBe(true);
    expect(links.get(token(1))).toMatchObject({
      future: "kept",
      generation: 3,
    });
    expect(dir.doc.getMap("somethingNew").get("k")).toBe("v");
  });
});

describe("concurrent devices", () => {
  it("merge into the same list in either import order", () => {
    const a = newDirectory(1);
    const b = newDirectory(2, false);
    sync(a, b);

    const shared = link(1, P1);
    a.addLink(shared);
    b.addLink(shared);
    a.addLink(link(2, P2, { secret: viewSecret(), edit: false, addedAt: 200 }));
    b.addLink(link(3, P1, { addedAt: 300, generation: 1 }));
    a.retire(token(1), 500);
    b.retire(token(1), 600);
    a.setTitle(P1, "From A");
    b.setTitle(P2, "From B");
    a.touchOpened(P2, 10);
    b.setStatus(P2, "forgotten", 5);

    sync(a, b);
    expect(a.list(NOW)).toEqual(b.list(NOW));
    const entries = a.list(NOW);
    const p1 = entries.find((e) => e.projectId === P1)!;
    expect(p1.link.token).toBe(token(3));
    expect(p1.title).toBe("From A");
    const p2 = entries.find((e) => e.projectId === P2)!;
    expect(p2.state).toBe("forgotten");
    expect(p2.title).toBe("From B");
  });
});

describe("pruneRetired", () => {
  it("drops old retired links but keeps one per project", () => {
    const dir = newDirectory(1);
    dir.addLink(link(1, P1, { addedAt: 1, generation: 1 }));
    dir.addLink(link(2, P1, { addedAt: 2, generation: 2 }));
    dir.addLink(link(3, P2, { addedAt: 3, generation: 1 }));
    dir.addLink(link(4, P2, { addedAt: 4, generation: 2 }));
    const now = 10 * RETIRED_KEEP_MS;
    dir.retire(token(1), 0);
    dir.retire(token(3), 0);
    dir.retire(token(4), 0);
    dir.retire(token(2), now - 1);

    expect(dir.pruneRetired(now)).toBe(2);
    expect(dir.projectOfToken(token(1), NOW)).toBeNull();
    expect(best(dir, P1)).toBe(token(2));
    expect(dir.projectOfToken(token(3), NOW)).toBeNull();
    expect(dir.bestLink(P2, NOW)).toMatchObject({
      token: token(4),
      retired: true,
    });
    expect(dir.pruneRetired(now)).toBe(0);
  });
});

describe("owner keys", () => {
  const secret = (fill: number) => new Uint8Array(32).fill(fill);
  const hexOf = (fill: number) => toHex(ownerPublicKeyOf(secret(fill)));

  it("are added once and listed newest first", () => {
    const dir = newDirectory(1);
    expect(dir.addOwnerKey(P1, secret(1), 100)).toBe(true);
    expect(dir.addOwnerKey(P1, secret(2), 200)).toBe(true);
    unchanged(dir, () => {
      // Never overwritten, so the first addedAt stands.
      expect(dir.addOwnerKey(P1, secret(1), 900)).toBe(false);
    });
    dir.addOwnerKey(P2, secret(3), 300);

    expect(dir.ownerKeys(P1, NOW)).toEqual([
      { publicKey: hexOf(2), secret: secret(2) },
      { publicKey: hexOf(1), secret: secret(1) },
    ]);
    expect(dir.ownerKeys(P2, NOW)).toHaveLength(1);
    expect(dir.ownerKeys("other", NOW)).toEqual([]);
  });

  it("skip entries that do not validate", () => {
    const dir = newDirectory(1);
    dir.addOwnerKey(P1, secret(1), 100);
    const map = dir.doc.getMap(ROOT.ownerKeys);
    const good = toBase64Url(secret(2));
    map.set(`${P1}/${hexOf(1)}`.replace("a", "b"), {
      secret: good,
      addedAt: 5,
    });
    // Another key's secret, uppercase hex, no project, junk and short
    // secrets, no time, no slash, not a map.
    map.set(`${P1}/${hexOf(2)}`, {
      secret: toBase64Url(secret(3)),
      addedAt: 5,
    });
    map.set(`${P1}/${hexOf(2).toUpperCase()}`, { secret: good, addedAt: 5 });
    map.set(`/${hexOf(2)}`, { secret: good, addedAt: 5 });
    map.set(`${P1}/${hexOf(4)}`, { secret: "not a secret!", addedAt: 5 });
    map.set(`${P1}/${hexOf(5)}`, {
      secret: toBase64Url(new Uint8Array(16)),
      addedAt: 5,
    });
    map.set(`${P1}/${hexOf(6)}`, { secret: toBase64Url(secret(6)) });
    map.set("no-slash", { secret: good, addedAt: 5 });
    map.set("bad", "text");
    dir.doc.commit();

    expect(dir.ownerKeys(P1, NOW).map((k) => k.publicKey)).toEqual([hexOf(1)]);
  });

  it("replace a junk entry on add and keep its unknown keys", () => {
    const dir = newDirectory(1);
    const map = dir.doc.getMap(ROOT.ownerKeys);
    const id = `${P1}/${hexOf(2)}`;
    map.set(id, { secret: "junk", note: "kept" });
    dir.doc.commit();
    expect(dir.addOwnerKey(P1, secret(2), 50)).toBe(true);
    expect(map.get(id)).toMatchObject({ note: "kept", addedAt: 50 });
    expect(dir.ownerKeys(P1, NOW)).toHaveLength(1);
  });

  it("skips future-dated keys and prunes them first", () => {
    const dir = newDirectory(1);
    dir.addOwnerKey(P1, secret(1), 100);
    dir.addOwnerKey(P1, secret(2), 200);
    dir.addOwnerKey(P1, secret(3), NOW + FUTURE_SLACK_MS + 1);
    expect(dir.ownerKeys(P1, NOW).map((k) => k.publicKey)).toEqual([
      hexOf(2),
      hexOf(1),
    ]);
    expect(dir.pruneOwnerKeys(P1, NOW, 2)).toBe(1);
    expect(dir.ownerKeys(P1, NOW + 2 * FUTURE_SLACK_MS)).toHaveLength(2);
  });

  it("prune to the newest few per project", () => {
    const dir = newDirectory(1);
    for (let i = 1; i <= 5; i++) dir.addOwnerKey(P1, secret(i), i * 100);
    dir.addOwnerKey(P2, secret(9), 1);
    expect(dir.pruneOwnerKeys(P1, NOW, OWNER_KEYS_KEEP)).toBe(0);
    expect(dir.pruneOwnerKeys(P1, NOW, 2)).toBe(3);
    expect(dir.ownerKeys(P1, NOW).map((k) => k.publicKey)).toEqual([
      hexOf(5),
      hexOf(4),
    ]);
    expect(dir.ownerKeys(P2, NOW)).toHaveLength(1);
    expect(dir.pruneOwnerKeys(P1, NOW, 2)).toBe(0);
  });

  it("union when two devices add concurrently", () => {
    const a = newDirectory(1);
    const b = newDirectory(2, false);
    sync(a, b);
    a.addOwnerKey(P1, secret(1), 10);
    b.addOwnerKey(P1, secret(2), 20);
    b.addOwnerKey(P1, secret(1), 30);
    sync(a, b);
    expect(a.ownerKeys(P1, NOW)).toHaveLength(2);
    expect(a.ownerKeys(P1, NOW)).toEqual(b.ownerKeys(P1, NOW));
  });
});
