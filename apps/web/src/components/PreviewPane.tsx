import { cn } from "cn";
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
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  pageIndexAt,
  pointAt,
  positionOf,
  type DocPoint,
  type Layout,
} from "@/components/preview/geometry";
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
import type { CompilerClient, PreviewState } from "@/typst/compiler-client";
import { formatLocation, type ProjectDiagnostic } from "@/typst/diagnostics";
import { usePreviewState } from "@/typst/hooks";
import type { PreviewPage } from "@/typst/svg-pages";

export interface PreviewPaneProps {
  client: CompilerClient | null;
  onDiagnosticClick?: (diagnostic: ProjectDiagnostic) => void;
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

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad)/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

export function PreviewPane({
  client,
  onDiagnosticClick,
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

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el || pages.length === 0 || renderedScale.current === null) return;
    const layout = layoutFor(el, renderedScale.current);
    centerPoint.current = readCenter(el, renderedScale.current);
    setCurrentPage(
      pageIndexAt(pages, layout, el.scrollTop + el.clientHeight / 2),
    );
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
    <WithTooltip label={`Zoom out (${MOD}-)`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        disabled={scale <= MIN_ZOOM}
        onClick={() => stepZoom(1 / ZOOM_STEP)}
      >
        <ZoomOut />
      </Button>
    </WithTooltip>
  );
  const zoomIn = (
    <WithTooltip label={`Zoom in (${MOD}+)`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        disabled={scale >= MAX_ZOOM}
        onClick={() => stepZoom(ZOOM_STEP)}
      >
        <ZoomIn />
      </Button>
    </WithTooltip>
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
            <WithTooltip label={`Fit pages to the pane width (${MOD}0)`}>
              <Button
                variant={zoom.mode === "fit" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Fit width"
                aria-pressed={zoom.mode === "fit"}
                onClick={() => applyZoom({ mode: "fit" })}
              >
                <MoveHorizontal />
              </Button>
            </WithTooltip>
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          tabIndex={0}
          aria-label="Document preview"
          className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
                <PageView key={i} page={page} index={i} scale={scale} />
              ))}
            </div>
          ) : (
            <EmptyState state={state} />
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
                <DropdownMenuShortcut>{MOD}0</DropdownMenuShortcut>
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

function StatusIndicator({ state }: { state: PreviewState | null }) {
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

function EmptyState({ state }: { state: PreviewState | null }) {
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

const PageView = memo(function PageView({
  page,
  index,
  scale,
}: {
  page: PreviewPage;
  index: number;
  scale: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = page.element;
    el.setAttribute("width", "100%");
    el.setAttribute("height", "100%");
    if (ref.current && ref.current.firstChild !== el) {
      ref.current.replaceChildren(el);
    }
  }, [page]);
  const width = page.width * scale;
  const height = page.height * scale;
  return (
    <div
      ref={ref}
      role="img"
      aria-label={`Page ${index + 1}`}
      // Pages stay white paper in dark mode; the brighter ring keeps their
      // edge visible where a shadow alone vanishes against a dark canvas.
      className="shrink-0 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_16px_rgb(0_0_0/0.08)] ring-1 ring-black/10 dark:shadow-[0_2px_8px_rgb(0_0_0/0.5)] dark:ring-white/15"
      style={{
        width,
        height,
        // Lets the browser skip painting pages far outside the viewport.
        contentVisibility: "auto",
        containIntrinsicSize: `${width}px ${height}px`,
      }}
    />
  );
});

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ProblemsPanel({
  diagnostics,
  onDiagnosticClick,
}: {
  diagnostics: ProjectDiagnostic[];
  onDiagnosticClick?: (d: ProjectDiagnostic) => void;
}) {
  const listId = useId();
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const [collapsed, setCollapsed] = useState(false);
  // New errors after a clean (warnings only) build deserve attention even if
  // the panel was collapsed. The panel unmounts at zero problems, which
  // resets the manual collapse too.
  const [prevErrors, setPrevErrors] = useState(errors);
  if (errors !== prevErrors) {
    setPrevErrors(errors);
    if (prevErrors === 0 && errors > 0) setCollapsed(false);
  }

  return (
    <section
      className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t bg-background"
      aria-label="Diagnostics"
    >
      <button
        type="button"
        className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-xs outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => setCollapsed((c) => !c)}
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
      {!collapsed && (
        <ul id={listId} className="min-h-0 overflow-auto border-t text-xs">
          {diagnostics.map((d, i) => {
            const Icon = d.severity === "error" ? AlertCircle : AlertTriangle;
            return (
              <li key={i}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 px-3 py-1.5 text-left outline-none focus-visible:bg-muted enabled:hover:bg-muted disabled:cursor-default"
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
