import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const OPTIONS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
] as const;

/**
 * A "Theme" row with a segmented light/dark/system control, for embedding
 * in a dropdown menu.
 */
export function ThemeMenuItems() {
  const { theme = "system", setTheme } = useTheme();
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1">
      <span className="text-xs font-medium text-muted-foreground">Theme</span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="Theme"
        value={theme}
        // Clicking the active option would clear a single toggle group.
        onValueChange={(value) => value && setTheme(value)}
      >
        {OPTIONS.map(({ value, label, Icon }) => (
          // Each option is also a menu item, so the menu's arrow keys can
          // reach the row. The menu moves focus up and down, the toggle
          // group left and right, so the two never fight over a key.
          <DropdownMenuItem
            key={value}
            asChild
            onSelect={(event) => {
              // Keep the menu open so the change is visible in place.
              event.preventDefault();
              setTheme(value);
            }}
          >
            <ToggleGroupItem
              value={value}
              role="menuitemradio"
              aria-checked={theme === value}
              aria-label={label}
              title={label}
              className="px-2 focus:bg-accent"
            >
              <Icon />
            </ToggleGroupItem>
          </DropdownMenuItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Standalone icon button with its own menu, for pages without one. */
export function ThemeToggle({ className }: { className?: string }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Theme"
              className={className}
            >
              {/* Both icons render so the right one shows before hydration
                  of the stored theme, driven purely by the .dark class. */}
              <SunIcon className="dark:hidden" />
              <MoonIcon className="hidden dark:block" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
