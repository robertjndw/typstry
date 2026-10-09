import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  Compartment,
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import type { LoroDoc, LoroText, UndoManager } from "loro-crdt";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { createLoroEditorState } from "./loro-binding";
import { editorBasics, fillParent } from "./setup";
import { loroUndo } from "./undo";

export interface EditorProps {
  doc: LoroDoc;
  text: LoroText;
  undoManager?: UndoManager;
  onReady?: (view: EditorView) => void;
  /** Swapped in place when it changes; memoize it per text. */
  extensions?: Extension;
  readOnly?: boolean;
  /** Maps diagnostics onto the current text; re-applied when it changes. */
  diagnostics?: (doc: Text) => Diagnostic[];
  className?: string;
}

export function Editor({
  doc,
  text,
  undoManager,
  onReady,
  extensions,
  readOnly = false,
  diagnostics,
  className,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [extra] = useState(() => new Compartment());
  // getText()/getContainerById() hand out a fresh wrapper per call, so key the
  // view on the container id rather than on object identity.
  const textId = text.id;
  const latest = useRef({ text, onReady, extensions, diagnostics });
  useLayoutEffect(() => {
    latest.current = { text, onReady, extensions, diagnostics };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { text, onReady, extensions, diagnostics } = latest.current;
    const view = new EditorView({
      parent: host,
      state: createLoroEditorState(
        { doc, text },
        {
          extensions: [
            editorBasics,
            typst(),
            fillParent,
            undoManager ? loroUndo({ doc, text, undoManager }) : [],
            readOnly
              ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
              : [],
            extra.of(extensions ?? []),
          ],
        },
      ),
    });
    viewRef.current = view;
    if (diagnostics)
      view.dispatch(setDiagnostics(view.state, diagnostics(view.state.doc)));
    onReady?.(view);
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [doc, textId, undoManager, readOnly, extra]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = extensions ?? [];
    if (extra.get(view.state) !== next)
      view.dispatch({ effects: extra.reconfigure(next) });
  }, [extensions, extra]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !diagnostics) return;
    view.dispatch(setDiagnostics(view.state, diagnostics(view.state.doc)));
  }, [diagnostics]);

  return <div ref={hostRef} className={cn("h-full min-h-0", className)} />;
}
