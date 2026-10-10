import { useRef, useState, type KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";
import { setTitle } from "@/doc/fs-ops";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";
import { attempt } from "@/project/tree";

/** The project title in the toolbar; click to rename (with write access). */
export function ProjectTitle({ className }: { className?: string }) {
  const { title, project, readOnly } = useProject();
  const [draft, setDraft] = useState<string | null>(null);
  // Leaving edit mode unmounts the focused input, and some browsers fire a
  // blur for that. This keeps Escape from committing through that blur.
  const editing = useRef(false);
  const start = () => {
    editing.current = true;
    setDraft(title);
  };
  const stop = () => {
    editing.current = false;
    setDraft(null);
  };
  const shown = title || "Untitled";

  if (readOnly) {
    return (
      <span
        title={shown}
        className={cn(
          "min-w-0 truncate px-1 text-sm font-medium text-foreground",
          className,
        )}
      >
        {shown}
      </span>
    );
  }

  if (draft === null) {
    return (
      <button
        type="button"
        aria-label={`Project title: ${shown}. Click to rename`}
        title={`${shown} (click to rename)`}
        onClick={start}
        className={cn(
          "h-7 min-w-0 truncate rounded-md px-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        {shown}
      </button>
    );
  }

  const commit = () => {
    if (!editing.current) return;
    stop();
    attempt(() => setTitle(project, draft));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      stop();
    }
  };

  return (
    <Input
      aria-label="Project title"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      className={cn("h-7 w-64 min-w-0 text-sm", className)}
    />
  );
}
