// Stable positions in a file's text, shared by presence (where a peer's
// caret is) and comments (which range a thread is about). Both store the
// encoded bytes rather than offsets, since offsets go stale with every edit
// that reaches the doc after them.
import { Cursor, type LoroDoc, type LoroText } from "loro-crdt";

/**
 * Encodes a Loro cursor at UTF-16 offset `pos` of `text`. The cursor sticks
 * to the character at `pos`, so text inserted right at `pos` lands before
 * it; at the end of the text it follows the end.
 */
export function encodeCursor(
  text: LoroText,
  pos: number,
): Uint8Array | undefined {
  const cursor = text.getCursor(pos);
  if (!cursor) return undefined;
  try {
    return cursor.encode();
  } finally {
    cursor.free();
  }
}

/**
 * Pins the non-empty range `[from, to)` of `text` with cursors on its first
 * and on its last character, so text typed right before or right after it
 * stays outside. Also returns the covered text.
 */
export function encodeRange(
  text: LoroText,
  from: number,
  to: number,
): { anchor: Uint8Array; head: Uint8Array; quote: string } | null {
  const content = text.toString();
  // Loro has no cursor inside a surrogate pair, so a range ending in an
  // emoji has to stick to the pair's first half.
  const low = content.charCodeAt(to - 1);
  const high = content.charCodeAt(to - 2);
  const last =
    low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
      ? to - 2
      : to - 1;
  const anchor = encodeCursor(text, from);
  const head = encodeCursor(text, last);
  if (!anchor || !head) return null;
  return { anchor, head, quote: content.slice(from, to) };
}

export interface CursorPos {
  offset: number;
  /**
   * The character the cursor stuck to has been deleted, and `offset` is
   * where it used to be.
   */
  deleted: boolean;
}

/**
 * Where an encoded cursor is in the current state of the text `textId`, or
 * null when it belongs to another text or cannot be resolved here.
 */
export function resolveCursor(
  doc: LoroDoc,
  textId: string,
  bytes: Uint8Array,
): CursorPos | null {
  let cursor: Cursor;
  try {
    cursor = Cursor.decode(bytes);
  } catch {
    return null;
  }
  try {
    if (cursor.containerId() !== textId) return null;
    // Throws when the cursor points at ops this doc has not received yet,
    // which happens when presence overtakes the matching doc update.
    const pos = doc.getCursorPos(cursor);
    if (!pos) return null;
    // Loro only hands back an updated cursor once the original character
    // is gone. Freed right away: callers never store it, the original
    // bytes keep resolving the same way.
    const deleted = pos.update !== undefined;
    pos.update?.free();
    return { offset: pos.offset, deleted };
  } catch {
    return null;
  } finally {
    cursor.free();
  }
}

/** Encodes a selection as stable Loro cursors (UTF-16 offsets in `text`). */
export function encodeSelection(
  text: LoroText,
  anchor: number,
  head: number,
): { anchor: Uint8Array; head: Uint8Array } | null {
  const a = encodeCursor(text, anchor);
  const h = anchor === head ? a : encodeCursor(text, head);
  return a && h ? { anchor: a, head: h } : null;
}

/** Resolves a peer's selection against the current state of `text`. */
export function resolveSelection(
  doc: LoroDoc,
  text: LoroText,
  state: { anchor?: Uint8Array; head?: Uint8Array },
): { anchor: number; head: number } | null {
  if (!state.anchor || !state.head) return null;
  const anchor = resolveCursor(doc, text.id, state.anchor);
  const head = resolveCursor(doc, text.id, state.head);
  if (anchor === null || head === null) return null;
  return { anchor: anchor.offset, head: head.offset };
}
