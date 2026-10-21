import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TreeID } from "loro-crdt";
import { EyeIcon, FileCodeIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { fileCategory } from "@/assets/file-types";
import { AssetView } from "@/components/AssetView";
import { FileTabs } from "@/components/FileTabs";
import { EntryIcon } from "@/components/FileTree";
import { ShortcutKeys } from "@/components/ShortcutKeys";
import { basename, dirname } from "@/doc/names";
import { getText } from "@/doc/fs-ops";
import { Editor } from "@/editor/Editor";
import { revealScroll } from "@/editor/reveal-scroll";
import { imageDrop } from "@/editor/image-drop";
import { typstLanguage } from "@/editor/language";
import { remoteCursors, reportSelection } from "@/editor/remote-cursors";
import type { TinymistClient } from "@/lsp/tinymist-client";
import { SHORTCUTS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "@/presence/context";
import { useProject } from "@/project/context";
import { uploadReporting } from "@/project/tree";
import type { CompilerClient } from "@/typst/compiler-client";
import { usePreviewDiagnostics } from "@/typst/hooks";
import { sourceRangeToOffsets, toCodeMirrorDiagnostics } from "@/typst/lint";
import type { SourceRange } from "@/typst/protocol";

/** Where to select in a revealed file. */
export type RevealTarget =
  /** Typst's line and code point column, as diagnostics report it. */
  | { kind: "source"; range: SourceRange }
  /** UTF-16 offsets, which is what CodeMirror and Loro index by. */
  | { kind: "offset"; from: number; to: number };

function clampRange(from: number, to: number, length: number) {
  const clamp = (n: number) => Math.min(Math.max(n, 0), length);
  return { from: clamp(from), to: clamp(Math.max(from, to)) };
}

/** A request to select a range once its file is open. */
export interface RevealRequest {
  fileId: TreeID;
  target: RevealTarget;
  /** Distinguishes repeated requests for the same target. */
  seq: number;
}

export interface EditorPaneProps {
  compiler?: CompilerClient | null;
  /** Completion and hover docs for Typst files, when available. */
  tinymist?: TinymistClient | null;
  reveal?: RevealRequest | null;
  className?: string;
}

export function EditorPane({
  compiler,
  tinymist,
  reveal,
  className,
}: EditorPaneProps) {
  const { project, index, openFileId, undoManager, readOnly, assets } =
    useProject();

  // Most recently opened first, so the empty state can offer to reopen what
  // was just closed. Updated during render rather than in an effect, which
  // keeps it in step with the open file without an extra commit.
  const [recent, setRecent] = useState<TreeID[]>([]);
  if (openFileId && recent[0] !== openFileId) {
    setRecent(
      [openFileId, ...recent.filter((id) => id !== openFileId)].slice(0, 8),
    );
  }
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
  // Only the LSP plugin depends on the path, since it is bound to the file's
  // URI. Without tinymist, a rename or move does not reconfigure the editor.
  const lspPath = isTypst && tinymist ? path : undefined;
  const extensions = useMemo(
    () => [
      isTypst ? typstLanguage : [],
      tinymist && lspPath ? tinymist.plugin(lspPath) : [],
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
    [
      presence,
      project,
      text,
      openFileId,
      isTypst,
      assets,
      readOnly,
      tinymist,
      lspPath,
    ],
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
    // Opening another file and revealing in it land in one render, while
    // `view` still holds the previous file's editor, already destroyed.
    // Marking the reveal done here would skip it once the new view arrives.
    if (!view.dom.isConnected) return;
    if (revealed.current === reveal.seq) return;
    revealed.current = reveal.seq;
    const doc = view.state.doc;
    const { target } = reveal;
    // The target can predate edits that shortened the file.
    const range =
      target.kind === "source"
        ? sourceRangeToOffsets(target.range, doc)
        : clampRange(target.from, target.to, doc.length);
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      effects: revealScroll(view, range.from),
    });
    view.focus();
  }, [view, reveal, openFileId]);

  let content;
  if (openFileId && openKind === "asset") {
    content = <AssetView id={openFileId} className="min-h-0 flex-1" />;
  } else if (!openFileId || !text) {
    content = <EmptyEditor recent={recent} />;
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
            <span className="mx-2 flex h-5 shrink-0 items-center gap-1 self-center rounded-md border bg-background px-1.5 text-[11px] font-medium text-muted-foreground">
              <EyeIcon className="size-3" />
              Read only
            </span>
          )
        }
      />
      {content}
    </div>
  );
}

function Hint({ combo, children }: { combo: string; children: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-6">
      <span>{children}</span>
      <ShortcutKeys combo={combo} />
    </li>
  );
}

/** Shown when no file is open: ways to get to one. */
function EmptyEditor({ recent }: { recent: readonly TreeID[] }) {
  const { index, mainFile, readOnly, openFile } = useProject();

  const files = useMemo(() => {
    const ids = [...new Set(mainFile ? [mainFile, ...recent] : recent)];
    return ids
      .flatMap((id) => {
        const entry = index.byId.get(id);
        if (!entry || entry.kind === "dir") return [];
        return [
          { id, path: entry.path, kind: entry.kind, main: id === mainFile },
        ];
      })
      .slice(0, 4);
  }, [index, mainFile, recent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto p-6">
      <div className="flex w-full max-w-72 flex-col items-center text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
          <FileCodeIcon className="size-5" />
        </div>
        <p className="mt-3 text-sm font-medium">No file open</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick a file to {readOnly ? "view it" : "start editing"}.
        </p>

        {files.length > 0 && (
          <ul
            aria-label="Quick open"
            className="mt-5 flex w-full flex-col gap-0.5"
          >
            {files.map((file) => {
              const name = basename(file.path);
              const folder = dirname(file.path);
              return (
                <li key={file.id}>
                  <button
                    type="button"
                    title={file.path}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => openFile(file.id)}
                  >
                    <EntryIcon
                      kind={file.kind}
                      name={name}
                      open={false}
                      className="size-4"
                    />
                    <span className="truncate">{name}</span>
                    {folder && (
                      <span className="truncate text-xs text-muted-foreground">
                        {folder}
                      </span>
                    )}
                    {file.main && (
                      <span className="ml-auto shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground uppercase">
                        Main
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <ul className="mt-5 flex w-full flex-col gap-2 border-t pt-4 text-xs text-muted-foreground">
          <Hint combo={SHORTCUTS.quickOpen}>Open a file</Hint>
          <Hint combo={SHORTCUTS.syncNow}>Sync now</Hint>
          <Hint combo={SHORTCUTS.toggleFiles}>Toggle files</Hint>
          <Hint combo={SHORTCUTS.togglePreview}>Toggle preview</Hint>
        </ul>
      </div>
    </div>
  );
}
