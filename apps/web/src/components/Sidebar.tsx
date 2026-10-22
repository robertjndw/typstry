import {
  FilesIcon,
  ListTreeIcon,
  MessageSquareIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { FileTree } from "@/components/FileTree";
import { ShortcutKeys } from "@/components/ShortcutKeys";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ariaKeyShortcut } from "@/lib/platform";
import { SHORTCUTS } from "@/lib/shortcuts";
import {
  isSidebarTab,
  SIDEBAR_PANEL_ATTR,
  type SidebarTab,
} from "@/hooks/use-sidebar-tab";

const TABS: {
  tab: SidebarTab;
  label: string;
  Icon: LucideIcon;
  shortcut?: string;
}[] = [
  { tab: "files", label: "Files", Icon: FilesIcon },
  {
    tab: "outline",
    label: "Outline",
    Icon: ListTreeIcon,
    shortcut: SHORTCUTS.outline,
  },
  {
    tab: "search",
    label: "Search",
    Icon: SearchIcon,
    shortcut: SHORTCUTS.search,
  },
  { tab: "comments", label: "Comments", Icon: MessageSquareIcon },
];

export interface SidebarProps {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  /** Passed through to the file tree's header and body. */
  heading?: ReactNode;
  notice?: ReactNode;
  /** A tab shows up only when its panel is given. */
  outline?: ReactNode;
  search?: ReactNode;
  comments?: ReactNode;
  /** A count shown on a tab, e.g. open comment threads. Hidden at 0. */
  badges?: Partial<Record<SidebarTab, number>>;
}

/** The workspace's left column: the file tree plus whatever panels exist. */
export function Sidebar({
  tab,
  onTabChange,
  heading,
  notice,
  outline,
  search,
  comments,
  badges,
}: SidebarProps) {
  const panels: Record<SidebarTab, ReactNode> = {
    files: <FileTree heading={heading} notice={notice} />,
    outline,
    search,
    comments,
  };
  const shown = TABS.filter(({ tab }) => panels[tab] != null);
  const single = shown.length === 1;

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => isSidebarTab(value) && onTabChange(value)}
      className="h-full min-h-0 gap-0"
    >
      {/* A lone Files tab would be a bar with nothing to switch to. */}
      {!single && (
        <TabsList
          aria-label="Sidebar"
          variant="line"
          className="h-9 w-full shrink-0 justify-start gap-0.5 rounded-none border-b px-1.5"
        >
          {shown.map(({ tab: value, label, Icon, shortcut }) => {
            const badge = badges?.[value] ?? 0;
            return (
              <Tooltip key={value}>
                {/* Both triggers set data-state, and the outer one's loses.
                    With the tooltip outside, its "closed" would hide which
                    tab is active. */}
                <TabsTrigger
                  asChild
                  value={value}
                  aria-label={badge > 0 ? `${label} (${badge})` : label}
                  aria-keyshortcuts={shortcut && ariaKeyShortcut(shortcut)}
                  className="relative size-7 flex-none"
                >
                  <TooltipTrigger>
                    <Icon className="size-4" />
                    {badge > 0 && (
                      <span
                        aria-hidden
                        className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-semibold text-primary-foreground tabular-nums"
                      >
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </TooltipTrigger>
                </TabsTrigger>
                <TooltipContent side="bottom">
                  {label}
                  {shortcut && <ShortcutKeys combo={shortcut} />}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TabsList>
      )}
      {shown.map(({ tab: value }) => (
        <TabsContent
          key={value}
          value={value}
          {...{ [SIDEBAR_PANEL_ATTR]: value }}
          // The tree keeps its expanded folders and scroll position while
          // another tab is up. Other panels remount fresh.
          forceMount={value === "files" ? true : undefined}
          className="min-h-0 data-[state=inactive]:hidden"
        >
          {panels[value]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
