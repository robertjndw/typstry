import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Full-page message for the states where there is no workspace to show. */
export function Notice({
  icon: Icon,
  tone = "muted",
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  tone?: "muted" | "destructive";
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div
          aria-hidden
          className={cn(
            "flex size-12 items-center justify-center rounded-full",
            tone === "destructive"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-6" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm break-words text-muted-foreground">
            {children}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      </div>
    </main>
  );
}
