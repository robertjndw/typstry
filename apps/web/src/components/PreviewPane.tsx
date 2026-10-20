import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileQuestion,
  Loader2,
  MoveHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  memo,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  animationMode,
  cancelAnimations,
  captureBefore,
  isVisible,
  playAfter,
  prefersReducedMotion,
  showHighlight,
  type AnimationKind,
} from "@/components/preview/animate";
import { followScrollTop } from "@/components/preview/follow";
import {
  pointAt,
  positionOf,
  type DocPoint,
  type Layout,
} from "@/components/preview/geometry";
import { ToolbarButton } from "@/components/ToolbarButton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatShortcut } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { CompilerClient, PreviewState } from "@/typst/compiler-client";
import type { FontsPackagesTarget } from "@/components/fonts-packages/types";
import { formatLocation, type ProjectDiagnostic } from "@/typst/diagnostics";
import { usePreviewState } from "@/typst/hooks";
import {
  PREVIEW_SCOPE_CLASS,
  type PageChange,
  type PreviewPage,
} from "@/typst/svg-pages";

export interface PreviewPaneProps {
  client: CompilerClient | null;
  onDiagnosticClick?: (diagnostic: ProjectDiagnostic) => void;
  /**
   * Opens the Fonts & Packages dialog from a missing font or package error.
   * Without it those errors show no shortcut.
   */
  onOpenFontsPackages?: (target: FontsPackagesTarget) => void;
  /** Extra toolbar buttons, shown before the zoom controls. */
  actions?: ReactNode;
  /**
   * "pane" is the workspace column with its toolbar. "viewer" is for
   * looking at a document inside other chrome (the history preview): whole
   * pages on a roomier canvas, with the controls floating over it and no
   * compile status, which means nothing to someone just looking.
   */
  variant?: "pane" | "viewer";
  className?: string;
}

// Zoom is in CSS px per typst pt. 96/72 shows pages at their physical size,
// which the toolbar labels as 100%.
const PHYSICAL = 96 / 72;
const MIN_ZOOM = 0.25 * PHYSICAL;
const MAX_ZOOM = 4 * PHYSICAL;
const ZOOM_STEP = 1.2;
const PRESETS = [50, 75, 100, 150, 200];
const PAGE_GAP = 16;
const SIDE_PADDING = 16;
const VIEWER_PADDING = 32;
// Room below the last page for the viewer's floating controls.
const VIEWER_CONTROLS_SPACE = 56;
const INDICATOR_IDLE_MS = 1000;
// Compiles faster than this never show the spinner, so it doesn't flicker on
// every keystroke.
const COMPILING_SHOWN_AFTER_MS = 300;
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);
const STALLED_TEXT =
  "Still compiling. Downloading packages or a large document can take a while.";

/** "fit" fits the page width, "page" whole pages. */
type Zoom =
  { mode: "fit" } | { mode: "page" } | { mode: "fixed"; scale: number };

/** Where a zoom should keep its document point, in viewport px. */
interface Anchor {
  point: DocPoint;
  viewX: number;
  viewY: number;
}

const clampZoom = (scale: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

export function PreviewPane({
  client,
  onDiagnosticClick,
  onOpenFontsPackages,
  actions,
  variant = "pane",
  className,
}: PreviewPaneProps) {
  const viewer = variant === "viewer";
  const defaultZoom: Zoom = viewer ? { mode: "page" } : { mode: "fit" };
  const padding = viewer ? VIEWER_PADDING : SIDE_PADDING;
  const state = usePreviewState(client);
  const [zoom, setZoom] = useState<Zoom>(defaultZoom);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  // The scale the DOM currently shows, which is what scroll offsets mean.
  const renderedScale = useRef<number | null>(null);
  // A zoom asked for but not rendered yet, so rapid wheel events compound.
  const targetScale = useRef<number | null>(null);
  const pendingAnchor = useRef<Anchor | null>(null);
  // Document point at the viewport centre, kept fresh on every scroll so a
  // resize in fit mode can restore it after the scale has already changed.
  const centerPoint = useRef<DocPoint | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // When the user last scrolled by hand. Scroll events can't tell that from
  // our own scrolling, so this is fed by input events instead.
  const lastManualScroll = useRef<number | null>(null);
  const handledFollow = useRef(state?.follow?.seq ?? 0);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      setViewportWidth(el.clientWidth);
      setViewportHeight(el.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const pages = state?.document?.pages ?? [];
  const widest = pages.reduce((w, p) => Math.max(w, p.width), 0) || 595;
  const tallest = pages.reduce((h, p) => Math.max(h, p.height), 0) || 842;
  const fitScale = Math.max(MIN_ZOOM, (viewportWidth - 2 * padding) / widest);
  const bottomSpace = viewer ? padding + VIEWER_CONTROLS_SPACE : padding;
  const pageScale = Math.min(
    fitScale,
    Math.max(MIN_ZOOM, (viewportHeight - padding - bottomSpace) / tallest),
  );
  // One request per changed page, kept as the same objects until the next
  // animation so a memoized page only rerenders when it has work to do.
  const animation = state?.animation ?? null;
  const requests = useMemo(() => {
    const byPage = new Map<number, PageAnimation>();
    const changes = animation?.changes ?? [];
    const changedPages = new Set(changes.map((c) => c.page)).size;
    for (const change of changes) {
      const have = byPage.get(change.page);
      if (have) have.changes.push(change);
      else
        byPage.set(change.page, {
          seq: animation!.seq,
          kind: animation!.kind,
          changes: [change],
          changedPages,
        });
    }
    return byPage;
  }, [animation]);
  const scaleOf = (z: Zoom) =>
    z.mode === "fit" ? fitScale : z.mode === "page" ? pageScale : z.scale;
  const scale = scaleOf(zoom);
  const pageCount = pages.length;
  const shownPage = Math.min(currentPage, Math.max(0, pageCount - 1)) + 1;

  const layoutFor = (el: HTMLElement, s: number): Layout => ({
    scale: s,
    padding,
    gap: PAGE_GAP,
    viewportWidth: el.clientWidth,
  });

  const readCenter = (el: HTMLElement, s: number) =>
    pointAt(
      pages,
      layoutFor(el, s),
      el.scrollLeft + el.clientWidth / 2,
      el.scrollTop + el.clientHeight / 2,
    );

  useLayoutEffect(() => {
    const el = viewportRef.current;
    const previous = renderedScale.current;
    renderedScale.current = scale;
    targetScale.current = null;
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!el || pages.length === 0) return;
    if (previous !== null && previous !== scale) {
      const anchor: Anchor | null =
        pending ??
        (centerPoint.current && {
          point: centerPoint.current,
          viewX: el.clientWidth / 2,
          viewY: el.clientHeight / 2,
        });
      if (anchor) {
        const pos = positionOf(pages, layoutFor(el, scale), anchor.point);
        el.scrollLeft = pos.x - anchor.viewX;
        el.scrollTop = pos.y - anchor.viewY;
      }
    }
    centerPoint.current = readCenter(el, scale);
    // layoutFor and readCenter only close over pages, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, pages]);

  // Brings an off-screen edit into view. Declared after the anchoring effect so
  // the viewport already sits where a zoom put it.
  const follow = state?.follow ?? null;
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!follow || follow.seq === handledFollow.current) return;
    handledFollow.current = follow.seq;
    if (!el || pages.length === 0) return;
    const top = followScrollTop({
      changes: follow.changes,
      pages,
      layout: layoutFor(el, scale),
      scrollTop: el.scrollTop,
      viewportHeight: el.clientHeight,
      lastManualScrollAt: lastManualScroll.current,
      now: Date.now(),
    });
    if (top === null) return;
    const near = Math.abs(top - el.scrollTop) < el.clientHeight;
    const reduced = prefersReducedMotion();
    if (near && !reduced && typeof el.scrollTo === "function")
      el.scrollTo({ top, behavior: "smooth" });
    else el.scrollTop = top;
    // layoutFor only closes over padding, which is constant per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow]);

  /**
   * Applies a zoom while keeping the document point under `view` (viewport
   * px, default the centre) in place once the new scale renders.
   */
  const applyZoom = (next: Zoom, view?: { x: number; y: number }) => {
    const el = viewportRef.current;
    const nextScale = scaleOf(next);
    const current = targetScale.current ?? renderedScale.current ?? scale;
    if (
      el &&
      pages.length > 0 &&
      renderedScale.current !== null &&
      nextScale !== current &&
      // Keep the first anchor of a burst: later events would measure scroll
      // offsets against a scale that has not rendered yet.
      !pendingAnchor.current
    ) {
      const x = view?.x ?? el.clientWidth / 2;
      const y = view?.y ?? el.clientHeight / 2;
      pendingAnchor.current = {
        point: pointAt(
          pages,
          layoutFor(el, renderedScale.current),
          el.scrollLeft + x,
          el.scrollTop + y,
        ),
        viewX: x,
        viewY: y,
      };
    }
    targetScale.current = nextScale;
    setZoom(next);
  };

  const stepZoom = (factor: number, view?: { x: number; y: number }) => {
    const base = targetScale.current ?? scale;
    applyZoom({ mode: "fixed", scale: clampZoom(base * factor) }, view);
  };

  // Pinch on a trackpad arrives as a wheel event with ctrlKey set. React
  // attaches wheel listeners as passive, so preventing the browser's own
  // page zoom needs a native listener.
  const onWheel = useEffectEvent((e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // Mouse wheels report ~100 per notch, pinches a few px per event; the
    // clamp keeps a notch from jumping too far while pinches stay smooth.
    const delta = Math.max(-50, Math.min(50, raw));
    stepZoom(Math.exp(-delta * 0.01), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const listener = (e: WheelEvent) => onWheel(e);
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const mark = () => {
      lastManualScroll.current = Date.now();
    };
    const onPointerDown = (e: PointerEvent) => {
      // Only the scrollbar counts; a click on a page is not scrolling.
      const rect = el.getBoundingClientRect();
      if (
        e.target === el &&
        (e.clientX - rect.left >= el.clientWidth ||
          e.clientY - rect.top >= el.clientHeight)
      )
        mark();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key) && !e.altKey && !e.metaKey && !e.ctrlKey)
        mark();
    };
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchstart", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchstart", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el || pages.length === 0 || renderedScale.current === null) return;
    centerPoint.current = readCenter(el, renderedScale.current);
    setCurrentPage(centerPoint.current.page);
    setScrolling(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(
      () => setScrolling(false),
      INDICATOR_IDLE_MS,
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") stepZoom(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") stepZoom(1 / ZOOM_STEP);
    else if (e.key === "0") applyZoom(defaultZoom);
    else return;
    e.preventDefault();
  };

  const percent = Math.round((scale / PHYSICAL) * 100);
  const presetValue =
    zoom.mode !== "fixed"
      ? zoom.mode
      : PRESETS.includes(percent)
        ? String(percent)
        : "";
  const zoomMenu = (
    <ZoomMenu
      percent={percent}
      value={presetValue}
      defaultMode={defaultZoom.mode}
      onChange={(value) =>
        applyZoom(
          value === "fit" || value === "page"
            ? { mode: value }
            : { mode: "fixed", scale: (Number(value) / 100) * PHYSICAL },
        )
      }
    />
  );
  const zoomOut = (
    <ToolbarButton
      label="Zoom out"
      shortcut="Mod+-"
      disabled={scale <= MIN_ZOOM}
      onClick={() => stepZoom(1 / ZOOM_STEP)}
    >
      <ZoomOut />
    </ToolbarButton>
  );
  const zoomIn = (
    <ToolbarButton
      label="Zoom in"
      shortcut="Mod+="
      disabled={scale >= MAX_ZOOM}
      onClick={() => stepZoom(ZOOM_STEP)}
    >
      <ZoomIn />
    </ToolbarButton>
  );

  return (
    <div
      className={cn(
        "@container flex h-full min-h-0 flex-col",
        viewer ? "bg-muted dark:bg-muted/30" : "bg-muted/40 dark:bg-muted/20",
        className,
      )}
    >
      {!viewer && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-2">
          <StatusIndicator state={state} />
          {pageCount > 1 && (
            <span className="ml-2 hidden text-xs text-muted-foreground tabular-nums @md:inline">
              Page {shownPage} of {pageCount}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {actions}
            {zoomOut}
            {zoomMenu}
            {zoomIn}
            <ToolbarButton
              label="Fit width"
              tooltip="Fit pages to the pane width"
              shortcut="Mod+0"
              variant={zoom.mode === "fit" ? "secondary" : "ghost"}
              aria-pressed={zoom.mode === "fit"}
              onClick={() => applyZoom({ mode: "fit" })}
            >
              <MoveHorizontal />
            </ToolbarButton>
          </div>
        </div>
      )}

      {(state?.error || state?.stalled) && pages.length > 0 && (
        <div
          role={state.error ? "alert" : "status"}
          className="flex shrink-0 animate-in items-center gap-2 border-b bg-background px-3 py-1.5 text-xs duration-150 fade-in-0 slide-in-from-top-1"
        >
          {state.error ? (
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span
            className="min-w-0 flex-1 truncate"
            title={state.error || STALLED_TEXT}
          >
            {state.error || STALLED_TEXT}
          </span>
          <Button variant="outline" size="xs" onClick={() => client?.retry()}>
            {state.error ? "Retry" : "Restart"}
          </Button>
        </div>
      )}

      {state?.fontWarning && !viewer && (
        <div
          role="status"
          className="flex shrink-0 animate-in items-center gap-2 border-b bg-background px-3 py-1.5 text-xs duration-150 fade-in-0 slide-in-from-top-1"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate" title={state.fontWarning}>
            {state.fontWarning}
          </span>
          <Button variant="outline" size="xs" onClick={() => client?.retry()}>
            Retry
          </Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          tabIndex={0}
          aria-label="Document preview"
          className={cn(
            PREVIEW_SCOPE_CLASS,
            "relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
          data-testid="preview-viewport"
          onScroll={onScroll}
          onKeyDown={onKeyDown}
        >
          {state?.document && <DefsHost defs={state.document.defs} />}
          {pages.length > 0 ? (
            <div
              className="flex w-max min-w-full flex-col items-center"
              style={{
                gap: PAGE_GAP,
                padding,
                paddingBottom: bottomSpace,
              }}
            >
              {pages.map((page, i) => (
                <PageView
                  key={i}
                  page={page}
                  index={i}
                  scale={scale}
                  animation={requests.get(i) ?? null}
                />
              ))}
            </div>
          ) : (
            <EmptyState state={state} onRetry={() => client?.retry()} />
          )}
        </div>
        {viewer && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <div className="pointer-events-auto flex h-9 items-center gap-0.5 rounded-full border bg-popover/95 px-1 text-popover-foreground shadow-lg backdrop-blur">
              {zoomOut}
              {zoomMenu}
              {zoomIn}
              {(pageCount > 1 || state?.status === "compiling") && (
                <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              )}
              {pageCount > 1 && (
                <span className="px-1.5 text-xs text-muted-foreground tabular-nums">
                  {shownPage} / {pageCount}
                </span>
              )}
              {state?.status === "compiling" && (
                <Loader2
                  aria-label="Compiling"
                  className="mx-1.5 size-3.5 animate-spin text-muted-foreground"
                />
              )}
            </div>
          </div>
        )}
        {!viewer && pageCount > 1 && (
          <div
            aria-hidden
            data-visible={scrolling}
            className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-popover/90 px-2.5 py-1 text-xs text-popover-foreground tabular-nums opacity-0 shadow-sm backdrop-blur transition-opacity duration-300 data-[visible=true]:opacity-100 data-[visible=true]:duration-100"
          >
            Page {shownPage} of {pageCount}
          </div>
        )}
      </div>

      {state && state.diagnostics.length > 0 && (
        <ProblemsPanel
          diagnostics={state.diagnostics}
          onDiagnosticClick={onDiagnosticClick}
          onOpenFontsPackages={viewer ? undefined : onOpenFontsPackages}
        />
      )}
    </div>
  );
}

function ZoomMenu({
  percent,
  value,
  defaultMode,
  onChange,
}: {
  percent: number;
  value: string;
  /** Which fit Mod+0 goes back to, for the shortcut hint. */
  defaultMode: "fit" | "page";
  onChange: (value: string) => void;
}) {
  const fits = [
    { value: "page", label: "Fit page" },
    { value: "fit", label: "Fit width" },
  ];
  return (
    <DropdownMenu>
      <WithTooltip label="Zoom level, 100% is the printed size">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label="Zoom level"
            className="w-13 px-1 font-normal text-muted-foreground tabular-nums"
          >
            {percent}%
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {fits.map((fit) => (
            <DropdownMenuRadioItem key={fit.value} value={fit.value}>
              {fit.label}
              {fit.value === defaultMode && (
                <DropdownMenuShortcut>
                  {formatShortcut("Mod+0")}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          {PRESETS.map((p) => (
            <DropdownMenuRadioItem key={p} value={String(p)}>
              {p}%
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusIndicator({ state: live }: { state: PreviewState | null }) {
  const compiling = live?.status === "compiling";
  // The latest state that wasn't a compile in progress, shown instead of
  // "Compiling" until the compile has run for a while.
  const [settled, setSettled] = useState(live);
  if (live && !compiling && settled !== live) setSettled(live);
  const [slow, setSlow] = useState(false);
  if (!compiling && slow) setSlow(false);
  useEffect(() => {
    if (!compiling) return;
    const timer = setTimeout(() => setSlow(true), COMPILING_SHOWN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [compiling]);

  const hasEarlier =
    settled !== null &&
    (settled.status === "error" || settled.compileMs !== null);
  const state = compiling && !slow && hasEarlier ? settled : live;
  if (!state || state.status === "starting") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Starting Typst
      </span>
    );
  }
  const time =
    state.compileMs !== null ? `${Math.round(state.compileMs)} ms` : null;
  const description =
    state.status === "compiling"
      ? "Compiling the main file"
      : state.status === "error"
        ? "Last compile failed, showing the last good result. Errors are listed below."
        : state.totalMs !== null
          ? `Up to date. Compile took ${time}, compile and render ${Math.round(state.totalMs)} ms.`
          : "Up to date";
  return (
    <WithTooltip label={description}>
      <span
        className="flex cursor-default items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="status"
        tabIndex={0}
      >
        {state.status === "compiling" ? (
          <Loader2 className="size-3.5 animate-spin" aria-label="Compiling" />
        ) : state.status === "error" ? (
          <AlertCircle
            className="size-3.5 text-destructive"
            aria-label="Error"
          />
        ) : (
          <CheckCircle2
            className="size-3.5 text-success"
            aria-label="Up to date"
          />
        )}
        {/* The error count lives in the problems panel header; repeating it
            here would read twice to screen readers. */}
        {state.status === "error"
          ? "Failed"
          : state.status === "compiling"
            ? "Compiling"
            : time}
      </span>
    </WithTooltip>
  );
}

function WithTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({
  state,
  onRetry,
}: {
  state: PreviewState | null;
  onRetry: () => void;
}) {
  let text = "Loading the Typst compiler";
  let icon = <Loader2 className="size-5 animate-spin" />;
  if (state?.error) {
    text = state.error;
    icon = <AlertCircle className="size-5 text-destructive" />;
  } else if (state && state.status !== "starting" && state.mainPath === null) {
    text = "No main file. Pick one in the file tree.";
    icon = <FileQuestion className="size-5" />;
  } else if (state?.status === "error") {
    text = "The document has errors and nothing has rendered yet.";
    icon = <AlertCircle className="size-5 text-destructive" />;
  } else if (state?.stalled) {
    text = STALLED_TEXT;
  } else if (state && state.status !== "starting") {
    text = "Rendering";
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted"
      >
        {icon}
      </span>
      <p className="max-w-xs text-balance">{text}</p>
      {(state?.error || state?.stalled) && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {state.error ? "Retry" : "Restart"}
        </Button>
      )}
    </div>
  );
}

/** Glyph and gradient defs must live in the same document as the pages. */
function DefsHost({ defs }: { defs: SVGSVGElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(defs);
  }, [defs]);
  return (
    <div ref={ref} aria-hidden className="absolute size-0 overflow-hidden" />
  );
}

interface PageAnimation {
  seq: number;
  kind: AnimationKind;
  changes: PageChange[];
  changedPages: number;
}

const PageView = memo(function PageView({
  page,
  index,
  scale,
  animation,
}: {
  page: PreviewPage;
  index: number;
  scale: number;
  animation: PageAnimation | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const renderedScale = useRef(scale);
  const handledSeq = useRef(animation?.seq ?? 0);

  // Runs between the old page leaving and the new one arriving, the only
  // moment both exist, so measuring takes one read pass on each side.
  const swap = useEffectEvent((slot: HTMLElement, el: SVGSVGElement) => {
    const old = slot.firstChild;
    const request = animation?.seq !== handledSeq.current ? animation : null;
    handledSeq.current = animation?.seq ?? handledSeq.current;
    const viewport = slot.closest(`.${PREVIEW_SCOPE_CLASS}`);
    const mode =
      request && old instanceof SVGSVGElement && viewport
        ? animationMode(request.kind, {
            reducedMotion: prefersReducedMotion(),
            scaleChanged: renderedScale.current !== scale,
            changedPages: request.changedPages,
            visible: request.kind === "external" || isVisible(slot, viewport),
          })
        : null;
    const captured =
      mode === "typed" ? captureBefore(old as SVGSVGElement, el) : null;
    slot.replaceChildren(el);
    if (old instanceof SVGSVGElement) cancelAnimations(old);
    if (captured) playAfter(captured, el);
    else if (mode === "external" && overlayRef.current) {
      for (const change of request!.changes)
        showHighlight(overlayRef.current, change, page.width, scale);
    }
  });

  useLayoutEffect(() => {
    const el = page.element;
    el.setAttribute("width", "100%");
    el.setAttribute("height", "100%");
    if (ref.current && ref.current.firstChild !== el) swap(ref.current, el);
    // swap is an effect event.
  }, [page]);
  useLayoutEffect(() => {
    renderedScale.current = scale;
  });
  const width = page.width * scale;
  const height = page.height * scale;
  return (
    <div
      role="img"
      aria-label={`Page ${index + 1}`}
      // Pages stay white paper in dark mode; the brighter ring keeps their
      // edge visible where a shadow alone vanishes against a dark canvas.
      className="relative shrink-0 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_16px_rgb(0_0_0/0.08)] ring-1 ring-black/10 dark:shadow-[0_2px_8px_rgb(0_0_0/0.5)] dark:ring-white/15"
      style={{
        width,
        height,
        // Lets the browser skip painting pages far outside the viewport.
        contentVisibility: "auto",
        containIntrinsicSize: `${width}px ${height}px`,
      }}
    >
      <div ref={ref} className="size-full" />
      {/* Not part of the SVG slot, so a page swap does not wipe highlights. */}
      <div
        ref={overlayRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
    </div>
  );
});

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ProblemsPanel({
  diagnostics,
  onDiagnosticClick,
  onOpenFontsPackages,
}: {
  diagnostics: ProjectDiagnostic[];
  onDiagnosticClick?: (d: ProjectDiagnostic) => void;
  onOpenFontsPackages?: (target: FontsPackagesTarget) => void;
}) {
  const listId = useId();
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  // Until the user toggles it, the panel is open for errors and collapsed for
  // warnings alone, so warnings don't eat preview space.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const collapsed = chosen ?? errors === 0;
  // New errors after a clean (warnings only) build reopen the panel even if the
  // user collapsed it. The panel unmounts at zero problems, which resets this.
  const [prevErrors, setPrevErrors] = useState(errors);
  if (errors !== prevErrors) {
    setPrevErrors(errors);
    if (prevErrors === 0 && errors > 0) setChosen(null);
  }

  return (
    <section
      className="flex max-h-[40%] min-h-0 shrink-0 animate-in flex-col border-t bg-background duration-200 fade-in-0 slide-in-from-bottom-2"
      aria-label="Diagnostics"
    >
      <button
        type="button"
        className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-xs outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => setChosen(!collapsed)}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <span className="font-medium">Problems</span>
        <span className="ml-1 flex items-center gap-2.5 text-muted-foreground">
          {errors > 0 && (
            <span className="flex items-center gap-1">
              <AlertCircle aria-hidden className="size-3.5 text-destructive" />
              {plural(errors, "error")}
            </span>
          )}
          {warnings > 0 && (
            <span className="flex items-center gap-1">
              <AlertTriangle aria-hidden className="size-3.5 text-warning" />
              {plural(warnings, "warning")}
            </span>
          )}
        </span>
      </button>
      {/* Kept mounted so collapsing animates too. Height can't transition
          to auto, but grid rows can go from 0fr to 1fr. */}
      <div
        inert={collapsed}
        className={cn(
          "grid min-h-0 transition-[grid-template-rows] duration-200 ease-out",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <ul
          id={listId}
          // The border would leave a 1px sliver when collapsed.
          className={cn(
            "min-h-0 overflow-auto text-xs",
            !collapsed && "border-t",
          )}
        >
          {diagnostics.map((d, i) => {
            const Icon = d.severity === "error" ? AlertCircle : AlertTriangle;
            const hint = onOpenFontsPackages && d.hint;
            return (
              <li key={i} className="flex items-start">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 px-3 py-1.5 text-left outline-none focus-visible:bg-muted enabled:hover:bg-muted disabled:cursor-default"
                  disabled={!onDiagnosticClick || d.path === null}
                  onClick={() => onDiagnosticClick?.(d)}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      d.severity === "error"
                        ? "text-destructive"
                        : "text-warning",
                    )}
                  />
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {formatLocation(d)}
                  </span>
                  <span className="min-w-0 break-words whitespace-pre-wrap">
                    {d.message}
                  </span>
                </button>
                {hint && (
                  // A sibling, not inside the row button: buttons can't nest.
                  <Button
                    variant="link"
                    size="xs"
                    className="my-0.5 mr-2 shrink-0"
                    onClick={() =>
                      onOpenFontsPackages(
                        hint.kind === "font"
                          ? { tab: "fonts" }
                          : {
                              tab: "packages",
                              ...(hint.spec ? { prefill: hint.spec } : {}),
                            },
                      )
                    }
                  >
                    {hint.kind === "font" ? "Upload font…" : "Add package…"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
