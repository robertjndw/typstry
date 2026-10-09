import { runScopeHandlers, EditorView } from "@codemirror/view";
import { LoroDoc, LoroText, UndoManager, type LoroEventBatch } from "loro-crdt";

import {
  createLoroEditorState,
  loroSync,
  textDeltaToChanges,
} from "./loro-binding";
import { loroUndo } from "./undo";
import { EditorState } from "@codemirror/state";

interface Peer {
  doc: LoroDoc;
  text: LoroText;
  view: EditorView;
}

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function mount(
  doc: LoroDoc,
  text: LoroText,
  undoManager?: UndoManager,
): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: createLoroEditorState(
      { doc, text },
      { extensions: undoManager ? loroUndo({ doc, text, undoManager }) : [] },
    ),
  });
  views.push(view);
  return view;
}

function peer(id: number, name = "main.typ"): Peer {
  const doc = new LoroDoc();
  doc.setPeerId(id);
  const text = doc.getText(name);
  return { doc, text, view: mount(doc, text) };
}

/** Buffers updates from `from` so the test decides when they arrive. */
function channel(from: LoroDoc, to: LoroDoc) {
  const queue: Uint8Array[] = [];
  from.subscribeLocalUpdates((u) => queue.push(u));
  return {
    flush() {
      for (const u of queue.splice(0)) to.import(u);
    },
    get pending() {
      return queue.length;
    },
  };
}

function expectInSync(p: Peer) {
  expect(p.view.state.doc.toString()).toBe(p.text.toString());
  expect(p.view.state.doc.length).toBe(p.text.length);
}

function type(view: EditorView, from: number, to: number, insert: string) {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
  });
}

// mulberry32, so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("loro text api", () => {
  it("uses UTF-16 offsets for insert, delete and length", () => {
    const doc = new LoroDoc();
    const text = doc.getText("t");
    text.insert(0, "a😀b");
    expect(text.length).toBe("a😀b".length);
    text.insert(3, "X");
    expect(text.toString()).toBe("a😀Xb");
    text.delete(1, 2);
    expect(text.toString()).toBe("aXb");
  });
});

describe("textDeltaToChanges", () => {
  it("maps retain/delete/insert to start-document positions", () => {
    expect(
      textDeltaToChanges([
        { retain: 2 },
        { delete: 3 },
        { insert: "xy" },
        { retain: 1 },
        { insert: "z" },
      ]),
    ).toEqual([
      { from: 2, to: 5, insert: "xy" },
      { from: 6, to: 6, insert: "z" },
    ]);
  });
});

describe("loroSync", () => {
  it("starts with the Loro text as editor content", () => {
    const doc = new LoroDoc();
    const text = doc.getText("main.typ");
    text.insert(0, "= Title\nbody");
    doc.commit();
    expectInSync({ doc, text, view: mount(doc, text) });
  });

  it("resyncs an editor whose state was created from a stale snapshot", async () => {
    const doc = new LoroDoc();
    const text = doc.getText("main.typ");
    text.insert(0, "fresh");
    doc.commit();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "stale",
        extensions: loroSync({ doc, text }),
      }),
    });
    views.push(view);
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("fresh");
  });

  it("applies multi-range local transactions in order", () => {
    const a = peer(1);
    type(a.view, 0, 0, "0123456789");
    a.view.dispatch({
      changes: [
        { from: 1, to: 3, insert: "ab" },
        { from: 5, insert: "XYZ" },
        { from: 7, to: 9 },
      ],
    });
    expect(a.view.state.doc.toString()).toBe("0ab34XYZ569");
    expectInSync(a);
  });

  it("applies remote edits and does not echo them back", () => {
    const a = peer(1);
    const b = peer(2);
    const ab = channel(a.doc, b.doc);
    const ba = channel(b.doc, a.doc);
    type(a.view, 0, 0, "hello");
    ab.flush();
    expect(b.view.state.doc.toString()).toBe("hello");
    expect(ba.pending).toBe(0);
    type(b.view, 5, 5, " world");
    ba.flush();
    expect(a.view.state.doc.toString()).toBe("hello world");
    expect(ab.pending).toBe(0);
  });

  it("round-trips emoji and surrogate pairs", () => {
    const a = peer(1);
    const b = peer(2);
    const ab = channel(a.doc, b.doc);
    const ba = channel(b.doc, a.doc);
    type(a.view, 0, 0, "a😀b👩‍👩‍👧c");
    ab.flush();
    expectInSync(b);
    // Delete the 😀 (two UTF-16 units) in B and insert after the family emoji in A.
    type(b.view, 1, 3, "");
    type(
      a.view,
      a.view.state.doc.length - 1,
      a.view.state.doc.length - 1,
      "🎉",
    );
    ab.flush();
    ba.flush();
    for (const p of [a, b]) {
      expect(p.view.state.doc.toString()).toBe("ab👩‍👩‍👧🎉c");
      expectInSync(p);
    }
  });

  it("keeps CRLF byte-identical between Loro and the editor", () => {
    const a = peer(1);
    const b = peer(2);
    const ab = channel(a.doc, b.doc);
    const ba = channel(b.doc, a.doc);
    a.text.insert(0, "line1\r\nline2\r\n");
    a.doc.commit();
    ab.flush();
    expectInSync(a);
    expectInSync(b);
    expect(b.view.state.doc.toString()).toBe("line1\r\nline2\r\n");

    type(b.view, 7, 7, "new\r\n");
    type(a.view, 5, 7, "\n");
    ba.flush();
    ab.flush();
    for (const p of [a, b]) {
      expect(p.view.state.doc.toString()).toBe("line1\nnew\r\nline2\r\n");
      expectInSync(p);
    }
  });

  it("does not drop edits when a batch also touches other containers", () => {
    // Regression for loro-codemirror returning early on the first foreign event.
    const source = new LoroDoc();
    source.setPeerId(1);
    const first = source.getText("a.typ");
    const last = source.getText("z.typ");
    const meta = source.getMap("meta");

    const target = new LoroDoc();
    target.setPeerId(2);
    const vFirst = mount(target, target.getText("a.typ"));
    const vLast = mount(target, target.getText("z.typ"));
    const batches: LoroEventBatch[] = [];
    target.subscribe((b) => batches.push(b));

    for (let i = 0; i < 5; i++) {
      first.insert(first.length, `a${i}😀\r\n`);
      meta.set("k", i);
      last.insert(0, `z${i}`);
      source.commit();
      target.import(source.export({ mode: "update", from: target.version() }));
    }
    // Two commits, imported as a single batch.
    first.delete(0, 2);
    last.insert(last.length, "!");
    source.commit();
    meta.set("k", "x");
    first.insert(0, "^");
    source.commit();
    target.import(source.export({ mode: "update", from: target.version() }));

    expect(vFirst.state.doc.toString()).toBe(first.toString());
    expect(vLast.state.doc.toString()).toBe(last.toString());
    // With two bound texts and a map in each batch, at least one view always
    // sees a foreign event before its own.
    expect(batches.every((b) => b.events.length >= 3)).toBe(true);
  });

  it("does not duplicate text when concurrent tree ops recreate its node", () => {
    // Text bound inside a tree node, like project files. Loro re-announces
    // the full content of a recreated node's containers on such imports.
    const a = new LoroDoc();
    a.setPeerId(1);
    const b = new LoroDoc();
    b.setPeerId(2);
    const fromA = channel(a, b);
    const fromB = channel(b, a);
    const node = a.getTree("fs").createNode();
    const text = node.data.setContainer("content", new LoroText());
    a.commit();
    b.getTree("fs").createNode();
    b.commit();
    const view = mount(a, text);
    type(view, 0, 0, "AAA");
    // The dev-only divergence check would silently repair a duplicate, so
    // assert that it never had to.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      fromB.flush();
      fromA.flush();
      expect(view.state.doc.toString()).toBe("AAA");
      expect(text.toString()).toBe("AAA");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("follows checkouts of its own container only", () => {
    const a = peer(1);
    const other = a.doc.getText("other.typ");
    type(a.view, 0, 0, "v1");
    const v1 = a.doc.frontiers();
    type(a.view, 2, 2, " v2");
    other.insert(0, "unrelated");
    a.doc.commit();
    a.doc.checkout(v1);
    expect(a.view.state.doc.toString()).toBe("v1");
    a.doc.checkoutToLatest();
    expect(a.view.state.doc.toString()).toBe("v1 v2");
    expectInSync(a);
  });

  it("stops listening after the view is destroyed", () => {
    const a = peer(1);
    a.view.destroy();
    a.text.insert(0, "after");
    a.doc.commit();
    expect(a.view.state.doc.toString()).toBe("");
  });

  it("converges under random concurrent edits", () => {
    const random = rng(42);
    const a = peer(1);
    const b = peer(2);
    const ab = channel(a.doc, b.doc);
    const ba = channel(b.doc, a.doc);
    const pieces = ["x", "hello ", "😀", "\n", "\r\n", "é", "👩‍👩‍👧", "#let a = 1"];

    const edit = (p: Peer) => {
      const len = p.view.state.doc.length;
      const changes = [];
      let pos = 0;
      // Up to three non-overlapping ranges per transaction, like multi-cursor edits.
      const count = 1 + Math.floor(random() * 3);
      for (let i = 0; i < count && pos <= len; i++) {
        let from = pos + Math.floor(random() * (len - pos + 1));
        let to = Math.min(len, from + Math.floor(random() * 4));
        // Never split a surrogate pair; CodeMirror would let us, Loro rejects it.
        const doc = p.view.state.doc;
        const isLow = (at: number) =>
          /[\uDC00-\uDFFF]/.test(doc.sliceString(at, at + 1));
        while (from > 0 && isLow(from)) from--;
        while (to < len && isLow(to)) to++;
        if (from < pos) break;
        const insert =
          random() < 0.7 ? pieces[Math.floor(random() * pieces.length)]! : "";
        changes.push({ from, to, insert });
        pos = to + 1;
      }
      p.view.dispatch({ changes });
    };

    for (let step = 0; step < 400; step++) {
      const r = random();
      if (r < 0.35) edit(a);
      else if (r < 0.7) edit(b);
      else if (r < 0.85) ab.flush();
      else ba.flush();
      expectInSync(a);
      expectInSync(b);
    }
    ab.flush();
    ba.flush();
    expectInSync(a);
    expectInSync(b);
    expect(a.text.toString()).toBe(b.text.toString());
    expect(a.text.length).toBeGreaterThan(0);
  });
});

describe("loroUndo", () => {
  function setup() {
    const doc = new LoroDoc();
    doc.setPeerId(1);
    const text = doc.getText("main.typ");
    const undoManager = new UndoManager(doc, { mergeInterval: 0 });
    const view = mount(doc, text, undoManager);
    return { doc, text, undoManager, view };
  }

  const key = (view: EditorView, init: KeyboardEventInit) =>
    runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { ctrlKey: true, ...init }),
      "editor",
    );

  it("undoes and redoes local edits through the keymap", () => {
    const { text, view } = setup();
    type(view, 0, 0, "hello");
    type(view, 5, 5, " world");
    expect(key(view, { key: "z" })).toBe(true);
    expect(view.state.doc.toString()).toBe("hello");
    expect(text.toString()).toBe("hello");
    expect(key(view, { key: "y" })).toBe(true);
    expect(view.state.doc.toString()).toBe("hello world");
    key(view, { key: "z" });
    expect(key(view, { key: "Z", keyCode: 90, shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("hello world");
    expect(text.toString()).toBe("hello world");
  });

  it("only undoes own edits and restores the cursor", () => {
    const { doc, view } = setup();
    const remote = peer(2);
    const toRemote = channel(doc, remote.doc);
    const fromRemote = channel(remote.doc, doc);
    type(view, 0, 0, "mine");
    toRemote.flush();
    type(remote.view, 0, 0, "theirs ");
    fromRemote.flush();
    view.dispatch({ selection: { anchor: 0 } });

    key(view, { key: "z" });
    expect(view.state.doc.toString()).toBe("theirs ");
    // The cursor jumps back to the undone edit, shifted by the remote insert.
    expect(view.state.selection.main.head).toBe("theirs ".length);
    key(view, { key: "y" });
    expect(view.state.doc.toString()).toBe("theirs mine");
    toRemote.flush();
    expectInSync(remote);
    expect(remote.view.state.doc.toString()).toBe("theirs mine");
  });
});
