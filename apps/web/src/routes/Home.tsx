import { Loader2Icon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLocalProject } from "@/project/create";
import { loadRecent } from "@/project/recent";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function Home() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent] = useState(loadRecent);

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
              <li key={p.projectId}>
                <Link
                  to={`/p/${encodeURIComponent(p.token)}`}
                  className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm hover:bg-muted"
                >
                  <span className="truncate font-medium">
                    {p.title || "Untitled"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dateFormat.format(p.visitedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
