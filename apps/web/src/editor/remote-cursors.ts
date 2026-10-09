import {
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { LoroDoc, LoroEventBatch, LoroText, TreeID } from "loro-crdt";

import {
  resolveSelection,
  type Presence,
  type PresenceSource,
  type RemotePeer,
} from "@/presence/presence";

import { loroRemote } from "./loro-binding";

export interface RemoteCursorsConfig {
  doc: LoroDoc;
  text: LoroText;
  /** Only peers with this file open are drawn. */
  fileId: TreeID;
  source: PresenceSource;
}

class CaretWidget extends WidgetType {
  readonly name: string;
  readonly color: string;
  /** Bumped when the peer moves, which re-creates the DOM and replays the label. */
  readonly moved: number;

  constructor(name: string, color: string, moved: number) {
    super();
    this.name = name;
    this.color = color;
    this.moved = moved;
  }

  eq(other: CaretWidget): boolean {
    return (
      other.name === this.name &&
      other.color === this.color &&
      other.moved === this.moved
    );
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-remote-caret";
    caret.style.borderLeftColor = this.color;
    caret.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "cm-remote-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const setRemoteCursors = StateEffect.define<DecorationSet>();

const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Mapping keeps carets in place for edits that happen between two
    // recomputes, e.g. while typing locally.
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursors)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.baseTheme({
  ".cm-remote-caret": {
    position: "relative",
    borderLeft: "2px solid",
    marginLeft: "-1px",
    marginRight: "-1px",
    pointerEvents: "auto",
  },
  // A 2px caret is too thin to hover; widen the hit area for the name.
  ".cm-remote-caret::before": {
    content: '""',
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "-4px",
    width: "8px",
  },
  ".cm-remote-label": {
    position: "absolute",
    bottom: "100%",
    left: "-2px",
    padding: "0 4px",
    borderRadius: "3px 3px 3px 0",
    color: "#fff",
    fontSize: "11px",
    lineHeight: "16px",
    fontFamily: "system-ui, sans-serif",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: "10",
    animation: "cm-remote-label-fade 2s ease-in forwards",
  },
  ".cm-remote-caret:hover .cm-remote-label": {
    animation: "none",
    opacity: "1",
  },
  "@keyframes cm-remote-label-fade": {
    "0%, 75%": { opacity: "1" },
    "100%": { opacity: "0" },
  },
});

function cursorKey(peer: RemotePeer): string {
  return `${peer.anchor?.join(",")}|${peer.head?.join(",")}`;
}

/**
 * Draws other peers' carets and selections in this file. Positions come
 * from Loro cursors, so they stay attached to the same characters across
 * concurrent edits.
 */
export function remoteCursors(config: RemoteCursorsConfig): Extension {
  const { doc, text, fileId, source } = config;

  const plugin = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly unsubscribes: (() => void)[];
      private readonly moved = new Map<string, { key: string; n: number }>();
      private queued = false;
      private destroyed = false;

      constructor(view: EditorView) {
        this.view = view;
        this.unsubscribes = [
          source.subscribe(() => this.schedule()),
          doc.subscribe((batch: LoroEventBatch) => {
            if (batch.events.some((e) => e.target === text.id)) this.schedule();
          }),
        ];
        this.schedule();
      }

      destroy() {
        this.destroyed = true;
        for (const unsubscribe of this.unsubscribes) unsubscribe();
      }

      // Doc events fire while the binding is still inside its own update or
      // dispatch, and CodeMirror forbids nested dispatches. Deferring also
      // lets the binding apply the text change first, so offsets line up.
      private schedule() {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (!this.destroyed) this.recompute();
        });
      }

      private recompute() {
        const peers = source.getPeers();
        const length = this.view.state.doc.length;
        const ranges: Range<Decoration>[] = [];
        const seen = new Set(peers.map((p) => p.peerId));
        for (const id of this.moved.keys()) {
          if (!seen.has(id)) this.moved.delete(id);
        }

        for (const peer of peers) {
          if (peer.fileId !== fileId) continue;
          const sel = resolveSelection(doc, text, peer);
          if (!sel) continue;
          const anchor = Math.min(sel.anchor, length);
          const head = Math.min(sel.head, length);
          const key = cursorKey(peer);
          const prev = this.moved.get(peer.peerId);
          const n = !prev ? 0 : prev.key === key ? prev.n : prev.n + 1;
          this.moved.set(peer.peerId, { key, n });

          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          if (from < to) {
            ranges.push(
              Decoration.mark({
                class: "cm-remote-selection",
                attributes: { style: `background-color: ${peer.color}33` },
              }).range(from, to),
            );
          }
          ranges.push(
            Decoration.widget({
              widget: new CaretWidget(peer.name, peer.color, n),
              side: 1,
            }).range(head),
          );
        }
        // Nothing to draw and nothing drawn: spare every keystroke a
        // transaction when working alone.
        if (
          ranges.length === 0 &&
          this.view.state.field(remoteCursorField).size === 0
        ) {
          return;
        }
        this.view.dispatch({
          effects: setRemoteCursors.of(Decoration.set(ranges, true)),
        });
      }
    },
  );

  return [remoteCursorField, plugin, theme];
}

/** For tests and debugging: the carets currently drawn, by position. */
export function remoteCaretPositions(
  view: EditorView,
): { name: string; pos: number }[] {
  const out: { name: string; pos: number }[] = [];
  const set = view.state.field(remoteCursorField, false) ?? Decoration.none;
  set.between(0, view.state.doc.length, (from, _to, deco) => {
    const widget: unknown = deco.spec.widget;
    if (widget instanceof CaretWidget)
      out.push({ name: widget.name, pos: from });
  });
  return out;
}

/**
 * Publishes this editor's main selection. Remote edits are skipped on
 * purpose: Loro cursors already follow them, and re-publishing on every
 * remote keystroke would multiply presence traffic by the number of peers.
 */
export function reportSelection(
  presence: Pick<Presence, "setSelection">,
  fileId: TreeID,
  text: LoroText,
): Extension {
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        const { anchor, head } = view.state.selection.main;
        presence.setSelection(fileId, text, anchor, head);
      }

      update(update: ViewUpdate) {
        const local = update.transactions.some(
          (tr) => tr.selection || (tr.docChanged && !tr.annotation(loroRemote)),
        );
        if (!local) return;
        const { anchor, head } = update.state.selection.main;
        presence.setSelection(fileId, text, anchor, head);
      }
    },
  );
}
