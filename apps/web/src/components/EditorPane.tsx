import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TreeID } from "loro-crdt";
import { EyeIcon, FileCodeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { fileCategory } from "@/assets/file-types";
import { AssetView } from "@/components/AssetView";
import { FileTabs } from "@/components/FileTabs";
import { getText } from "@/doc/fs-ops";
import { Editor } from "@/editor/Editor";
import { imageDrop } from "@/editor/image-drop";
import { typstLanguage } from "@/editor/language";
import { remoteCursors, reportSelection } from "@/editor/remote-cursors";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "@/presence/context";
import { useProject } from "@/project/context";
import { uploadReporting } from "@/project/tree";
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
  const { project, index, openFileId, undoManager, readOnly, assets } =
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

  const isTypst = fileCategory(path ?? "") === "typst";
  // Keyed on isTypst rather than the path, so a rename or move does not
  // reconfigure the editor.
  const extensions = useMemo(
    () => [
      isTypst ? typstLanguage : [],
      isTypst && text && openFileId && assets && !readOnly
        ? imageDrop({
            doc: project.doc,
            text,
            // Next to the edited file, so the bare name is the relative
            // path Typst resolves.
            upload: async (files) => {
              const parent =
                project.fs.getNodeByID(openFileId)?.parent()?.id ?? null;
              const created = await uploadReporting(
                project,
                assets,
                files,
                parent,
              );
              return created.map((c) => c.name);
            },
          })
        : [],
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
    ],
    [presence, project, text, openFileId, isTypst, assets, readOnly],
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

  let content;
  if (openFileId && openKind === "asset") {
    content = <AssetView id={openFileId} className="min-h-0 flex-1" />;
  } else if (!openFileId || !text) {
    content = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileCodeIcon className="size-6" />
        <p>Select a file to {readOnly ? "view it" : "start editing"}</p>
      </div>
    );
  } else {
    content = (
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
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <FileTabs
        trailing={
          readOnly && (
            <span className="flex shrink-0 items-center gap-1 px-3 text-xs text-muted-foreground">
              <EyeIcon className="size-3.5" />
              Read only
            </span>
          )
        }
      />
      {content}
    </div>
  );
}
