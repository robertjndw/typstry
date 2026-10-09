import type { TreeID } from "loro-crdt";
import {
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListCollapseIcon,
  Loader2Icon,
  TriangleAlertIcon,
  UploadIcon,
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

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { uploadFiles } from "@/assets/upload";
import { cn } from "@/lib/utils";
import { usePresence } from "@/presence/context";
import type { RemotePeer } from "@/presence/presence";
import { useProject } from "@/project/context";
import {
  attempt,
  buildTree,
  friendlyFsError,
  type TreeEntry,
} from "@/project/tree";

const DRAG_MIME = "application/x-typstry-node";

type Editing =
  | { mode: "rename"; id: TreeID }
  | { mode: "create"; parent: TreeID | null; kind: "text" | "dir" };

export function FileTree({ className }: { className?: string }) {
  const { project, index, mainFile, openFileId, openFile, readOnly, assets } =
    useProject();
  const peers = usePresence();
  const peersByFile = useMemo(() => {
    const map = new Map<TreeID, RemotePeer[]>();
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
      const { created, errors } = await uploadFiles(
        project,
        assets,
        files,
        parent,
      );
      for (const failure of errors)
        toast.error(`${failure.name}: ${failure.error.message}`);
      const firstText = created.find((c) => c.kind === "text");
      if (firstText) openFile(firstText.id);
      if (created.length > 0) setSelectedId(created[0]!.id);
    } catch (err) {
      toast.error(friendlyFsError(err));
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
        <EntryIcon kind={kind} open={false} />
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
                    "group flex h-7 cursor-default items-center gap-1.5 rounded-sm pr-2 text-sm outline-none select-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
                    entry.id === selectedId && "bg-accent",
                    entry.id === openFileId && "font-medium",
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
                  <EntryIcon kind={entry.kind} open={expanded} />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={entry.displayName}
                  >
                    {entry.displayName}
                  </span>
                  {entry.id === mainFile && (
                    <Badge tip="Main file: the preview compiles this one">
                      <span className="rounded bg-primary/10 px-1 text-[10px] leading-4 font-medium text-primary uppercase">
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
                        className="size-3.5 text-amber-500"
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
            <div role="group">
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
        <span className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Files
        </span>
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

      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              Delete {deleting?.kind === "dir" ? "folder" : "file"}?
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono">{deleting?.path}</span>
              {deleting?.kind === "dir" && " and everything in it"} will be
              removed for everyone in this project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const id = pendingDelete;
                setPendingDelete(null);
                if (id) attempt(() => deleteNode(project, id));
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function PeerDots({ peers }: { peers: RemotePeer[] | undefined }) {
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

function EntryIcon({ kind, open }: { kind: TreeEntry["kind"]; open: boolean }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  if (kind === "dir")
    return open ? (
      <FolderOpenIcon className={className} />
    ) : (
      <FolderIcon className={className} />
    );
  if (kind === "text") return <FileCodeIcon className={className} />;
  return <FileIcon className={className} />;
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

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
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
