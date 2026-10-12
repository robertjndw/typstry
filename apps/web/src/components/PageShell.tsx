import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";

import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

/**
 * The header and centered column of the pages outside a project. `outside`
 * goes after the column, for dialogs and overlays that are not part of it.
 */
export function PageShell({
  brand = (
    <Link to="/" className="text-sm font-semibold tracking-tight">
      typstry
    </Link>
  ),
  actions = <ThemeToggle />,
  mainClassName = "max-w-md gap-6",
  outside,
  children,
  ...props
}: {
  brand?: ReactNode;
  actions?: ReactNode;
  /** Width and spacing of the column. */
  mainClassName?: string;
  outside?: ReactNode;
  children: ReactNode;
} & Omit<ComponentProps<"div">, "className">) {
  return (
    <div className="flex min-h-svh flex-col" {...props}>
      <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
        {brand}
        {actions}
      </header>
      <main
        className={cn(
          "mx-auto flex w-full flex-1 flex-col px-4 pt-10 pb-16",
          mainClassName,
        )}
      >
        {children}
      </main>
      {outside}
    </div>
  );
}
