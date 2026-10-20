// Comment threads on a range of a text file. Each comment or reply is a
// plain value appended to the root `comments` list and never changed
// afterwards:
//
//   { thread: string | null, fileId: TreeID, textId: ContainerID,
//     anchor: Uint8Array, head: Uint8Array, quote: string, body: string,
//     createdAt: number (unix ms), name: string, color: string }
//
// A thread root has `thread: null`; a reply names its root by the root's
// list element id ("counter@peer", like deletedVersions in versions.ts) and
// repeats the root's location, so every record parses the same way. The
// author is the peer of that element id. `name` and `color` are only what
// the author claimed when writing, for the UI to show next to what the
// roster vouches for (see authorIdentity in project/history-items.ts).
//
// The root `resolvedComments` map holds resolved threads, keyed by the
// root's element id with the time as value, so resolving never touches the
// immutable record. Deleting a comment removes its element; a root takes
// its replies with it.
//
// Both containers hold plain values only, which keeps them out of edit
// history (META_CONTAINERS in history.ts) and out of the editor's undo
// (COMMENT_ORIGIN).
import {
  LoroText,
  type ContainerID,
  type PeerID,
  type TreeID,
} from "loro-crdt";

import { isValidColor, normalizeName } from "@/presence/identity";

import { encodeCursor, resolveCursor } from "./cursors";
import { getText } from "./fs-ops";
import { COMMENT_ORIGIN, NODE, type ProjectDoc } from "./schema";

export const MAX_COMMENT_CHARS = 5000;
/** Code points of the commented text kept for when the anchor is lost. */
export const MAX_QUOTE_CHARS = 200;

export const COMMENT = {
  thread: "thread",
  fileId: "fileId",
  textId: "textId",
  anchor: "anchor",
  head: "head",
  quote: "quote",
  body: "body",
  createdAt: "createdAt",
  name: "name",
  color: "color",
} as const;

export interface Comment {
  /** The record's list element id, which replies and deleting refer to. */
  id: string;
  /** The root's id for a reply, null for the root itself. */
  thread: string | null;
  /** Who wrote it, from the op id rather than anything stored. */
  peer: PeerID;
  fileId: TreeID;
  /** The text container the anchors were taken in. */
  textId: ContainerID;
  /** Encoded cursors on the first and on the last commented character. */
  anchor: Uint8Array;
  head: Uint8Array;
  quote: string;
  body: string;
  createdAt: number;
  name: string;
  color: string;
}

export interface CommentThread {
  /** The root comment's id. */
  id: string;
  root: Comment;
  /** Oldest first. */
  replies: Comment[];
  resolvedAt: number | null;
}

export interface CommentAuthor {
  name: string;
  color: string;
}

/**
 * Trims a comment body and checks it is 1 to MAX_COMMENT_CHARS UTF-16
 * units, the unit the editor's text field counts in. Null when unusable.
 */
export function normalizeCommentBody(raw: string): string | null {
  const value = raw.trim();
  return value.length >= 1 && value.length <= MAX_COMMENT_CHARS ? value : null;
}

const ELEMENT_ID = /^\d+@\d+$/;

function isElementId(value: unknown): value is string {
  return typeof value === "string" && ELEMENT_ID.test(value);
}

function elementId(project: ProjectDoc, index: number): string | undefined {
  const id = project.comments.getIdAt(index);
  return id && `${id.counter}@${id.peer}`;
}

/**
 * Validates a stored record. Peers write the list directly, so anything
 * malformed is dropped rather than repaired, and unknown fields are not
 * carried over.
 */
function parseComment(
  id: string,
  peer: PeerID,
  value: unknown,
): Comment | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  const thread = v[COMMENT.thread];
  const fileId = v[COMMENT.fileId];
  const textId = v[COMMENT.textId];
  const anchor = v[COMMENT.anchor];
  const head = v[COMMENT.head];
  const quote = v[COMMENT.quote];
  const body = v[COMMENT.body];
  const createdAt = v[COMMENT.createdAt];
  const name = v[COMMENT.name];
  const color = v[COMMENT.color];
  if (thread !== null && !isElementId(thread)) return null;
  if (!isElementId(fileId)) return null;
  if (typeof textId !== "string" || !textId.startsWith("cid:")) return null;
  if (!(anchor instanceof Uint8Array) || !(head instanceof Uint8Array))
    return null;
  if (typeof quote !== "string" || [...quote].length > MAX_QUOTE_CHARS)
    return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof body !== "string" || typeof name !== "string") return null;
  if (!isValidColor(color)) return null;
  const text = normalizeCommentBody(body);
  const shownName = normalizeName(name);
  if (text === null || !shownName) return null;
  return {
    id,
    thread,
    peer,
    fileId: fileId as TreeID,
    textId: textId as ContainerID,
    anchor,
    head,
    quote,
    body: text,
    createdAt,
    name: shownName,
    color,
  };
}

function readComments(project: ProjectDoc): Comment[] {
  const out: Comment[] = [];
  project.comments.toArray().forEach((value, index) => {
    const opId = project.comments.getIdAt(index);
    if (!opId) return;
    const comment = parseComment(
      `${opId.counter}@${opId.peer}`,
      opId.peer,
      value,
    );
    if (comment) out.push(comment);
  });
  return out;
}

function byCreation(a: Comment, b: Comment): number {
  // Concurrent comments can carry the same time, and every peer has to
  // show them in the same order.
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * All well-formed threads, oldest first. Replies whose root is gone (or
 * was never valid) are dropped, which is also how a reply written
 * concurrently with deleting its thread disappears.
 */
export function listThreads(project: ProjectDoc): CommentThread[] {
  const comments = readComments(project).sort(byCreation);
  const threads = new Map<string, CommentThread>();
  for (const comment of comments) {
    if (comment.thread !== null) continue;
    const resolvedAt: unknown = project.resolvedComments.get(comment.id);
    threads.set(comment.id, {
      id: comment.id,
      root: comment,
      replies: [],
      resolvedAt:
        typeof resolvedAt === "number" && Number.isFinite(resolvedAt)
          ? resolvedAt
          : null,
    });
  }
  for (const comment of comments) {
    if (comment.thread === null) continue;
    threads.get(comment.thread)?.replies.push(comment);
  }
  return [...threads.values()];
}

function validAuthor(author: CommentAuthor): CommentAuthor {
  const name = normalizeName(author.name);
  if (!name || !isValidColor(author.color)) {
    throw new Error("Comment author needs a name and a #rrggbb color");
  }
  return { name, color: author.color };
}

function validBody(raw: string): string {
  const body = normalizeCommentBody(raw);
  if (body === null) {
    throw new Error(`Comment must be 1 to ${MAX_COMMENT_CHARS} characters`);
  }
  return body;
}

function truncateQuote(text: string): string {
  const points = [...text];
  return points.length <= MAX_QUOTE_CHARS
    ? text
    : points.slice(0, MAX_QUOTE_CHARS).join("");
}

function push(
  project: ProjectDoc,
  record: Record<string, unknown>,
  message: string,
): string {
  project.comments.push(record);
  project.doc.commit({ message, origin: COMMENT_ORIGIN });
  return elementId(project, project.comments.length - 1)!;
}

/**
 * Starts a thread on `[from, to)` (UTF-16 offsets) of the text file
 * `fileId`, whose content `text` is. Returns the new thread's id.
 */
export function addComment(
  project: ProjectDoc,
  input: CommentAuthor & {
    fileId: TreeID;
    text: LoroText;
    from: number;
    to: number;
    body: string;
    now?: number;
  },
): string {
  const { fileId, text, from, to } = input;
  if (getText(project, fileId).id !== text.id) {
    throw new Error("Text does not belong to the file");
  }
  if (!(Number.isInteger(from) && Number.isInteger(to)))
    throw new Error("Comment range must be whole offsets");
  if (from < 0 || from >= to || to > text.length) {
    throw new Error("Comment range must cover some text");
  }
  const body = validBody(input.body);
  const author = validAuthor(input);
  // Pending edits are not part of the comment; committed under its origin
  // they would also drop out of the editor's undo.
  project.doc.commit();
  // The anchors stick to the first and the last commented character, so
  // text typed right before or right after the range stays outside it.
  const anchor = encodeCursor(text, from);
  const head = encodeCursor(text, to - 1);
  if (!anchor || !head) throw new Error("Comment range must cover some text");
  return push(
    project,
    {
      [COMMENT.thread]: null,
      [COMMENT.fileId]: fileId,
      [COMMENT.textId]: text.id,
      [COMMENT.anchor]: anchor,
      [COMMENT.head]: head,
      [COMMENT.quote]: truncateQuote(text.toString().slice(from, to)),
      [COMMENT.body]: body,
      [COMMENT.createdAt]: input.now ?? Date.now(),
      [COMMENT.name]: author.name,
      [COMMENT.color]: author.color,
    },
    "add comment",
  );
}

function findThread(project: ProjectDoc, threadId: string): Comment {
  const root = readComments(project).find((c) => c.id === threadId);
  if (!root || root.thread !== null) {
    throw new Error(`No comment thread ${threadId}`);
  }
  return root;
}

/** Appends a reply to the thread `threadId`; returns the reply's id. */
export function reply(
  project: ProjectDoc,
  threadId: string,
  input: CommentAuthor & { body: string; now?: number },
): string {
  const root = findThread(project, threadId);
  const body = validBody(input.body);
  const author = validAuthor(input);
  project.doc.commit();
  return push(
    project,
    {
      [COMMENT.thread]: root.id,
      [COMMENT.fileId]: root.fileId,
      [COMMENT.textId]: root.textId,
      [COMMENT.anchor]: root.anchor,
      [COMMENT.head]: root.head,
      [COMMENT.quote]: root.quote,
      [COMMENT.body]: body,
      [COMMENT.createdAt]: input.now ?? Date.now(),
      [COMMENT.name]: author.name,
      [COMMENT.color]: author.color,
    },
    "reply to comment",
  );
}

export function resolveThread(
  project: ProjectDoc,
  threadId: string,
  options: { now?: number } = {},
): void {
  findThread(project, threadId);
  project.doc.commit();
  project.resolvedComments.set(threadId, options.now ?? Date.now());
  project.doc.commit({ message: "resolve comment", origin: COMMENT_ORIGIN });
}

export function reopenThread(project: ProjectDoc, threadId: string): void {
  project.doc.commit();
  project.resolvedComments.delete(threadId);
  project.doc.commit({ message: "reopen comment", origin: COMMENT_ORIGIN });
}

/**
 * Removes a comment for everyone. A thread root goes together with its
 * replies and its resolved mark, all in one commit.
 */
export function deleteComment(project: ProjectDoc, id: string): void {
  project.doc.commit();
  const list = project.comments;
  const doomed: number[] = [];
  let isRoot = false;
  list.toArray().forEach((value, index) => {
    const thread = threadOf(value);
    if (elementId(project, index) === id) {
      doomed.push(index);
      isRoot = thread === null;
    } else if (thread === id) {
      doomed.push(index);
    }
  });
  if (doomed.length === 0) return;
  // From the back, so the indexes still to delete stay put.
  for (const index of doomed.reverse()) list.delete(index, 1);
  if (isRoot && project.resolvedComments.get(id) !== undefined)
    project.resolvedComments.delete(id);
  project.doc.commit({ message: "delete comment", origin: COMMENT_ORIGIN });
}

/** A record's `thread` field without validating the rest of it. */
function threadOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[COMMENT.thread]
    : undefined;
}

/**
 * Where the comment's range is in the file's current text, or null when it
 * is detached: the file is gone or no longer text, its content is another
 * container than the one the anchors were taken in (a restore or a remote
 * replacement), the anchors cannot be resolved here yet, or everything in
 * the range was deleted.
 */
export function resolveAnchor(
  project: ProjectDoc,
  comment: Pick<Comment, "fileId" | "textId" | "anchor" | "head">,
): { from: number; to: number } | null {
  const node = project.liveNode(comment.fileId);
  if (!node || node.data.get(NODE.kind) !== "text") return null;
  const content: unknown = node.data.get(NODE.content);
  if (!(content instanceof LoroText) || content.id !== comment.textId)
    return null;
  const { doc } = project;
  const start = resolveCursor(doc, comment.textId, comment.anchor);
  const end = resolveCursor(doc, comment.textId, comment.head);
  if (!start || !end) return null;
  // The head sticks to the last character in the range, so the range ends
  // right after it. Once that character is deleted, Loro reports where it
  // used to be, which is already the end. Nothing is written back: the
  // records are immutable and the original bytes keep resolving.
  const from = start.offset;
  const to = end.deleted ? end.offset : end.offset + 1;
  return to > from ? { from, to } : null;
}
