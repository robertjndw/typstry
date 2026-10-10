import type { ComponentProps, ReactNode } from "react";

import { ShortcutKeys } from "@/components/ShortcutKeys";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ariaKeyShortcut } from "@/lib/platform";

/** Icon-only toolbar button; its label doubles as the tooltip. */
export function ToolbarButton({
  label,
  tooltip = label,
  shortcut,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label"> & {
  label: string;
  /** Tooltip text when it should differ from the accessible name. */
  tooltip?: ReactNode;
  shortcut?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-keyshortcuts={shortcut ? ariaKeyShortcut(shortcut) : undefined}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {tooltip}
        {shortcut && <ShortcutKeys combo={shortcut} />}
      </TooltipContent>
    </Tooltip>
  );
}
