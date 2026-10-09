import { cn } from "cn";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MoveHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
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
  className?: string;
}

// Zoom is in CSS px per typst pt. 96/72 shows pages at their physical size,
// which the toolbar labels as 100%.
const PHYSICAL = 96 / 72;
const MIN_ZOOM = 0.25 * PHYSICAL;
const MAX_ZOOM = 4 * PHYSICAL;
const PAGE_GAP = 16;
const SIDE_PADDING = 16;

type Zoom = { mode: "fit" } | { mode: "fixed"; scale: number };

export function PreviewPane({
  client,
  onDiagnosticClick,
  actions,
  className,
}: PreviewPaneProps) {
  const state = usePreviewState(client);
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit" });
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    observer.observe(el);
    setViewportWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const pages = state?.document?.pages ?? [];
  const widest = pages.reduce((w, p) => Math.max(w, p.width), 0) || 595;
  const fitScale = Math.max(
    MIN_ZOOM,
    (viewportWidth - 2 * SIDE_PADDING) / widest,
  );
  const scale = zoom.mode === "fit" ? fitScale : zoom.scale;
  const stepZoom = (factor: number) =>
    setZoom({
      mode: "fixed",
      scale: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * factor)),
    });

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-muted/40", className)}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-2">
        <StatusIndicator state={state} />
        <div className="ml-auto flex items-center gap-0.5">
          {actions}
          <WithTooltip label="Zoom out">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => stepZoom(1 / 1.2)}
            >
              <ZoomOut />
            </Button>
          </WithTooltip>
          <WithTooltip label="Zoom level, 100% is the printed size">
            <span
              tabIndex={0}
              className="w-12 cursor-default rounded-sm text-center text-xs text-muted-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Zoom level"
            >
              {Math.round((scale / PHYSICAL) * 100)}%
            </span>
          </WithTooltip>
          <WithTooltip label="Zoom in">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => stepZoom(1.2)}
            >
              <ZoomIn />
            </Button>
          </WithTooltip>
          <WithTooltip label="Fit pages to the pane width">
            <Button
              variant={zoom.mode === "fit" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="Fit width"
              aria-pressed={zoom.mode === "fit"}
              onClick={() => setZoom({ mode: "fit" })}
            >
              <MoveHorizontal />
            </Button>
          </WithTooltip>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-auto"
        data-testid="preview-viewport"
      >
        {state?.document && <DefsHost defs={state.document.defs} />}
        {pages.length > 0 ? (
          <div
            className="flex w-max min-w-full flex-col items-center"
            style={{ gap: PAGE_GAP, padding: SIDE_PADDING }}
          >
            {pages.map((page, i) => (
              <PageView key={i} page={page} index={i} scale={scale} />
            ))}
          </div>
        ) : (
          <EmptyState state={state} />
        )}
      </div>

      {state && state.diagnostics.length > 0 && (
        <DiagnosticsPanel
          diagnostics={state.diagnostics}
          onDiagnosticClick={onDiagnosticClick}
        />
      )}
    </div>
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
  const errors = state.diagnostics.filter((d) => d.severity === "error").length;
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
            className="size-3.5 text-emerald-600"
            aria-label="Up to date"
          />
        )}
        {state.status === "error" && errors > 0
          ? `${errors} error${errors === 1 ? "" : "s"}`
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
  if (state?.error) text = state.error;
  else if (state && state.status !== "starting" && state.mainPath === null) {
    text = "No main file. Pick one in the file tree.";
  } else if (state?.status === "error") {
    text = "The document has errors and nothing has rendered yet.";
  } else if (state && state.status !== "starting") {
    text = "Rendering";
  }
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {text}
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
      className="shrink-0 bg-white shadow-md ring-1 ring-black/5"
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

function DiagnosticsPanel({
  diagnostics,
  onDiagnosticClick,
}: {
  diagnostics: ProjectDiagnostic[];
  onDiagnosticClick?: (d: ProjectDiagnostic) => void;
}) {
  return (
    <div
      className="max-h-[35%] shrink-0 overflow-auto border-t bg-background"
      aria-label="Diagnostics"
    >
      <ul className="divide-y text-xs">
        {diagnostics.map((d, i) => {
          const Icon = d.severity === "error" ? AlertCircle : AlertTriangle;
          return (
            <li key={i}>
              <button
                type="button"
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-muted disabled:hover:bg-transparent"
                disabled={!onDiagnosticClick || d.path === null}
                onClick={() => onDiagnosticClick?.(d)}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    d.severity === "error"
                      ? "text-destructive"
                      : "text-amber-600",
                  )}
                />
                <span className="shrink-0 font-mono text-muted-foreground">
                  {formatLocation(d)}
                </span>
                <span className="min-w-0 break-words">{d.message}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
