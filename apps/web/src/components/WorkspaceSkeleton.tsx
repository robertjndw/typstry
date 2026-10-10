import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";

const LINE_WIDTHS = ["w-3/5", "w-4/5", "w-2/5", "w-full", "w-3/4", "w-1/2"];

/**
 * Placeholder shaped like the workspace, so opening a project does not jump
 * from a centered spinner to a full layout. `children` (the status text and
 * any slow-connection notice) sits on top of it.
 */
export function WorkspaceSkeleton({ children }: { children?: ReactNode }) {
  const mobile = useIsMobile();
  return (
    <div className="relative flex h-svh flex-col">
      <div
        aria-hidden
        className="flex h-11 shrink-0 items-center gap-2 border-b px-2"
      >
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-32" />
        <div className="ml-auto flex items-center gap-2">
          {!mobile && <Skeleton className="size-7" />}
          {!mobile && <Skeleton className="size-7" />}
          <Skeleton className="h-7 w-16" />
          <Skeleton className="size-6 rounded-full" />
        </div>
      </div>
      <div aria-hidden className="flex min-h-0 flex-1">
        {!mobile && (
          <div className="flex w-1/5 min-w-40 flex-col gap-2 border-r p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        <div className="flex flex-1 flex-col gap-2.5 p-4">
          {LINE_WIDTHS.map((width, i) => (
            <Skeleton key={i} className={`h-3.5 ${width}`} />
          ))}
        </div>
        {!mobile && (
          <div className="flex w-2/5 justify-center border-l bg-muted/30 p-6">
            <Skeleton className="aspect-[1/1.414] h-fit w-full max-w-72 rounded-sm" />
          </div>
        )}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border bg-background/95 px-6 py-5 text-center shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}
