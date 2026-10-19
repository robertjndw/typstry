import { toast } from "sonner";

/** Tells the user which files an import left out for their names. */
export function warnSkipped(skipped: string[]): void {
  if (skipped.length === 0) return;
  const count = skipped.length;
  toast.warning(
    `Left out ${count} ${count === 1 ? "file" : "files"} with names a project cannot hold`,
    { description: skipped.slice(0, 5).join(", ") },
  );
}
