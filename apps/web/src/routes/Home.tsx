import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLocalProject, deleteLocalProject } from "@/project/create";
import { loadRecent, type RecentProject } from "@/project/recent";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function Home() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [pendingDelete, setPendingDelete] = useState<RecentProject | null>(
    null,
  );

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
    if (creating) return;
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

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">typstry</h1>
        <p className="mt-2 text-muted-foreground">
          Collaborative Typst editing in the browser.
        </p>
      </div>
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-sm flex-col gap-2 sm:flex-row"
      >
        <Input
          aria-label="Project title"
          placeholder="Project title (optional)"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          className="h-9"
        />
        <Button type="submit" size="lg" disabled={creating}>
          {creating ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
          New project
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="recent-heading" className="w-full max-w-sm">
          <h2
            id="recent-heading"
            className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            Recent projects
          </h2>
          <ul className="divide-y rounded-lg border">
            {recent.map((p) => (
              <li key={p.projectId} className="group flex items-center">
                <Link
                  to={`/p/${encodeURIComponent(p.token)}`}
                  className="flex min-w-0 flex-1 items-baseline justify-between gap-3 py-2 pr-1 pl-3 text-sm hover:bg-muted"
                >
                  <span className="truncate font-medium">{titleOf(p)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dateFormat.format(p.visitedAt)}
                  </span>
                </Link>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${titleOf(p)}`}
                  title="Delete"
                  className="mx-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                  onClick={() => setPendingDelete(p)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
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
    </main>
  );
}

function titleOf(project: RecentProject | null): string {
  return project?.title || "Untitled";
}
