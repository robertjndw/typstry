import type { OpId, PeerID } from "loro-crdt";

import { createFile, getText } from "./fs-ops";
import {
  computeHistory,
  groupChanges,
  readChanges,
  tagAt,
  type ChangeInfo,
} from "./history";
import { buildPathIndex } from "./paths";
import { initProject, ProjectDoc } from "./schema";
import { deleteVersion, saveVersion } from "./versions";
import { fork, newProject, sync } from "./test-utils";

const MIN = 60;

function change(
  peer: string,
  counter: number,
  lamport: number,
  timestamp: number,
  deps: OpId[] = [],
  length = 1,
): ChangeInfo {
  return { peer: peer as PeerID, counter, length, lamport, timestamp, deps };
}

const id = (peer: string, counter: number): OpId => ({
  peer: peer as PeerID,
  counter,
});

describe("groupChanges", () => {
  it("splits on gaps longer than five minutes", () => {
    const t0 = 1_700_000_000;
    const changes = [
      change("1", 0, 0, t0, [], 3),
      change("1", 3, 3, t0 + 4 * MIN, [id("1", 2)]),
      change("1", 4, 4, t0 + 10 * MIN, [id("1", 3)]),
    ];
    const groups = groupChanges(changes);
    expect(groups.map((g) => g.changes.length)).toEqual([2, 1]);
    expect(groups[0]).toMatchObject({
      id: "0@1",
      start: t0 * 1000,
      end: (t0 + 4 * MIN) * 1000,
      authors: ["1"],
      frontiers: [id("1", 3)],
    });
    expect(groups[1]!.frontiers).toEqual([id("1", 4)]);
  });

  it("caps a group at thirty minutes even without pauses", () => {
    const t0 = 1_700_000_000;
    const changes = Array.from({ length: 13 }, (_, i) =>
      change("1", i, i, t0 + i * 4 * MIN, i > 0 ? [id("1", i - 1)] : []),
    );
    const groups = groupChanges(changes);
    // 0..28 min fit in the first group, 32 min starts the second.
    expect(groups.map((g) => g.changes.length)).toEqual([8, 5]);
  });

  it("honours custom thresholds", () => {
    const changes = [change("1", 0, 0, 100), change("1", 1, 1, 115)];
    expect(
      groupChanges(changes, { gapMs: 10_000, maxSpanMs: 60_000 }),
    ).toHaveLength(2);
    expect(
      groupChanges(changes, { gapMs: 20_000, maxSpanMs: 60_000 }),
    ).toHaveLength(1);
  });

  it("merges concurrent peers and keeps frontiers causally closed", () => {
    const t0 = 1_000_000;
    // 1 and 2 both build on 1@0..0 concurrently, then 2 merges both.
    const changes = [
      change("2", 1, 2, t0 + 60, [id("1", 0), id("2", 0)]),
      change("1", 0, 0, t0),
      change("2", 0, 1, t0 + 30, [id("1", 0)]),
      change("1", 1, 1, t0 + 45, [id("1", 0)]),
      change("2", 2, 3, t0 + 30 * MIN, [id("2", 1), id("1", 1)]),
    ];
    const groups = groupChanges(changes);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.authors).toEqual(["1", "2"]);
    // 1@1 and 2@1 are concurrent heads after the first session.
    expect(groups[0]!.frontiers).toEqual([id("1", 1), id("2", 1)]);
    expect(groups[1]!.frontiers).toEqual([id("2", 2)]);
    // Same result whatever order the changes arrive in.
    expect(groupChanges([...changes].reverse())).toEqual(groups);
  });

  it("places changes after their ancestors despite clock skew", () => {
    // Peer 2's clock is an hour behind; its change still depends on 1@0.
    const changes = [
      change("1", 0, 0, 10_000),
      change("2", 0, 1, 10_000 - 3600, [id("1", 0)]),
    ];
    const groups = groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.changes.map((c) => c.peer)).toEqual(["1", "2"]);
    expect(groups[0]!.frontiers).toEqual([id("2", 0)]);
  });

  it("keeps untimed changes in a leading group and attaches later ones", () => {
    const changes = [
      change("1", 0, 0, 0),
      change("1", 1, 1, 0, [id("1", 0)]),
      change("1", 2, 2, 50_000, [id("1", 1)]),
      // Untimed but after a timed change: inherits its time.
      change("2", 0, 3, 0, [id("1", 2)]),
    ];
    const groups = groupChanges(changes);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ start: null, end: null });
    expect(groups[0]!.changes).toHaveLength(2);
    expect(groups[1]!.changes.map((c) => c.peer)).toEqual(["1", "2"]);
    expect(groups[1]!.start).toBe(50_000_000);
  });

  it("lets bookkeeping join a session without moving or splitting it", () => {
    const t0 = 1_700_000_000;
    const meta = (c: ChangeInfo): ChangeInfo => ({ ...c, meta: true });
    const groups = groupChanges([
      change("1", 0, 0, t0),
      // A version saved, then a reload by a new peer much later.
      meta(change("1", 1, 1, t0 + MIN, [id("1", 0)])),
      meta(change("2", 0, 2, t0 + 20 * MIN, [id("1", 1)])),
      change("1", 2, 3, t0 + 30 * MIN, [id("2", 0)]),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.end).toBe(t0 * 1000);
    expect(groups[0]!.authors).toEqual(["1"]);
    // Still part of the session, so its version includes them.
    expect(groups[0]!.frontiers).toEqual([id("2", 0)]);
    expect(groups[1]!.start).toBe((t0 + 30 * MIN) * 1000);
  });

  it("ends a group at a tagged version, keeping the tag's own save", () => {
    const t0 = 1_700_000_000;
    const groups = groupChanges(
      [
        change("1", 0, 0, t0),
        change("1", 1, 1, t0 + MIN, [id("1", 0)]),
        // Saving the tag, then more typing in the same minute.
        { ...change("1", 2, 2, t0 + MIN, [id("1", 1)]), meta: true },
        change("1", 3, 3, t0 + MIN, [id("1", 2)]),
      ],
      undefined,
      [[id("1", 1)]],
    );
    expect(groups.map((g) => g.changes.map((c) => c.counter))).toEqual([
      [0, 1, 2],
      [3],
    ]);
  });

  it("ignores cuts the history never passes through", () => {
    const t0 = 1_700_000_000;
    const changes = [
      change("1", 0, 0, t0),
      change("1", 1, 1, t0, [id("1", 0)]),
    ];
    expect(groupChanges(changes, undefined, [[id("9", 0)]])).toEqual(
      groupChanges(changes),
    );
  });

  it("returns nothing for an empty history", () => {
    expect(groupChanges([])).toEqual([]);
  });
});

describe("computeHistory", () => {
  it("groups a real doc and reports touched files", () => {
    const a = newProject(1);
    a.doc.setChangeMergeInterval(0);
    initProject(a, { title: "T" });
    // Loro clamps timestamps to be non-decreasing, and initProject recorded
    // the real time, so the synthetic ones have to lie in the future.
    const t0 = Math.floor(Date.now() / 1000) + 3600;
    const main = a.mainFile!;
    getText(a, main).insert(0, "x");
    a.doc.commit({ timestamp: t0 });
    const b = newProject(2);
    b.doc.setChangeMergeInterval(0);
    sync(a, b);
    createFile(b, null, "b.typ", "text", "hi");
    getText(b, main).insert(0, "y");
    b.doc.commit({ timestamp: t0 + 60 });
    sync(a, b);
    getText(a, main).insert(0, "z");
    a.doc.commit({ timestamp: t0 + 3600 });
    sync(a, b);

    const history = computeHistory(a);
    expect(computeHistory(b).map((g) => g.frontiers)).toEqual(
      history.map((g) => g.frontiers),
    );
    const last = history.at(-1)!;
    expect(last.frontiers).toEqual(a.doc.oplogFrontiers());
    expect(last.files).toEqual([main]);
    const session = history.at(-2)!;
    expect(new Set(session.authors)).toEqual(new Set(["1", "2"]));
    expect(session.files).toHaveLength(2);
    // The session's version is the state right before the last edit.
    const fork = new ProjectDoc(a.doc.forkAt(session.frontiers));
    expect(getText(fork, main).toString()).toMatch(/^yx/);
    expect([...buildPathIndex(fork).byPath.keys()].sort()).toEqual([
      "b.typ",
      "main.typ",
    ]);
  });

  it("records timestamps on every project doc", () => {
    const project = newProject(3);
    initProject(project, { title: "Now" });
    const [change] = readChanges(project.doc);
    expect(change!.timestamp).toBeGreaterThan(1_600_000_000);
  });

  it("does not count saving, deleting versions or peer info as edits", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
      const p = initProject(newProject(1), { title: "T" });
      vi.setSystemTime(new Date("2026-10-10T10:10:00Z"));
      getText(p, p.mainFile!).insert(0, "edit ");
      p.doc.commit();
      vi.setSystemTime(new Date("2026-10-10T10:11:00Z"));
      deleteVersion(p, saveVersion(p, "Tagged"));
      vi.setSystemTime(new Date("2026-10-10T10:12:00Z"));
      p.setPeer(p.doc.peerIdStr, { name: "Me", color: "#000000" });
      // Long after: a reload alone must not show up as a session.
      vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
      p.setPeer(p.doc.peerIdStr, { name: "Me again", color: "#000000" });

      const last = computeHistory(p).at(-1)!;
      expect(last.end).toBe(Date.parse("2026-10-10T10:10:00Z"));
      expect(last.files).toEqual([p.mainFile]);
      expect(last.frontiers).toEqual(p.doc.oplogFrontiers());
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits a session where a version was tagged mid-way", () => {
    const p = initProject(newProject(1), { title: "T" });
    const main = p.mainFile!;
    getText(p, main).insert(0, "before ");
    p.doc.commit();
    const tag = saveVersion(p, "Tagged");
    getText(p, main).insert(0, "after ");
    p.doc.commit();

    const history = computeHistory(p, undefined, [tag.frontiers]);
    const tagged = history.at(-2)!;
    expect(p.doc.cmpFrontiers(tagged.frontiers, tag.frontiers)).toBe(1);
    const old = new ProjectDoc(p.doc.forkAt(tagged.frontiers));
    expect(getText(old, main).toString()).toMatch(/^before /);
    expect(history.at(-1)!.files).toEqual([main]);
  });
});

describe("tagAt", () => {
  it("finds the tag of the current version until something is edited", () => {
    const p = initProject(newProject(1), { title: "T" });
    expect(tagAt(p)).toBeUndefined();
    const tag = saveVersion(p, "Tagged");
    expect(tagAt(p)?.id).toBe(tag.id);
    // Bookkeeping, like a reload recording the name, changes nothing.
    p.setPeer(p.doc.peerIdStr, { name: "Me", color: "#000000" });
    expect(tagAt(p)?.id).toBe(tag.id);

    const tagged = p.doc.oplogFrontiers();
    getText(p, p.mainFile!).insert(0, "edit ");
    p.doc.commit();
    expect(tagAt(p)).toBeUndefined();
    expect(tagAt(p, tagged)?.id).toBe(tag.id);

    deleteVersion(p, tag);
    expect(tagAt(p, tagged)).toBeUndefined();
  });

  it("sees a tag made by another peer", () => {
    const a = initProject(newProject(1), { title: "T" });
    const b = fork(a, 2);
    saveVersion(b, "From B");
    sync(a, b);
    expect(tagAt(a)?.name).toBe("From B");
  });
});
