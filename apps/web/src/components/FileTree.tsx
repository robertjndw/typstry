import type { TreeID } from "loro-crdt";
import {
  ChevronRightIcon,
  FileAudioIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileTypeIcon,
  FileVideoIcon,
  FilePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListCollapseIcon,
  Loader2Icon,
  TriangleAlertIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ToolbarButton } from "@/components/ToolbarButton";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createFile,
  deleteNode,
  move,
  rename,
  setMainFile,
} from "@/doc/fs-ops";
import { stemLength } from "@/doc/names";
import { fileCategory, type FileCategory } from "@/assets/file-types";
import { cn } from "@/lib/utils";
import { usePresenceSummary } from "@/presence/context";
import type { PeerSummary } from "@/presence/presence";
import { useProject } from "@/project/context";
import {
  attempt,
  buildTree,
  uploadReporting,
  type TreeEntry,
} from "@/project/tree";

const DRAG_MIME = "application/x-typstry-node";

type Editing =
  | { mode: "rename"; id: TreeID }
  | { mode: "create"; parent: TreeID | null; kind: "text" | "dir" };

export function FileTree({
  className,
  heading,
  notice,
}: {
  className?: string;
  heading?: ReactNode;
  notice?: ReactNode;
}) {
  const { project, index, mainFile, openFileId, openFile, readOnly, assets } =
    useProject();
  const peers = usePresenceSummary();
  const peersByFile = useMemo(() => {
    const map = new Map<TreeID, PeerSummary[]>();
    for (const peer of peers) {
      if (!peer.fileId) continue;
      const list = map.get(peer.fileId);
      if (list) list.push(peer);
      else map.set(peer.fileId, [peer]);
    }
    return map;
  }, [peers]);
  // The store rebuilds `index` on every tree change, so it doubles as the
  // cache key for the parent links buildTree reads from the doc.
  const tree = useMemo(() => buildTree(project, index), [project, index]);
  const byId = useMemo(() => {
    const map = new Map<TreeID, TreeEntry>();
    const walk = (list: TreeEntry[]) => {
      for (const e of list) {
        map.set(e.id, e);
        walk(e.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<TreeID>>(new Set());
  const [selectedId, setSelectedId] = useState<TreeID | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeID | null>(null);
  const [dropTarget, setDropTarget] = useState<TreeID | "root" | null>(null);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<TreeID | null>(null);
  // Uploads need the server (blob store), so local-only projects skip them.
  const canUpload = !readOnly && assets !== null;

  // Only what's on screen counts: a folder left open inside a collapsed one
  // is hidden, and every visible open folder sits under an open root one.
  const anyExpanded = tree.some(
    (e) => e.kind === "dir" && !collapsed.has(e.id),
  );

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const deleting = pendingDelete ? byId.get(pendingDelete) : undefined;

  function setExpanded(id: TreeID, expanded: boolean) {
    setCollapsed((prev) => {
      if (prev.has(id) !== expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Folder that new entries go into when started from `entry`. */
  function containerOf(entry: TreeEntry | undefined): TreeID | null {
    if (!entry) return null;
    return entry.kind === "dir" ? entry.id : entry.parent;
  }

  function startCreate(parent: TreeID | null, kind: "text" | "dir") {
    if (readOnly) return;
    if (parent) setExpanded(parent, true);
    setEditing({ mode: "create", parent, kind });
  }

  function commitEdit(value: string) {
    const current = editing;
    setEditing(null);
    if (!current || readOnly) return;
    const name = value.trim();
    if (current.mode === "create") {
      if (name === "") return;
      const id = attempt(() =>
        createFile(project, current.parent, name, current.kind),
      );
      if (id === undefined) return;
      setSelectedId(id);
      if (current.kind === "text") openFile(id);
    } else {
      const entry = byId.get(current.id);
      if (!entry || name === entry.name) return;
      attempt(() => rename(project, current.id, name));
    }
  }

  function activate(entry: TreeEntry) {
    setSelectedId(entry.id);
    if (entry.kind === "dir") setExpanded(entry.id, collapsed.has(entry.id));
    else openFile(entry.id);
  }

  async function upload(files: File[], parent: TreeID | null) {
    if (!canUpload || !assets || files.length === 0) return;
    if (parent) setExpanded(parent, true);
    setUploading((n) => n + files.length);
    try {
      const created = await uploadReporting(project, assets, files, parent);
      const firstText = created.find((c) => c.kind === "text");
      if (firstText) openFile(firstText.id);
      if (created.length > 0) setSelectedId(created[0]!.id);
    } finally {
      setUploading((n) => n - files.length);
    }
  }

  function startUpload(parent: TreeID | null) {
    uploadTarget.current = parent;
    fileInput.current?.click();
  }

  async function copyPath(entry: TreeEntry) {
    try {
      await navigator.clipboard.writeText(entry.path);
      toast.success(`Copied "${entry.path}"`);
    } catch {
      toast.error("Copying failed");
    }
  }

  function onRowKeyDown(e: KeyboardEvent, entry: TreeEntry) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") activate(entry);
    else if (e.key === "F2" && !readOnly)
      setEditing({ mode: "rename", id: entry.id });
    else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly)
      setPendingDelete(entry.id);
    else if (e.key === "ArrowRight" && entry.kind === "dir")
      setExpanded(entry.id, true);
    else if (e.key === "ArrowLeft" && entry.kind === "dir")
      setExpanded(entry.id, false);
    else return;
    e.preventDefault();
  }

  function onDragOver(e: DragEvent, target: TreeID | "root") {
    if (readOnly) return;
    const types = e.dataTransfer.types;
    const external = !types.includes(DRAG_MIME) && types.includes("Files");
    if (!types.includes(DRAG_MIME) && !(external && canUpload)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = external ? "copy" : "move";
    setDropTarget(target);
  }

  function onDrop(e: DragEvent, target: TreeID | null) {
    const id = e.dataTransfer.getData(DRAG_MIME) as TreeID;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    if (!id && e.dataTransfer.files.length > 0) {
      void upload(Array.from(e.dataTransfer.files), target);
      return;
    }
    const entry = byId.get(id);
    if (readOnly || !entry || entry.id === target) return;
    attempt(() => move(project, id, target));
    if (target) setExpanded(target, true);
  }

  function nameInput(
    depth: number,
    kind: TreeEntry["kind"],
    initial: string,
    label: string,
  ) {
    return (
      <div
        className="flex h-7 items-center gap-1.5 pr-2"
        style={{ paddingLeft: indent(depth) }}
      >
        <span className="size-4 shrink-0" />
        <EntryIcon kind={kind} name={initial} open={false} />
        <NameInput
          initial={initial}
          label={label}
          onCommit={commitEdit}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  function createRow(parent: TreeID | null, depth: number): ReactNode {
    if (editing?.mode !== "create" || editing.parent !== parent) return null;
    return nameInput(
      depth,
      editing.kind,
      "",
      editing.kind === "dir" ? "New folder name" : "New file name",
    );
  }

  function renderEntries(list: TreeEntry[], depth: number): ReactNode {
    return list.map((entry) => {
      const isDir = entry.kind === "dir";
      const expanded = isDir && !collapsed.has(entry.id);
      const renaming = editing?.mode === "rename" && editing.id === entry.id;
      const dropId = isDir ? entry.id : (entry.parent ?? "root");
      return (
        <div key={entry.id} role="none">
          {renaming ? (
            nameInput(depth, entry.kind, entry.name, `Rename ${entry.path}`)
          ) : (
            <ContextMenu>
              <ContextMenuTrigger
                asChild
                disabled={readOnly && entry.kind === "dir"}
              >
                <div
                  role="treeitem"
                  aria-label={entry.displayName}
                  aria-level={depth + 1}
                  aria-selected={entry.id === selectedId}
                  aria-expanded={isDir ? expanded : undefined}
                  aria-current={entry.id === openFileId ? "page" : undefined}
                  tabIndex={0}
                  draggable={!readOnly}
                  className={cn(
                    "group flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 text-sm text-foreground/85 outline-none select-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                    entry.id === selectedId &&
                      "bg-accent text-accent-foreground hover:bg-accent",
                    entry.id === openFileId && "font-medium text-foreground",
                    dropTarget === entry.id &&
                      "bg-primary/10 ring-1 ring-primary/40",
                  )}
                  style={{ paddingLeft: indent(depth) }}
                  onClick={() => activate(entry)}
                  onKeyDown={(e) => onRowKeyDown(e, entry)}
                  onContextMenu={() => setSelectedId(entry.id)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME, entry.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDropTarget(null)}
                  onDragOver={(e) => onDragOver(e, dropId)}
                  onDrop={(e) => onDrop(e, dropId === "root" ? null : dropId)}
                >
                  {isDir ? (
                    <ChevronRightIcon
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <EntryIcon
                    kind={entry.kind}
                    name={entry.displayName}
                    open={expanded}
                    className={cn(entry.id === openFileId && "text-foreground")}
                  />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={entry.displayName}
                  >
                    {entry.displayName}
                  </span>
                  {entry.id === mainFile && (
                    <Badge tip="Main file: the preview compiles this one">
                      <span className="rounded-sm border border-border bg-muted px-1 text-[10px] leading-3.5 font-semibold tracking-wider text-muted-foreground uppercase">
                        main
                      </span>
                    </Badge>
                  )}
                  <PeerDots peers={peersByFile.get(entry.id)} />
                  {entry.renamed && (
                    <Badge
                      tip={`Someone else created "${entry.name}" here at the same time. This one is shown as "${entry.displayName}" until one of them is renamed.`}
                    >
                      <TriangleAlertIcon
                        aria-label="Name conflict"
                        className="size-3.5 text-warning"
                      />
                    </Badge>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52" onCloseAutoFocus={keepFocus}>
                {entry.kind !== "dir" && (
                  <ContextMenuItem onSelect={() => openFile(entry.id)}>
                    Open
                  </ContextMenuItem>
                )}
                {entry.kind !== "dir" && (
                  <ContextMenuItem onSelect={() => void copyPath(entry)}>
                    Copy path
                  </ContextMenuItem>
                )}
                {entry.kind === "dir" && canUpload && (
                  <ContextMenuItem onSelect={() => startUpload(entry.id)}>
                    Upload here
                  </ContextMenuItem>
                )}
                {!readOnly && (
                  <EntryEditItems
                    entry={entry}
                    isMain={entry.id === mainFile}
                    onCreate={(kind) => startCreate(containerOf(entry), kind)}
                    onRename={() =>
                      setEditing({ mode: "rename", id: entry.id })
                    }
                    onSetMain={() =>
                      attempt(() => setMainFile(project, entry.id))
                    }
                    onDelete={() => setPendingDelete(entry.id)}
                  />
                )}
              </ContextMenuContent>
            </ContextMenu>
          )}
          {isDir && expanded && (
            <div
              role="group"
              className="animate-in duration-150 fade-in-0 slide-in-from-top-1"
            >
              {createRow(entry.id, depth + 1)}
              {renderEntries(entry.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b pr-1 pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {heading ?? (
            <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase select-none">
              Files
            </span>
          )}
        </div>
        {!readOnly && (
          <>
            <ToolbarButton
              label="New file"
              onClick={() => startCreate(containerOf(selected), "text")}
            >
              <FilePlusIcon />
            </ToolbarButton>
            <ToolbarButton
              label="New folder"
              onClick={() => startCreate(containerOf(selected), "dir")}
            >
              <FolderPlusIcon />
            </ToolbarButton>
          </>
        )}
        {canUpload && (
          <ToolbarButton
            label={uploading > 0 ? "Uploading…" : "Upload files"}
            onClick={() => startUpload(containerOf(selected))}
          >
            {uploading > 0 ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <UploadIcon />
            )}
          </ToolbarButton>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Files to upload"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            // Reset so picking the same file again still fires a change.
            e.currentTarget.value = "";
            void upload(files, uploadTarget.current);
          }}
        />
        <ToolbarButton
          label="Collapse all"
          disabled={!anyExpanded}
          onClick={() =>
            setCollapsed(
              new Set(
                [...byId.values()]
                  .filter((e) => e.kind === "dir")
                  .map((e) => e.id),
              ),
            )
          }
        >
          <ListCollapseIcon />
        </ToolbarButton>
      </div>
      {notice}
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={readOnly}>
          <ScrollArea
            className={cn(
              // Radix wraps the content in a display:table div that grows
              // with the widest row, which defeats truncation of long names.
              "min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!",
              dropTarget === "root" && "bg-primary/5",
            )}
            onDragOver={(e) => onDragOver(e, "root")}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setDropTarget(null);
            }}
            onDrop={(e) => onDrop(e, null)}
          >
            <div
              role="tree"
              aria-label="Project files"
              className="p-1 pb-8"
              onClick={(e) => {
                if (e.target === e.currentTarget) setSelectedId(null);
              }}
            >
              {createRow(null, 0)}
              {renderEntries(tree, 0)}
            </div>
            {tree.length === 0 && editing?.mode !== "create" && (
              <EmptyState
                readOnly={readOnly}
                canUpload={canUpload}
                onCreate={() => startCreate(null, "text")}
                onUpload={() => startUpload(null)}
              />
            )}
          </ScrollArea>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={keepFocus}>
          <ContextMenuItem onSelect={() => startCreate(null, "text")}>
            New file
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => startCreate(null, "dir")}>
            New folder
          </ContextMenuItem>
          {canUpload && (
            <ContextMenuItem onSelect={() => startUpload(null)}>
              Upload files
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <ConfirmDeleteDialog
        open={deleting !== undefined}
        title={`Delete ${deleting?.kind === "dir" ? "folder" : "file"}?`}
        description={
          <>
            <span className="font-mono">{deleting?.path}</span>
            {deleting?.kind === "dir" && " and everything in it"} will be
            removed for everyone in this project.
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id) attempt(() => deleteNode(project, id));
        }}
      />
    </div>
  );
}

function EmptyState({
  readOnly,
  canUpload,
  onCreate,
  onUpload,
}: {
  readOnly: boolean;
  canUpload: boolean;
  onCreate: () => void;
  onUpload: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <FileIcon aria-hidden className="size-6 text-muted-foreground/70" />
      <div className="grid gap-1">
        <p className="text-sm font-medium">No files yet</p>
        {!readOnly && (
          <p className="text-xs text-muted-foreground">
            {canUpload
              ? "Create a file, or drop files here to upload them."
              : "Create a file to start writing."}
          </p>
        )}
      </div>
      {!readOnly && (
        // Labels differ from the toolbar's so each button name stays unique.
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" onClick={onCreate}>
            <FilePlusIcon />
            Create a file
          </Button>
          {canUpload && (
            <Button variant="ghost" size="sm" onClick={onUpload}>
              <UploadIcon />
              Upload
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function EntryEditItems({
  entry,
  isMain,
  onCreate,
  onRename,
  onSetMain,
  onDelete,
}: {
  entry: TreeEntry;
  isMain: boolean;
  onCreate: (kind: "text" | "dir") => void;
  onRename: () => void;
  onSetMain: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <ContextMenuItem onSelect={() => onCreate("text")}>
        New file
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCreate("dir")}>
        New folder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onRename}>
        Rename
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      {entry.kind === "text" && (
        <ContextMenuItem disabled={isMain} onSelect={onSetMain}>
          Set as main file
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={onDelete}>
        Delete
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

function PeerDots({ peers }: { peers: PeerSummary[] | undefined }) {
  if (!peers?.length) return null;
  const names = peers.map((p) => p.name).join(", ");
  return (
    <Badge tip={`Open for ${names}`}>
      <span
        className="flex items-center -space-x-0.5"
        aria-label={`Open for ${names}`}
      >
        {peers.slice(0, 3).map((p) => (
          <span
            key={p.peerId}
            className="size-2 rounded-full ring-1 ring-background"
            style={{ backgroundColor: p.color }}
          />
        ))}
      </span>
    </Badge>
  );
}

// Menu items can mount an autofocused name input; Radix would otherwise
// move focus back to the trigger on close and blur (commit) that input.
function keepFocus(e: Event) {
  e.preventDefault();
}

function indent(depth: number): number {
  return 4 + depth * 12;
}

const CATEGORY_ICONS: Record<FileCategory, LucideIcon> = {
  typst: FileCodeIcon,
  text: FileTextIcon,
  image: FileImageIcon,
  pdf: FileTextIcon,
  font: FileTypeIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  data: FileBracesIcon,
  other: FileIcon,
};

export function EntryIcon({
  kind,
  name,
  open,
  className: extra,
}: {
  kind: TreeEntry["kind"];
  name: string;
  open: boolean;
  className?: string;
}) {
  const className = cn("size-4 shrink-0 text-muted-foreground", extra);
  if (kind === "dir")
    return open ? (
      <FolderOpenIcon className={className} />
    ) : (
      <FolderIcon className={className} />
    );
  const category = fileCategory(name);
  // Text nodes are editable whatever their extension, so an unknown one
  // still looks like text rather than a blob.
  const Icon =
    CATEGORY_ICONS[category === "other" && kind === "text" ? "text" : category];
  return <Icon className={className} />;
}

function Badge({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}

function NameInput({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  // Enter commits and then unmounts the input, which fires blur; without
  // this guard the edit would be committed twice.
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  // Not autoFocus: when started from a context menu, the input mounts while
  // the menu still traps focus, which would steal it back and blur (commit)
  // the empty input. Focusing on the next frame lands after the menu let go.
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <Input
      ref={ref}
      aria-label={label}
      defaultValue={initial}
      className="h-6 rounded-sm px-1.5 py-0 text-sm"
      onFocus={(e) => {
        // Preselect the stem so typing replaces the name but keeps ".typ".
        e.currentTarget.setSelectionRange(0, stemLength(initial));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const value = e.currentTarget.value;
          finish(() => onCommit(value));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(onCancel);
        }
      }}
      onBlur={(e) => {
        const value = e.currentTarget.value;
        finish(() => onCommit(value));
      }}
    />
  );
}
