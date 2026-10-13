import { useEffect, useRef, useState } from "react";
import {
  useDefaultLayout,
  usePanelRef,
  type LayoutStorage,
  type PanelSize,
} from "react-resizable-panels";

import { useIsMobile } from "@/hooks/use-mobile";
import { getStorage } from "@/lib/storage";
import { useProject } from "@/project/context";

export type WorkspaceView = "files" | "editor" | "preview";
export type CollapsiblePanel = "files" | "preview";

/** Keep in sync with the `[data-animating]` transition in index.css. */
const TOGGLE_MS = 200;

/** Percentages of the group; also what a panel reopens to after a reload. */
export const DEFAULT_SIZES: Record<WorkspaceView, number> = {
  files: 20,
  editor: 40,
  preview: 40,
};

// The library's default is a bare localStorage, which throws in some
// private modes before our components even render.
const layoutStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return getStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      getStorage()?.setItem(key, value);
    } catch {
      // A layout that is not remembered is fine.
    }
  },
};

/**
 * State for the files / editor / preview split: a persisted resizable
 * layout with collapsible side panels on desktop, and a single visible view
 * on phones. Collapsed panels are just size 0 in the saved layout, so they
 * stay collapsed across reloads for free.
 *
 * `id` must be stable and unique per kind of layout; it keys the storage.
 */
export function useWorkspaceLayout(id: string) {
  const isMobile = useIsMobile();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    storage: layoutStorage,
  });
  const ids = {
    files: `${id}-files`,
    editor: `${id}-editor`,
    preview: `${id}-preview`,
  } as const;

  const filesRef = usePanelRef();
  const previewRef = usePanelRef();
  const refs = { files: filesRef, preview: previewRef };
  const [collapsed, setCollapsed] = useState(() => ({
    files: defaultLayout?.[ids.files] === 0,
    preview: defaultLayout?.[ids.preview] === 0,
  }));
  // Whether the panel had a real size during this session. Only then does
  // expand() know where to go back to; otherwise it would open at minSize.
  const hadSize = useRef({ files: false, preview: false });
  const [view, setView] = useState<WorkspaceView>("editor");
  // Only animate toggles. With the transition always on, dragging a handle
  // lags behind the pointer. During a toggle the panel's content keeps a
  // fixed width and gets clipped. Otherwise the preview refits its pages on
  // every frame and you watch them shrink.
  const [pinned, setPinned] = useState<{
    panel: CollapsiblePanel;
    width: number;
  } | null>(null);
  const animationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(animationTimer.current), []);

  // On a phone, opening a file from anywhere (the tree, quick open, a
  // diagnostic) should show it rather than leave you on another view.
  const { openFileId } = useProject();
  const [shownFile, setShownFile] = useState(openFileId);
  if (shownFile !== openFileId) {
    setShownFile(openFileId);
    if (openFileId) setView("editor");
  }

  function onResize(panel: CollapsiblePanel) {
    return (size: PanelSize) => {
      const isCollapsed = size.asPercentage < 0.01;
      if (!isCollapsed) hadSize.current[panel] = true;
      setCollapsed((prev) =>
        prev[panel] === isCollapsed ? prev : { ...prev, [panel]: isCollapsed },
      );
    };
  }

  function toggle(panel: CollapsiblePanel) {
    if (isMobile) {
      setView((current) => (current === panel ? "editor" : panel));
      return;
    }
    const handle = refs[panel].current;
    if (!handle) return;
    // The content keeps the panel's open width. When closing, that's the
    // width it has now. When opening, it's the width it's about to get.
    let width = handle.getSize().inPixels;
    if (!handle.isCollapsed()) {
      handle.collapse();
    } else {
      if (hadSize.current[panel]) handle.expand();
      else handle.resize(String(DEFAULT_SIZES[panel]));
      // inPixels still reads the old width from the DOM at this point, but
      // the percentage is already the new one.
      const panels = document
        .getElementById(id)
        ?.querySelectorAll(":scope > [data-panel]");
      const total = Array.from(panels ?? []).reduce(
        (sum, el) => sum + el.getBoundingClientRect().width,
        0,
      );
      width = (handle.getSize().asPercentage / 100) * total;
    }
    setPinned({ panel, width });
    clearTimeout(animationTimer.current);
    // Not transitionend: if the size doesn't actually change, it never
    // fires and the pin would stick.
    animationTimer.current = setTimeout(() => setPinned(null), TOGGLE_MS + 50);
  }

  return {
    isMobile,
    ids,
    view,
    setView,
    /** Hidden on desktop, or not the current view on a phone. */
    isHidden: (panel: CollapsiblePanel) =>
      isMobile ? view !== panel : collapsed[panel],
    toggle,
    /** Set only while a toggle is animating. */
    pinnedWidth: (panel: CollapsiblePanel) =>
      pinned?.panel === panel ? pinned.width : undefined,
    group: {
      id,
      defaultLayout,
      onLayoutChanged,
      "data-animating": pinned !== null || undefined,
    },
    panels: {
      files: { panelRef: filesRef, onResize: onResize("files") },
      preview: { panelRef: previewRef, onResize: onResize("preview") },
    },
  };
}

export type WorkspaceLayoutState = ReturnType<typeof useWorkspaceLayout>;
