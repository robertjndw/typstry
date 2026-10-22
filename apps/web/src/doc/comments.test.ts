import { LoroText, UndoManager, type TreeID } from "loro-crdt";

import {
  addComment,
  deleteComment,
  listThreads,
  MAX_COMMENT_CHARS,
  MAX_QUOTE_CHARS,
  reopenThread,
  reply,
  resolveAnchor,
  resolveThread,
  type Comment,
} from "./comments";
import { createFile, deleteNode, getText } from "./fs-ops";
import { computeHistory, tagAt } from "./history";
import { restoreVersion, versionAt } from "./restore";
import {
  COMMENT_ORIGIN,
  initProject,
  NODE,
  PEER_INFO_ORIGIN,
  type ProjectDoc,
} from "./schema";
import { fork, newProject, sync } from "./test-utils";
import { saveVersion } from "./versions";

const ADA = { name: "Ada", color: "#3366cc" };
const GRACE = { name: "Grace", color: "#cc6633" };

function setup(content = "hello brave new world") {
  const a = initProject(newProject(1), { title: "T", starter: false });
  const file = createFile(a, null, "main.typ", "text", content);
  const b = fork(a, 2);
  return { a, b, file };
}

/** Comments on the word at `[from, to)` of `file`. */
function comment(
  project: ProjectDoc,
  file: TreeID,
  from: number,
  to: number,
  body = "Why?",
  author = ADA,
): string {
  return addComment(project, {
    fileId: file,
    text: getText(project, file),
    from,
    to,
    body,
    ...author,
  });
}

function rootOf(project: ProjectDoc, id: string): Comment {
  const thread = listThreads(project).find((t) => t.id === id);
  if (!thread) throw new Error(`no thread ${id}`);
  return thread.root;
}

function anchored(project: ProjectDoc, file: TreeID, id: string) {
  const range = resolveAnchor(project, rootOf(project, id));
  return range && getText(project, file).toString().slice(range.from, range.to);
}

describe("comment threads", () => {
  it("converges add, reply, resolve, reopen and delete across peers", () => {
    const { a, b, file } = setup();
    const id = comment(a, file, 6, 11, "  Too brave?  ");
    sync(a, b);

    reply(b, id, { body: "Just right.", ...GRACE, now: 2 });
    reply(a, id, { body: "Fair.", ...ADA, now: 1 });
    sync(a, b);
    for (const p of [a, b]) {
      const [thread] = listThreads(p);
      expect(thread!.id).toBe(id);
      expect(thread!.root).toMatchObject({
        thread: null,
        body: "Too brave?",
        quote: "brave",
        name: "Ada",
        fileId: file,
      });
      expect(thread!.replies.map((r) => r.body)).toEqual([
        "Fair.",
        "Just right.",
      ]);
      expect(thread!.resolvedAt).toBeNull();
    }

    resolveThread(b, id, { now: 1234 });
    sync(a, b);
    expect(listThreads(a)[0]!.resolvedAt).toBe(1234);
    reopenThread(a, id);
    sync(a, b);
    expect(listThreads(b)[0]!.resolvedAt).toBeNull();

    const second = comment(b, file, 0, 5, "Greeting");
    sync(a, b);
    expect(listThreads(a).map((t) => t.id)).toEqual([id, second]);

    resolveThread(a, id);
    deleteComment(a, id);
    sync(a, b);
    for (const p of [a, b]) {
      expect(listThreads(p).map((t) => t.id)).toEqual([second]);
      // The replies and the resolved mark went with the root.
      expect(p.comments.length).toBe(1);
      expect(p.resolvedComments.keys()).toEqual([]);
    }
  });

  it("deletes a single reply without its thread", () => {
    const { a, file } = setup();
    const id = comment(a, file, 0, 5);
    const first = reply(a, id, { body: "One", ...ADA });
    reply(a, id, { body: "Two", ...ADA });
    deleteComment(a, first);
    expect(listThreads(a)[0]!.replies.map((r) => r.body)).toEqual(["Two"]);
  });

  it("drops a reply written concurrently with deleting its thread", () => {
    const { a, b, file } = setup();
    const id = comment(a, file, 0, 5);
    sync(a, b);
    deleteComment(a, id);
    reply(b, id, { body: "Too late", ...GRACE });
    sync(a, b);
    expect(listThreads(a)).toEqual([]);
    expect(listThreads(b)).toEqual([]);
  });

  it("takes the author from the op id, not from anything stored", () => {
    const { a, b, file } = setup();
    const id = comment(b, file, 0, 5, "By B", ADA);
    sync(a, b);
    const response = reply(a, id, { body: "By A", ...GRACE });
    sync(a, b);
    const [thread] = listThreads(a);
    expect(thread!.root.peer).toBe("2");
    expect(thread!.root.name).toBe("Ada");
    expect(thread!.replies[0]!.peer).toBe("1");
    expect(id).toMatch(/@2$/);
    expect(response).toMatch(/@1$/);
  });

  it("skips malformed records", () => {
    const { a, file } = setup();
    const id = comment(a, file, 0, 5);
    const good = a.comments.get(0) as Record<string, unknown>;
    const bad: unknown[] = [
      "garbage",
      null,
      [good],
      { ...good, body: "" },
      { ...good, body: "x".repeat(MAX_COMMENT_CHARS + 1) },
      { ...good, color: "red" },
      { ...good, name: "   " },
      { ...good, anchor: "not bytes" },
      { ...good, head: null },
      { ...good, fileId: "main.typ" },
      { ...good, textId: 7 },
      { ...good, quote: "q".repeat(MAX_QUOTE_CHARS + 1) },
      { ...good, createdAt: "yesterday" },
      // Finite, but past what Date can show.
      { ...good, createdAt: 1e20 },
      { ...good, thread: "not an id" },
      // A reply whose thread does not exist.
      { ...good, thread: "999@1" },
    ];
    for (const value of bad) a.comments.push(value as never);
    a.comments.push({ ...good, body: "  Kept  " });
    a.doc.commit();

    const threads = listThreads(a);
    expect(threads.map((t) => t.root.body)).toEqual(["Why?", "Kept"]);
    expect(threads[0]!.id).toBe(id);
    expect(threads.every((t) => t.replies.length === 0)).toBe(true);
  });

  it("validates what it writes", () => {
    const { a, file } = setup();
    const text = getText(a, file);
    const base = { fileId: file, text, from: 0, to: 5, body: "Ok", ...ADA };
    expect(() => addComment(a, { ...base, body: " " })).toThrow();
    expect(() => addComment(a, { ...base, color: "blue" })).toThrow();
    expect(() => addComment(a, { ...base, from: 3, to: 3 })).toThrow();
    expect(() => addComment(a, { ...base, to: text.length + 1 })).toThrow();
    const other = createFile(a, null, "other.typ", "text", "other");
    expect(() => addComment(a, { ...base, fileId: other })).toThrow();
    expect(() => reply(a, "5@1", { body: "Hi", ...ADA })).toThrow();
    expect(a.comments.length).toBe(0);

    const long = "é".repeat(MAX_QUOTE_CHARS + 50);
    const big = createFile(a, null, "big.typ", "text", long);
    const id = comment(a, big, 0, long.length);
    expect(rootOf(a, id).quote).toBe("é".repeat(MAX_QUOTE_CHARS));
  });

  it("stays out of the editor's undo, without taking pending edits", () => {
    const { a, file } = setup("hello");
    const undo = new UndoManager(a.doc, {
      excludeOriginPrefixes: [PEER_INFO_ORIGIN],
      mergeInterval: 0,
    });
    // Typed but not committed yet when the comment is written.
    getText(a, file).insert(5, " world");
    const id = comment(a, file, 0, 5);
    reply(a, id, { body: "Sure", ...ADA });
    resolveThread(a, id);

    expect(undo.undo()).toBe(true);
    expect(getText(a, file).toString()).toBe("hello");
    expect(listThreads(a)).toHaveLength(1);
    expect(listThreads(a)[0]!.resolvedAt).not.toBeNull();
    expect(undo.canUndo()).toBe(false);

    deleteComment(a, id);
    expect(undo.canUndo()).toBe(false);
    expect(COMMENT_ORIGIN.startsWith(PEER_INFO_ORIGIN)).toBe(true);
  });
});

describe("comment anchors", () => {
  it("survive concurrent edits inside and around the range", () => {
    const { a, b, file } = setup("hello brave new world");
    const id = comment(a, file, 6, 11);
    sync(a, b);

    getText(a, file).insert(0, ">> ");
    a.doc.commit();
    // Inside the range, between "br" and "ave".
    getText(b, file).insert(8, "XX");
    b.doc.commit();
    getText(b, file).delete(13, 4);
    b.doc.commit();
    sync(a, b);

    expect(getText(a, file).toString()).toBe(">> hello brXXave world");
    expect(anchored(a, file, id)).toBe("brXXave");
    expect(anchored(b, file, id)).toBe("brXXave");
  });

  it("keep text typed right at either boundary outside", () => {
    const { a, b, file } = setup("hello brave new world");
    const id = comment(a, file, 6, 11);
    sync(a, b);
    getText(a, file).insert(11, "R");
    a.doc.commit();
    getText(b, file).insert(6, "L");
    b.doc.commit();
    sync(a, b);
    expect(getText(a, file).toString()).toBe("hello LbraveR new world");
    expect(anchored(a, file, id)).toBe("brave");

    // Also when the range ends the text.
    const tail = comment(a, file, 18, 23);
    expect(anchored(a, file, tail)).toBe("world");
    getText(a, file).insert(23, "!");
    a.doc.commit();
    expect(anchored(a, file, tail)).toBe("world");
  });

  it("shrink when the edges are deleted", () => {
    const { a, file } = setup("hello brave new world");
    const id = comment(a, file, 6, 11);
    const text = getText(a, file);
    text.delete(10, 1); // the last "e"
    text.delete(6, 1); // the first "b"
    a.doc.commit();
    expect(anchored(a, file, id)).toBe("rav");
  });

  it("cover a whole emoji at either end", () => {
    const { a, file } = setup("say 👋 to 🌍 now");
    const id = comment(a, file, 4, 11);
    expect(anchored(a, file, id)).toBe("👋 to 🌍");
  });

  it("detach when the whole range is deleted", () => {
    const { a, b, file } = setup("hello brave new world");
    const id = comment(a, file, 6, 11);
    sync(a, b);
    getText(b, file).delete(5, 7);
    b.doc.commit();
    sync(a, b);
    expect(resolveAnchor(a, rootOf(a, id))).toBeNull();
    // The quote is what is left to show.
    expect(rootOf(a, id).quote).toBe("brave");
  });

  it("detach when the file is deleted, even after restoring it", () => {
    const { a, b, file } = setup();
    const id = comment(a, file, 0, 5);
    const version = saveVersion(a, "Before");
    sync(a, b);
    deleteNode(b, file);
    sync(a, b);
    expect(resolveAnchor(a, rootOf(a, id))).toBeNull();

    // A deleted node comes back under a new id and with new text.
    restoreVersion(a, versionAt(a, version.frontiers), "Before");
    expect(a.liveNode(file)).toBeNull();
    expect(resolveAnchor(a, rootOf(a, id))).toBeNull();
  });

  it("detach when the file's content is replaced or not text", () => {
    const { a, b, file } = setup();
    const id = comment(a, file, 0, 5);
    sync(a, b);
    const replaced = b
      .liveNode(file)!
      .data.setContainer(NODE.content, new LoroText());
    replaced.insert(0, "hello again");
    b.doc.commit();
    sync(a, b);
    expect(resolveAnchor(a, rootOf(a, id))).toBeNull();

    a.liveNode(file)!.data.set(NODE.kind, "asset");
    a.doc.commit();
    expect(resolveAnchor(a, rootOf(a, id))).toBeNull();
  });

  it("detach anchors whose ops have not arrived yet", () => {
    const { a, b, file } = setup();
    getText(b, file).insert(0, "new ");
    b.doc.commit();
    const id = comment(b, file, 0, 3);
    // Only the comment reaches A, not the text it points into.
    const root = rootOf(b, id);
    expect(resolveAnchor(a, root)).toBeNull();
  });

  it("do not rewrite the record when resolving moved cursors", () => {
    const { a, file } = setup("hello brave new world");
    const id = comment(a, file, 6, 11);
    getText(a, file).delete(6, 1);
    a.doc.commit();
    const before = a.doc.oplogVersion().toJSON();
    expect(anchored(a, file, id)).toBe("rave");
    expect(a.doc.oplogVersion().toJSON()).toEqual(before);
  });
});

describe("comments in history", () => {
  it("are bookkeeping, not edit sessions, and keep the tag", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
      const { a, file } = setup();
      vi.setSystemTime(new Date("2026-10-10T10:10:00Z"));
      getText(a, file).insert(0, "edit ");
      a.doc.commit();
      const tag = saveVersion(a, "Tagged");

      vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
      const id = comment(a, file, 0, 4);
      reply(a, id, { body: "Agreed", ...ADA });
      resolveThread(a, id);
      reopenThread(a, id);
      deleteComment(a, id);
      comment(a, file, 0, 4);

      expect(tagAt(a)?.id).toBe(tag.id);
      const last = computeHistory(a).at(-1)!;
      expect(last.end).toBe(Date.parse("2026-10-10T10:10:00Z"));
      expect(last.files).toEqual([file]);
    } finally {
      vi.useRealTimers();
    }
  });
});
