import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import { languageFor } from "./language";
import { fillParent } from "./setup";
import { editorTheme, syntaxTheme } from "./theme";

export interface DiffViewProps {
  /** The older text. */
  original: string;
  /** The newer text, shown with deletions from `original` interleaved. */
  text: string;
  /** Picks the syntax highlighting. */
  path: string;
  className?: string;
}

/** Read-only unified diff of two texts. */
export function DiffView({ original, text, path, className }: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          languageFor(path),
          fillParent,
          editorTheme,
          syntaxTheme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          unifiedMergeView({
            original,
            mergeControls: false,
            collapseUnchanged: { margin: 3, minSize: 6 },
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [original, text, path]);

  return (
    <div
      ref={hostRef}
      aria-label="Changes"
      className={cn("h-full min-h-0", className)}
    />
  );
}
