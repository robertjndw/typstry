import { EphemeralStore, LoroDoc, type TreeID } from "loro-crdt";

import { PALETTE } from "./identity";
import {
  encodeSelection,
  parsePresence,
  Presence,
  presenceKey,
  resolveSelection,
} from "./presence";

function docPair() {
  const a = new LoroDoc();
  a.setPeerId(1);
  a.getText("t").insert(0, "hello world");
  a.commit();
  const b = new LoroDoc();
  b.setPeerId(2);
  b.import(a.export({ mode: "snapshot" }));
  return { a, b };
}

function exchange(x: LoroDoc, y: LoroDoc) {
  y.import(x.export({ mode: "update", from: y.oplogVersion() }));
  x.import(y.export({ mode: "update", from: x.oplogVersion() }));
}

function linkedStores() {
  const x = new EphemeralStore(30_000);
  const y = new EphemeralStore(30_000);
  x.subscribeLocalUpdates((u) => y.apply(u));
  y.subscribeLocalUpdates((u) => x.apply(u));
  return [x, y] as const;
}

describe("presence encoding", () => {
  it("resolves a selection on another doc after concurrent edits", () => {
    const { a, b } = docPair();
    // B selects "world".
    const sel = encodeSelection(b.getText("t"), 6, 11)!;

    // Concurrently, A inserts before the selection and B types inside it.
    a.getText("t").insert(0, ">> ");
    a.commit();
    b.getText("t").insert(8, "XX");
    b.commit();
    exchange(a, b);

    expect(a.getText("t").toString()).toBe(">> hello woXXrld");
    expect(resolveSelection(a, a.getText("t"), sel)).toEqual({
      anchor: 9,
      head: 16,
    });
  });

  it("ignores cursors of another text and of unknown ops", () => {
    const { a, b } = docPair();
    const other = encodeSelection(b.getText("t"), 1, 1)!;
    expect(resolveSelection(a, a.getText("other"), other)).toBeNull();

    b.getText("t").insert(0, "new");
    b.commit();
    // A has not received B's insert yet.
    const ahead = encodeSelection(b.getText("t"), 2, 2)!;
    expect(resolveSelection(a, a.getText("t"), ahead)).toBeNull();
  });

  it("validates remote states", () => {
    const anchor = new Uint8Array([1]);
    expect(
      parsePresence({
        name: "Ada",
        color: PALETTE[0],
        fileId: "3@12",
        anchor,
        head: anchor,
      }),
    ).toEqual({
      name: "Ada",
      color: PALETTE[0],
      fileId: "3@12",
      anchor,
      head: anchor,
    });
    expect(parsePresence({ name: "Ada", color: "url(x)" })).toBeNull();
    expect(parsePresence({ name: 1, color: PALETTE[0] })).toBeNull();
    expect(
      parsePresence({ name: "Ada", color: PALETTE[0], fileId: "bogus" })
        ?.fileId,
    ).toBeNull();
    expect(parsePresence(null)).toBeNull();
  });
});

describe("Presence", () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    }),
  );
  afterEach(() => vi.useRealTimers());

  // Peers drop a second write to a key within the same millisecond, so the
  // class spaces its writes out; tests let that time pass.
  const tick = () => vi.advanceTimersByTime(100);

  function setup() {
    const { a, b } = docPair();
    const [ea, eb] = linkedStores();
    const pa = new Presence({
      doc: a,
      ephemeral: ea,
      identity: { name: "Ada", color: PALETTE[0] },
    });
    const pb = new Presence({
      doc: b,
      ephemeral: eb,
      identity: { name: "Bob", color: PALETTE[1] },
    });
    return { a, b, ea, eb, pa, pb };
  }

  it("lists other peers but not itself, and late joiners see existing ones", () => {
    const { pa, pb } = setup();
    pa.start();
    pa.setFile("0@1" as TreeID);
    tick();
    expect(pa.getPeers()).toEqual([]);

    pb.start();
    expect(pb.getPeers()).toMatchObject([
      { peerId: "1", name: "Ada", fileId: "0@1" },
    ]);
    expect(pa.getPeers()).toMatchObject([{ peerId: "2", name: "Bob" }]);
  });

  it("throttles selection updates and clears the selection on file switch", () => {
    const { b, ea, pa, pb } = setup();
    pa.start();
    pb.start();
    pb.setFile("0@1" as TreeID);
    tick();
    const text = b.getText("t");

    pb.setSelection("0@1" as TreeID, text, 1, 1);
    pb.setSelection("0@1" as TreeID, text, 2, 2);
    pb.setSelection("0@1" as TreeID, text, 3, 3);
    const read = () => resolveSelection(b, text, pa.getPeers()[0]!);
    expect(read()).toEqual({ anchor: 1, head: 1 });
    vi.advanceTimersByTime(60);
    expect(read()).toEqual({ anchor: 3, head: 3 });

    pb.setFile(null);
    tick();
    expect(ea.get(presenceKey("2"))).toMatchObject({ fileId: null });
    expect(pa.getPeers()[0]?.anchor).toBeUndefined();
  });

  it("keeps the summary stable while only selections move", () => {
    const { b, pa, pb } = setup();
    pa.start();
    pb.start();
    pb.setFile("0@1" as TreeID);
    tick();
    const text = b.getText("t");
    const summary = pa.getSummary();
    expect(summary).toEqual([
      { peerId: "2", name: "Bob", color: PALETTE[1], fileId: "0@1" },
    ]);

    const peers = pa.getPeers();
    pb.setSelection("0@1" as TreeID, text, 1, 1);
    tick();
    expect(pa.getPeers()).not.toBe(peers);
    expect(pa.getSummary()).toBe(summary);

    pb.setFile("1@1" as TreeID);
    tick();
    expect(pa.getSummary()).not.toBe(summary);
    expect(pa.getSummary()[0]?.fileId).toBe("1@1");
  });

  it("removes its key on dispose and republishes on restart", () => {
    const { ea, pa, pb } = setup();
    pa.start();
    pb.start();
    expect(pa.getPeers()).toHaveLength(1);
    tick();
    pb.dispose();
    expect(ea.keys()).toEqual([presenceKey("1")]);
    expect(pa.getPeers()).toEqual([]);
    tick();
    pb.start();
    expect(pa.getPeers()).toHaveLength(1);
  });

  it("refreshes its entry so it does not time out", () => {
    const { pa, pb } = setup();
    pa.start();
    pb.start();
    vi.advanceTimersByTime(60_000);
    expect(pa.getPeers()).toHaveLength(1);
    expect(pb.getPeers()).toHaveLength(1);
  });

  it("forgets a peer that stopped refreshing (closed tab)", () => {
    const { eb, pa } = setup();
    pa.start();
    eb.set(presenceKey("9"), { name: "Gone", color: PALETTE[4], fileId: null });
    expect(pa.getPeers()).toHaveLength(1);
    vi.advanceTimersByTime(45_000);
    expect(pa.getPeers()).toEqual([]);
  });

  it("publishes identity changes", () => {
    const { pa, pb } = setup();
    pa.start();
    pb.start();
    pb.setIdentity({ name: "Robert", color: PALETTE[3] });
    tick();
    expect(pa.getPeers()[0]).toMatchObject({
      name: "Robert",
      color: PALETTE[3],
    });
  });
});
