import { EditorView } from "@codemirror/view";
import { LoroDoc, type TreeID } from "loro-crdt";

import { PALETTE } from "@/presence/identity";
import {
  encodeSelection,
  type PresenceSource,
  type RemotePeer,
} from "@/presence/presence";

import { createLoroEditorState } from "./loro-binding";
import {
  remoteCaretPositions,
  remoteCursors,
  reportSelection,
} from "./remote-cursors";

const FILE = "0@1" as TreeID;

class FakeSource implements PresenceSource {
  peers: RemotePeer[] = [];
  private listeners = new Set<() => void>();
  getPeers = () => this.peers;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(peers: RemotePeer[]) {
    this.peers = peers;
    for (const l of this.listeners) l();
  }
}

function setup() {
  const a = new LoroDoc();
  a.setPeerId(1);
  a.getText("t").insert(0, "hello world");
  a.commit();
  const b = new LoroDoc();
  b.setPeerId(2);
  b.import(a.export({ mode: "snapshot" }));

  const source = new FakeSource();
  const text = a.getText("t");
  const view = new EditorView({
    parent: document.body,
    state: createLoroEditorState(
      { doc: a, text },
      {
        extensions: remoteCursors({ doc: a, text, fileId: FILE, source }),
      },
    ),
  });
  return { a, b, source, view };
}

function bob(b: LoroDoc, anchor: number, head: number, fileId = FILE) {
  return {
    peerId: "2",
    name: "Bob",
    color: PALETTE[5],
    fileId,
    ...encodeSelection(b.getText("t"), anchor, head)!,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function exchange(x: LoroDoc, y: LoroDoc) {
  y.import(x.export({ mode: "update", from: y.oplogVersion() }));
  x.import(y.export({ mode: "update", from: x.oplogVersion() }));
}

describe("remoteCursors", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("draws a peer's caret, label and selection in the same file", async () => {
    const { b, source, view } = setup();
    source.set([bob(b, 6, 11)]);
    await flush();

    expect(remoteCaretPositions(view)).toEqual([{ name: "Bob", pos: 11 }]);
    const label = view.dom.querySelector(".cm-remote-label");
    expect(label?.textContent).toBe("Bob");
    expect(view.dom.querySelector(".cm-remote-selection")?.textContent).toBe(
      "world",
    );
    view.destroy();
  });

  it("hides peers that have another file open", async () => {
    const { b, source, view } = setup();
    source.set([bob(b, 3, 3, "5@9" as TreeID)]);
    await flush();
    expect(remoteCaretPositions(view)).toEqual([]);
    view.destroy();
  });

  it("keeps the caret on the same character across concurrent edits", async () => {
    const { a, b, source, view } = setup();
    // Bob's caret sits right before "world".
    source.set([bob(b, 6, 6)]);
    await flush();

    // Local edit in A's editor and a concurrent remote edit by Bob.
    view.dispatch({ changes: { from: 0, insert: ">> " } });
    b.getText("t").insert(0, "[");
    b.getText("t").insert(12, "!");
    b.commit();
    exchange(a, b);
    await flush();

    expect(view.state.doc.toString()).toBe(">> [hello world!");
    const pos = remoteCaretPositions(view)[0]!.pos;
    expect(view.state.doc.sliceString(pos, pos + 5)).toBe("world");
    view.destroy();
  });

  it("removes carets of peers that leave", async () => {
    const { b, source, view } = setup();
    source.set([bob(b, 1, 1)]);
    await flush();
    expect(remoteCaretPositions(view)).toHaveLength(1);
    source.set([]);
    await flush();
    expect(remoteCaretPositions(view)).toEqual([]);
    view.destroy();
  });
});

describe("reportSelection", () => {
  it("reports the initial and local selections but not remote edits", () => {
    const doc = new LoroDoc();
    const text = doc.getText("t");
    text.insert(0, "abc");
    doc.commit();
    const calls: [number, number][] = [];
    const presence = {
      setSelection: (_f: unknown, _t: unknown, anchor: number, head: number) =>
        calls.push([anchor, head]),
    };
    const view = new EditorView({
      parent: document.body,
      state: createLoroEditorState(
        { doc, text },
        { extensions: reportSelection(presence, FILE, text) },
      ),
    });
    expect(calls).toEqual([[0, 0]]);
    view.dispatch({ selection: { anchor: 1, head: 3 } });
    expect(calls.at(-1)).toEqual([1, 3]);

    const other = new LoroDoc();
    other.import(doc.export({ mode: "snapshot" }));
    other.getText("t").insert(0, "x");
    other.commit();
    const before = calls.length;
    doc.import(other.export({ mode: "update", from: doc.oplogVersion() }));
    expect(calls).toHaveLength(before);
    view.destroy();
  });
});
