import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TreeID } from "loro-crdt";
import { EyeIcon, FileCodeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AssetView } from "@/components/AssetView";
import { getText } from "@/doc/fs-ops";
import { Editor } from "@/editor/Editor";
import { remoteCursors, reportSelection } from "@/editor/remote-cursors";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "@/presence/context";
import { useProject } from "@/project/context";
import type { CompilerClient } from "@/typst/compiler-client";
import type { ProjectDiagnostic } from "@/typst/diagnostics";
import { usePreviewDiagnostics } from "@/typst/hooks";
import { diagnosticRange, toCodeMirrorDiagnostics } from "@/typst/lint";

/** A request to select a diagnostic's range once its file is open. */
export interface RevealRequest {
  fileId: TreeID;
  diagnostic: ProjectDiagnostic;
  /** Distinguishes repeated clicks on the same diagnostic. */
  seq: number;
}

export interface EditorPaneProps {
  compiler?: CompilerClient | null;
  reveal?: RevealRequest | null;
  className?: string;
}

export function EditorPane({ compiler, reveal, className }: EditorPaneProps) {
  const { project, index, mainFile, openFileId, undoManager, readOnly } =
    useProject();
  const presence = usePresenceContext()?.presence;
  const openKind = openFileId ? index.byId.get(openFileId)?.kind : undefined;
  // The store only reports an open id that resolves to a live node, so
  // getText cannot throw for a text file.
  const text = useMemo(
    () =>
      openFileId && openKind === "text" ? getText(project, openFileId) : null,
    [project, openFileId, openKind],
  );
  const path = openFileId ? index.byId.get(openFileId)?.path : undefined;

  const extensions = useMemo(
    () =>
      presence && text && openFileId
        ? [
            remoteCursors({
              doc: project.doc,
              text,
              fileId: openFileId,
              source: presence,
            }),
            reportSelection(presence, openFileId, text),
          ]
        : [],
    [presence, project, text, openFileId],
  );

  const previewDiagnostics = usePreviewDiagnostics(compiler ?? null);
  const diagnostics = useMemo(
    () => (doc: Text) =>
      path && previewDiagnostics
        ? toCodeMirrorDiagnostics(previewDiagnostics, path, doc)
        : [],
    [previewDiagnostics, path],
  );

  const [view, setView] = useState<EditorView | null>(null);
  const revealed = useRef(-1);
  useEffect(() => {
    if (!view || !reveal || reveal.fileId !== openFileId) return;
    if (revealed.current === reveal.seq) return;
    revealed.current = reveal.seq;
    const range = diagnosticRange(reveal.diagnostic, view.state.doc);
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      scrollIntoView: true,
    });
    view.focus();
  }, [view, reveal, openFileId]);

  if (openFileId && openKind === "asset") {
    return <AssetView id={openFileId} className={className} />;
  }

  if (!openFileId || !text) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <FileCodeIcon className="size-6" />
        <p>Select a file to {readOnly ? "view it" : "start editing"}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="truncate font-mono" title={path}>
          {path}
        </span>
        {openFileId === mainFile && (
          <span className="rounded bg-primary/10 px-1 text-[10px] leading-4 font-medium text-primary uppercase">
            main
          </span>
        )}
        {readOnly && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <EyeIcon className="size-3.5" />
            Read only
          </span>
        )}
      </div>
      <Editor
        doc={project.doc}
        text={text}
        undoManager={undoManager}
        readOnly={readOnly}
        extensions={extensions}
        diagnostics={diagnostics}
        onReady={setView}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
