import {
  ArrowRightIcon,
  CloudOffIcon,
  FileTextIcon,
  ImportIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readDrop, readPicked, type PendingImport } from "@/import/sources";
import { assertImportable, ImportError, writeImport } from "@/import/import";
import { formatRelative } from "@/project/history-items";
import { createLocalProject, deleteLocalProject } from "@/project/create";
import { loadRecent, type RecentProject } from "@/project/recent";

const TITLE_MAX_LENGTH = 120;

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const FEATURES: { Icon: LucideIcon; title: string; text: string }[] = [
  {
    Icon: UsersIcon,
    title: "Real-time collaboration",
    text: "Edit together and see each other's cursors.",
  },
  {
    Icon: KeyRoundIcon,
    title: "End-to-end encrypted",
    text: "The key lives in the link. The server never sees it.",
  },
  {
    Icon: CloudOffIcon,
    title: "Works offline",
    text: "Keep writing offline. Changes sync later.",
  },
];

export function Home() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  /** What the import is doing right now, or null when none is running. */
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const importing = importStatus !== null;
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire for every child the pointer crosses, so
  // only the count tells whether the drag is still over the page.
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = creating || importing;
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [pendingDelete, setPendingDelete] = useState<RecentProject | null>(
    null,
  );
  const now = useNow(60_000);

  async function deleteProject(project: RecentProject) {
    setRecent((list) => list.filter((p) => p.projectId !== project.projectId));
    try {
      await deleteLocalProject(project.projectId);
    } catch (err) {
      console.error(err);
      toast.error("Could not clear the local copy of this project");
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createLocalProject(title.trim() || "Untitled");
      navigate(`/p/${encodeURIComponent(created.editToken)}#${created.key}`);
    } catch (err) {
      console.error(err);
      setError("Could not create a project. Is the server running?");
      setCreating(false);
    }
  }

  async function importFrom(pending: PendingImport) {
    setImportStatus(
      pending.kind === "zip" ? "Unpacking zip…" : "Reading files…",
    );
    setError(null);
    try {
      const source = await pending.source;
      assertImportable(source);
      setImportStatus("Creating project…");
      const projectTitle =
        title.trim() ||
        [...source.name.trim()].slice(0, TITLE_MAX_LENGTH).join("") ||
        "Untitled";
      const created = await createLocalProject(projectTitle, {
        seed: (project, assets) =>
          writeImport(project, source, assets, (uploaded, total) => {
            if (total > 0)
              setImportStatus(`Uploading files (${uploaded} of ${total})…`);
          }),
      });
      if (source.skipped.length > 0) {
        const count = source.skipped.length;
        toast.warning(
          `Left out ${count} ${count === 1 ? "file" : "files"} with names a project cannot hold`,
          { description: source.skipped.slice(0, 5).join(", ") },
        );
      }
      navigate(`/p/${encodeURIComponent(created.editToken)}#${created.key}`);
    } catch (err) {
      console.error(err);
      setError(
        err instanceof ImportError
          ? err.message
          : "Could not import the project. Is the server running?",
      );
      setImportStatus(null);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    // Cleared so picking the same file again after an error still fires.
    e.target.value = "";
    if (files.length > 0 && !busy) void importFrom(readPicked(files));
  }

  function isFileDrag(e: DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }

  function onDragEnter(e: DragEvent) {
    if (!isFileDrag(e)) return;
    dragDepth.current++;
    setDragging(true);
  }

  function onDragLeave(e: DragEvent) {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDragOver(e: DragEvent) {
    if (!isFileDrag(e)) return;
    // Without this the browser opens the dropped file in place of the app.
    e.preventDefault();
    e.dataTransfer.dropEffect = busy ? "none" : "copy";
  }

  function onDrop(e: DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    const dropped = readDrop(e.dataTransfer);
    if (dropped) void importFrom(dropped);
  }

  return (
    <div
      className="flex min-h-svh flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dragging && !busy && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/85 backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-2 px-6 text-center">
            <ImportIcon className="size-6 text-muted-foreground" />
            <p className="font-medium">Drop to import</p>
            <p className="text-sm text-muted-foreground">
              A zip or a folder becomes a new project.
            </p>
          </div>
        </div>
      )}
      <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
        <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <LogoMark />
          typstry
        </span>
        <ThemeToggle />
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-12 px-4 pt-10 pb-16 sm:pt-20">
        <section className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              typstry
            </h1>
            <p className="text-lg text-pretty text-muted-foreground">
              Write Typst documents together, right in the browser. No accounts,
              just a link.
            </p>
          </div>

          <ul className="grid gap-4 sm:grid-cols-3 sm:gap-6">
            {FEATURES.map(({ Icon, title, text }) => (
              <li key={title} className="flex gap-3 sm:flex-col sm:gap-2">
                <Icon
                  aria-hidden
                  // Lucide glyphs sit inset in their box; the negative
                  // margin lines the stroke up with the text edge below.
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground sm:mt-0 sm:-ml-px"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{title}</span>
                  <span className="text-sm text-muted-foreground">{text}</span>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2">
            <form
              onSubmit={onSubmit}
              className="flex flex-col gap-2 sm:flex-row"
            >
              <Input
                aria-label="Project title"
                placeholder="Project title (optional)"
                value={title}
                maxLength={TITLE_MAX_LENGTH}
                onChange={(e) => setTitle(e.target.value)}
                className="h-9 flex-1"
              />
              <Button type="submit" size="lg" disabled={busy}>
                {creating ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <PlusIcon />
                )}
                New project
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={busy}
                title="Import a zip or Typst files"
                onClick={() => fileInput.current?.click()}
              >
                {importing ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <ImportIcon />
                )}
                {importing ? "Importing…" : "Import"}
              </Button>
            </form>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label="Files to import"
              onChange={onPick}
            />
            {importStatus ? (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2Icon aria-hidden className="size-4 animate-spin" />
                {importStatus}
              </p>
            ) : (
              !error && (
                <p className="text-sm text-muted-foreground">
                  You can also drop a zip or folder anywhere on this page.
                </p>
              )
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </section>

        {recent.length > 0 ? (
          <section
            aria-labelledby="recent-heading"
            className="flex flex-col gap-3"
          >
            <h2
              id="recent-heading"
              className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              Recent projects
            </h2>
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {recent.map((p) => (
                <li
                  key={p.projectId}
                  className="group relative flex items-center transition-colors hover:bg-muted/60"
                >
                  <Link
                    to={`/p/${encodeURIComponent(p.token)}`}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-1 pl-4 text-sm outline-none focus-visible:bg-muted/60"
                  >
                    <FileTextIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {titleOf(p)}
                    </span>
                    <time
                      dateTime={new Date(p.visitedAt).toISOString()}
                      title={dateFormat.format(p.visitedAt)}
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                      {capitalize(formatRelative(p.visitedAt, now))}
                    </time>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${titleOf(p)}`}
                    title="Delete"
                    // Always visible on touch screens, which have no hover.
                    className="mr-2 text-muted-foreground hover:text-destructive focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
                    onClick={() => setPendingDelete(p)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="flex items-start gap-2 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
            <ArrowRightIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Projects you create or open in this browser will show up here. To
              collaborate, share the link from inside a project.
            </span>
          </p>
        )}
      </main>

      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        title={<>Delete &ldquo;{titleOf(pendingDelete)}&rdquo;?</>}
        description="It's only removed from this browser. Anyone with the link can still open it, so keep the link if you might want it back."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const project = pendingDelete;
          setPendingDelete(null);
          if (project) void deleteProject(project);
        }}
      />
    </div>
  );
}

/** The favicon's glyph, drawn in theme colors rather than the OS scheme. */
function LogoMark() {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className="size-6 shrink-0 rounded-md bg-foreground text-background"
    >
      <path
        fill="currentColor"
        d="M13.2 7.5h3.4v4.2h5v3h-5v6.6c0 1.4.7 2 1.9 2 .9 0 1.8-.2 2.7-.6l.6 2.9c-1.2.5-2.6.8-4 .8-3.1 0-4.6-1.7-4.6-4.8v-6.9H10.4v-3h2.8z"
      />
    </svg>
  );
}

/** Re-renders on an interval so relative times don't go stale. */
function useNow(interval: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function titleOf(project: RecentProject | null): string {
  return project?.title || "Untitled";
}
