import { useCallback, useState } from "react";

import { readJson, writeJson } from "@/lib/storage";

export type SidebarTab = "files" | "outline" | "search" | "comments";

const TABS: readonly SidebarTab[] = ["files", "outline", "search", "comments"];
const STORAGE_KEY = "typstry:sidebar-tab";

/** Panels may mark their main input with this so opening the tab focuses it. */
export const SIDEBAR_AUTOFOCUS_ATTR = "data-sidebar-autofocus";
export const SIDEBAR_PANEL_ATTR = "data-sidebar-panel";

export function isSidebarTab(value: unknown): value is SidebarTab {
  return TABS.some((tab) => tab === value);
}

/**
 * The remembered sidebar tab. A stored tab that is not available (its panel
 * is not there for this project, say) falls back to Files without
 * forgetting it.
 */
export function useSidebarTab(
  available: readonly SidebarTab[],
): [SidebarTab, (tab: SidebarTab) => void] {
  const [stored, setStored] = useState<unknown>(() => readJson(STORAGE_KEY));
  const tab: SidebarTab =
    isSidebarTab(stored) && available.includes(stored) ? stored : "files";
  const select = useCallback((next: SidebarTab) => {
    setStored(next);
    writeJson(STORAGE_KEY, next);
  }, []);
  return [tab, select];
}
