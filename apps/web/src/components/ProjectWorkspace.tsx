import {
  ChevronLeftIcon,
  HistoryIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TreeID } from "loro-crdt";
import { Link } from "react-router";
import { toast } from "sonner";

import { OutlinePanel } from "@/components/OutlinePanel";
import { PdfDownloadButton } from "@/components/DownloadButton";
import {
  EditorPane,
  type RevealRequest,
  type RevealTarget,
} from "@/components/EditorPane";
import type { FontsPackagesTarget } from "@/components/fonts-packages/types";
import {
  FolderSyncNotice,
  FolderSyncStatus,
} from "@/components/FolderSyncStatus";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PresenceBar } from "@/components/PresenceBar";
import {
  PreviewPane,
  type PreviewScrollTarget,
} from "@/components/PreviewPane";
import { ProjectTitle } from "@/components/ProjectTitle";
import { QuickOpen } from "@/components/QuickOpen";
import { SearchPanel } from "@/components/SearchPanel";
import { Sidebar } from "@/components/Sidebar";
import {
  TagVersionDialog,
  type TagTarget,
} from "@/components/TagVersionDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { ToolbarButton } from "@/components/ToolbarButton";
import { VersionView } from "@/components/VersionView";
import { WorkspaceLayout } from "@/components/WorkspaceLayout";
import { WorkspaceMenu } from "@/components/WorkspaceMenu";
import { Separator } from "@/components/ui/separator";
import {
  SIDEBAR_AUTOFOCUS_ATTR,
  SIDEBAR_PANEL_ATTR,
  useSidebarTab,
  type SidebarTab,
} from "@/hooks/use-sidebar-tab";
import { useShortcuts } from "@/hooks/use-shortcut";
import { useWorkspaceLayout } from "@/hooks/use-workspace-layout";
import { cn } from "@/lib/utils";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useProject } from "@/project/context";
import type { VersionTarget } from "@/project/history-items";
import { CursorContext, CursorStore } from "@/editor/cursor-store";
import { RevealContext } from "@/project/reveal-context";
import type { SyncNowResult } from "@/sync/connection";
import { groupingFromLocation } from "@/project/useHistory";
import type { PreviewJump } from "@/typst/compiler-client";
import type { ProjectDiagnostic } from "@/typst/diagnostics";
import type { PagePosition } from "@/typst/protocol";
import { useProjectCompiler } from "@/project/useProjectCompiler";
import { useProjectTinymist } from "@/project/useProjectTinymist";

// Fonts, packages and their parsers are only needed once the dialog opens.
const FontsPackagesDialog = lazy(
  () => import("@/components/fonts-packages/FontsPackagesDialog"),
);

export interface ProjectWorkspaceProps {
  /** Sync state indicator; stays visible on phones too. */
  status?: ReactNode;
  /** The prominent share action. */
  share?: ReactNode;
  /** Own avatar, rightmost. */
  identity?: ReactNode;
  /** Anything else for the toolbar, e.g. the dev split's switches. */
  badge?: ReactNode;
  /** Mirror the project title into the browser tab (one per page). */
  documentTitle?: boolean;
  /** Pushes pending edits now; absent without a server connection. */
  onSyncNow?: () => Promise<SyncNowResult>;
}

// Panels beyond the file tree are passed to <Sidebar> as they exist, and
// the shortcuts, menu and dialog follow this list. Module level so its
// identity is stable.
const sidebarTabs: readonly SidebarTab[] = ["files", "outline", "search"];

/** The full project UI for whatever ProjectProvider is above it. */
export function ProjectWorkspace({
  status,
  share,
  identity,
  badge,
  documentTitle = false,
  onSyncNow,
}: ProjectWorkspaceProps) {
  const { title, project, index, openFile, assets, readOnly } = useProject();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tagging, setTagging] = useState<TagTarget | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [fontsPackages, setFontsPackages] =
    useState<FontsPackagesTarget | null>(null);
  // Takes a target so a compile hint can open the packages tab with the
  // missing spec prefilled; pass it down to the preview as a prop.
  const openFontsPackages = useCallback(
    (target: FontsPackagesTarget) => setFontsPackages(target),
    [],
  );
  const [viewing, setViewing] = useState<{
    target: VersionTarget;
    changes: boolean;
  } | null>(null);
  const [grouping] = useState(groupingFromLocation);
  const layout = useWorkspaceLayout("workspace");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!documentTitle) return;
    const previous = document.title;
    document.title = `${title || "Untitled"} · typstry`;
    return () => {
      document.title = previous;
    };
  }, [documentTitle, title]);

  const compiler = useProjectCompiler();
  const tinymist = useProjectTinymist(compiler);
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(
    null,
  );
  const [previewTarget, setPreviewTarget] =
    useState<PreviewScrollTarget | null>(null);
  const cursors = useMemo(() => new CursorStore(), []);

  // A version brings its own compiler. The live one would keep compiling
  // every remote edit for a preview nobody sees.
  const viewingVersion = viewing !== null;
  useEffect(() => {
    if (!viewingVersion) return;
    compiler?.pause();
    tinymist?.pause();
    return () => {
      compiler?.resume();
      tinymist?.resume();
    };
  }, [viewingVersion, compiler, tinymist]);

  const { isMobile, setView } = layout;
  const reveal = useCallback(
    (fileId: TreeID, target: RevealTarget) => {
      openFile(fileId);
      // Opening a different file already switches a phone to the editor,
      // but revealing in the file that is already open would otherwise
      // select text behind the sidebar or preview.
      if (isMobile) setView("editor");
      setRevealRequest((prev) => ({
        fileId,
        target,
        seq: (prev?.seq ?? 0) + 1,
      }));
    },
    [openFile, isMobile, setView],
  );

  const onDiagnosticClick = useCallback(
    (diagnostic: ProjectDiagnostic) => {
      const fileId = diagnostic.path
        ? index.byPath.get(diagnostic.path)
        : undefined;
      if (!fileId) return;
      // A diagnostic without a span still opens its file, at the top.
      reveal(
        fileId,
        diagnostic.range
          ? { kind: "source", range: diagnostic.range }
          : { kind: "offset", from: 0, to: 0 },
      );
    },
    [index, reveal],
  );

  const showInPreview = useCallback(
    (points: PagePosition[], baseline: boolean) => {
      if (layout.isHidden("preview")) layout.toggle("preview");
      setPreviewTarget((prev) => ({
        points,
        baseline,
        seq: (prev?.seq ?? 0) + 1,
      }));
    },
    [layout],
  );

  const onPreviewJump = useCallback(
    (jump: PreviewJump) => {
      if (jump.kind === "source") {
        const fileId = index.byPath.get(jump.path);
        if (!fileId) return;
        reveal(fileId, {
          kind: "offset",
          from: jump.offset,
          to: jump.offset,
        });
      } else if (jump.kind === "package") {
        toast(`Defined in package ${jump.package}`);
      } else if (jump.kind === "position") {
        showInPreview([jump], false);
      }
      // A link to a URL already opens on a single click.
    },
    [index, reveal, showInPreview],
  );

  const jumpToPreview = useCallback(async () => {
    const cursor = cursors.getSnapshot();
    const path = cursor && index.byId.get(cursor.fileId)?.path;
    if (!compiler || !cursor || !path) return;
    const positions = await compiler.jumpFromCursor(path, cursor.head);
    if (positions.length === 0) {
      toast("Nothing to show for this spot in the preview");
      return;
    }
    showInPreview(positions, true);
  }, [compiler, cursors, index, showInPreview]);

  const [sidebarTab, setSidebarTab] = useSidebarTab(sidebarTabs);
  const [focusRequest, setFocusRequest] = useState(0);

  const openSidebar = useCallback(
    (tab: SidebarTab) => {
      if (layout.isHidden("files")) layout.toggle("files");
      setSidebarTab(tab);
      setFocusRequest((n) => n + 1);
    },
    [layout, setSidebarTab],
  );

  // The panel may still be collapsed, inert or unmounted for a few frames
  // after the request (toggle animation, tab switch), so retry until the
  // focus sticks.
  useEffect(() => {
    if (focusRequest === 0) return;
    let frame = 0;
    let attempts = 0;
    function focusPanel() {
      const panel = root.current?.querySelector<HTMLElement>(
        `[${SIDEBAR_PANEL_ATTR}="${sidebarTab}"]`,
      );
      const target =
        panel?.querySelector<HTMLElement>(`[${SIDEBAR_AUTOFOCUS_ATTR}]`) ??
        panel;
      target?.focus();
      if (
        target &&
        target.contains(document.activeElement) &&
        document.activeElement !== document.body
      ) {
        return;
      }
      if (++attempts < 20) frame = requestAnimationFrame(focusPanel);
    }
    frame = requestAnimationFrame(focusPanel);
    return () => cancelAnimationFrame(frame);
    // Only a new request should refocus, not a later tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const tag = readOnly ? undefined : setTagging;
  const syncing = useRef(false);
  const syncNow = onSyncNow
    ? () => {
        if (syncing.current) return;
        syncing.current = true;
        void syncWithFeedback(onSyncNow, readOnly).finally(() => {
          syncing.current = false;
        });
      }
    : undefined;

  // The layout shortcuts would act on panels hidden behind an old version,
  // so they only swallow the key then.
  useShortcuts(
    {
      // Swallowed even without a connection, so the browser's "Save page"
      // dialog never shows up in the middle of writing.
      [SHORTCUTS.syncNow]: () => syncNow?.(),
      [SHORTCUTS.quickOpen]: () => !viewing && setQuickOpen((open) => !open),
      [SHORTCUTS.toggleFiles]: () => !viewing && layout.toggle("files"),
      [SHORTCUTS.togglePreview]: () => !viewing && layout.toggle("preview"),
      [SHORTCUTS.fontsPackages]: () =>
        !viewing && openFontsPackages({ tab: "fonts" }),
      [SHORTCUTS.jumpToPreview]: () => !viewing && void jumpToPreview(),
      ...(sidebarTabs.includes("search") && {
        [SHORTCUTS.search]: () => !viewing && openSidebar("search"),
      }),
      ...(sidebarTabs.includes("outline") && {
        [SHORTCUTS.outline]: () => !viewing && openSidebar("outline"),
      }),
    },
    { scope: root },
  );

  const mobile = layout.isMobile;
  const filesShown = !layout.isHidden("files");
  const previewShown = !layout.isHidden("preview");

  return (
    <div
      ref={root}
      data-shortcut-scope=""
      className="flex h-full min-h-0 flex-col"
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-1 border-b px-2",
          mobile ? "h-12" : "h-11",
        )}
      >
        <Link
          to="/"
          title="All projects"
          aria-label="All projects"
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-1.5 pl-0.5 text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronLeftIcon className="size-4 text-muted-foreground" />
          {!mobile && "typstry"}
        </Link>
        {!mobile && (
          <span aria-hidden className="text-sm text-muted-foreground/60">
            /
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center">
          <ProjectTitle className="max-w-80" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!mobile && (
            <>
              <PresenceBar />
              {status}
              <Separator orientation="vertical" className="mx-1 h-5" />
              <ToolbarButton
                label="Files panel"
                tooltip={filesShown ? "Hide files" : "Show files"}
                shortcut={SHORTCUTS.toggleFiles}
                aria-pressed={filesShown}
                aria-controls={layout.ids.files}
                disabled={!!viewing}
                onClick={() => layout.toggle("files")}
              >
                <PanelLeftIcon />
              </ToolbarButton>
              <ToolbarButton
                label="Preview panel"
                tooltip={previewShown ? "Hide preview" : "Show preview"}
                shortcut={SHORTCUTS.togglePreview}
                aria-pressed={previewShown}
                aria-controls={layout.ids.preview}
                disabled={!!viewing}
                onClick={() => layout.toggle("preview")}
              >
                <PanelRightIcon />
              </ToolbarButton>
              <ToolbarButton
                label="History"
                tooltip="Version history"
                variant={historyOpen || viewing ? "secondary" : "ghost"}
                onClick={() => setHistoryOpen(true)}
              >
                <HistoryIcon />
              </ToolbarButton>
            </>
          )}
          {mobile && status}
          <WorkspaceMenu
            layout={layout}
            panelsDisabled={!!viewing}
            onHistory={() => setHistoryOpen(true)}
            onTagVersion={tag && (() => tag({ kind: "current" }))}
            onQuickOpen={() => setQuickOpen(true)}
            onShortcuts={() => setShortcutsOpen(true)}
            onFontsPackages={() => openFontsPackages({ tab: "fonts" })}
            onSyncNow={syncNow}
          />
          {badge}
          {share && <div className="ml-1 flex items-center">{share}</div>}
          {identity && <div className="ml-1 flex items-center">{identity}</div>}
        </div>
      </header>
      <HistoryPanel
        project={project}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        grouping={grouping}
        selected={viewing?.target.key ?? null}
        onSelect={(target) => {
          setViewing({ target, changes: false });
          setHistoryOpen(false);
        }}
        onShowChanges={(target) => {
          setViewing({ target, changes: true });
          setHistoryOpen(false);
        }}
        assets={assets}
        title={title}
        // The panel stays open underneath, so the new tag shows up in the
        // list right after tagging.
        onTag={tag}
      />
      {!readOnly && (
        <TagVersionDialog
          project={project}
          target={tagging}
          onClose={() => setTagging(null)}
        />
      )}
      <QuickOpen open={quickOpen} onOpenChange={setQuickOpen} />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        sidebarTabs={sidebarTabs}
      />
      {fontsPackages && (
        <Suspense fallback={null}>
          <FontsPackagesDialog
            open={fontsPackages}
            onClose={() => setFontsPackages(null)}
          />
        </Suspense>
      )}
      {viewing ? (
        <div className="min-h-0 flex-1">
          <VersionView
            // Remounted when "Show changes" is picked for the version
            // already open, so it switches to the diff.
            key={`${viewing.target.key}:${viewing.changes}`}
            project={project}
            target={viewing.target}
            assets={assets}
            canRestore={!readOnly}
            onClose={() => setViewing(null)}
            showChangesOnOpen={viewing.changes}
          />
        </div>
      ) : (
        <RevealContext value={reveal}>
          <CursorContext value={cursors}>
            <WorkspaceLayout
              layout={layout}
              files={
                <Sidebar
                  tab={sidebarTab}
                  onTabChange={setSidebarTab}
                  heading={<FolderSyncStatus />}
                  notice={<FolderSyncNotice />}
                  outline={<OutlinePanel />}
                  search={<SearchPanel />}
                />
              }
              editor={
                <EditorPane
                  compiler={compiler}
                  tinymist={tinymist}
                  reveal={revealRequest}
                />
              }
              preview={
                <PreviewPane
                  client={compiler}
                  onDiagnosticClick={onDiagnosticClick}
                  onOpenFontsPackages={openFontsPackages}
                  onJump={onPreviewJump}
                  scrollTarget={previewTarget}
                  actions={
                    <PdfDownloadButton compiler={compiler} name={[title]} />
                  }
                />
              }
            />
          </CursorContext>
        </RevealContext>
      )}
    </div>
  );
}

const SYNC_TOAST = "sync-now";

async function syncWithFeedback(
  run: () => Promise<SyncNowResult>,
  readOnly: boolean,
) {
  // One toast id, so repeated presses update a single toast instead of
  // stacking them.
  toast.loading("Syncing…", { id: SYNC_TOAST });
  let result: SyncNowResult;
  try {
    result = await run();
  } catch (err) {
    // The local save can throw, e.g. when storage is full.
    console.error(err);
    toast.error("Syncing failed. See the console for details.", {
      id: SYNC_TOAST,
    });
    return;
  }
  if (result === "synced") {
    toast.success(readOnly ? "Up to date" : "All changes synced", {
      id: SYNC_TOAST,
    });
  } else if (result === "pending") {
    toast.warning(
      "Some changes could not be sent yet. They are kept on this device.",
      { id: SYNC_TOAST },
    );
  } else {
    toast.warning(
      readOnly
        ? "The server is unreachable. Updates arrive once it is back."
        : "The server is unreachable. Your changes are saved on this device and sync once it is back.",
      { id: SYNC_TOAST },
    );
  }
}
