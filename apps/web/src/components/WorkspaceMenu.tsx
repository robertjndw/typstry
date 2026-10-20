import {
  DownloadIcon,
  EllipsisIcon,
  FileSearchIcon,
  HistoryIcon,
  KeyboardIcon,
  ListTreeIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  TypeIcon,
} from "lucide-react";

import type { SidebarTab } from "@/hooks/use-sidebar-tab";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useZipDownload } from "@/hooks/use-download";
import type { WorkspaceLayoutState } from "@/hooks/use-workspace-layout";
import { formatShortcut } from "@/lib/platform";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useProject } from "@/project/context";

/** The workspace's overflow menu: everything that needs no toolbar spot. */
export function WorkspaceMenu({
  layout,
  panelsDisabled = false,
  onHistory,
  onTagVersion,
  onQuickOpen,
  onShortcuts,
  onFontsPackages,
  onSyncNow,
  sidebarTabs = [],
  onOpenSidebar,
}: {
  layout: WorkspaceLayoutState;
  /** While a version is open the live panels are not on screen. */
  panelsDisabled?: boolean;
  onHistory: () => void;
  /** Absent without write access. */
  onTagVersion?: () => void;
  onQuickOpen: () => void;
  onShortcuts: () => void;
  onFontsPackages: () => void;
  /** Absent when there is no server connection to push to. */
  onSyncNow?: () => void;
  /** Sidebar tabs beyond Files; each gets an entry. */
  sidebarTabs?: readonly SidebarTab[];
  onOpenSidebar?: (tab: SidebarTab) => void;
}) {
  const { project, assets, title } = useProject();
  // Lives here rather than in the menu content, which unmounts on close
  // while the zip is still being built.
  const zip = useZipDownload({ project, assets, name: [title] });
  const desktop = !layout.isMobile;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              {zip.busy ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <EllipsisIcon />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onQuickOpen}>
            <SearchIcon />
            Open file…
            {desktop && (
              <DropdownMenuShortcut>
                {formatShortcut(SHORTCUTS.quickOpen)}
              </DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
          {onSyncNow && (
            <DropdownMenuItem onSelect={onSyncNow}>
              <RefreshCwIcon />
              Sync now
              {desktop && (
                <DropdownMenuShortcut>
                  {formatShortcut(SHORTCUTS.syncNow)}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onFontsPackages}>
            <TypeIcon />
            Fonts &amp; packages…
            {desktop && (
              <DropdownMenuShortcut>
                {formatShortcut(SHORTCUTS.fontsPackages)}
              </DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
          {sidebarTabs.includes("search") && (
            <DropdownMenuItem onSelect={() => onOpenSidebar?.("search")}>
              <FileSearchIcon />
              Search project
              {desktop && (
                <DropdownMenuShortcut>
                  {formatShortcut(SHORTCUTS.search)}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          )}
          {sidebarTabs.includes("outline") && (
            <DropdownMenuItem onSelect={() => onOpenSidebar?.("outline")}>
              <ListTreeIcon />
              Outline
              {desktop && (
                <DropdownMenuShortcut>
                  {formatShortcut(SHORTCUTS.outline)}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={zip.busy} onSelect={zip.run}>
            <DownloadIcon />
            Download as zip
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onHistory}>
            <HistoryIcon />
            History
          </DropdownMenuItem>
          {onTagVersion && (
            <DropdownMenuItem onSelect={onTagVersion}>
              <TagIcon />
              Tag current version…
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {desktop && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuCheckboxItem
                checked={!layout.isHidden("files")}
                disabled={panelsDisabled}
                onCheckedChange={() => layout.toggle("files")}
              >
                Files panel
                <DropdownMenuShortcut>
                  {formatShortcut(SHORTCUTS.toggleFiles)}
                </DropdownMenuShortcut>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={!layout.isHidden("preview")}
                disabled={panelsDisabled}
                onCheckedChange={() => layout.toggle("preview")}
              >
                Preview panel
                <DropdownMenuShortcut>
                  {formatShortcut(SHORTCUTS.togglePreview)}
                </DropdownMenuShortcut>
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem onSelect={onShortcuts}>
                <KeyboardIcon />
                Keyboard shortcuts
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
