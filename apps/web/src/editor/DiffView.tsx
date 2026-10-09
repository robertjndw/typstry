import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import { fillParent } from "./setup";

export interface DiffViewProps {
  /** The older text. */
  original: string;
  /** The newer text, shown with deletions from `original` interleaved. */
  text: string;
  className?: string;
}

/** Read-only unified diff of two texts. */
export function DiffView({ original, text, className }: DiffViewProps) {
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
          typst(),
          fillParent,
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
  }, [original, text]);

  return (
    <div
      ref={hostRef}
      aria-label="Changes"
      className={cn("h-full min-h-0", className)}
    />
  );
}
