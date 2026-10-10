import type { OpId } from "loro-crdt";
import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

import type { ProjectAssets } from "@/assets/project-assets";
import { PdfDownloadButton } from "@/components/DownloadButton";
import { PreviewPane } from "@/components/PreviewPane";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectDoc } from "@/doc/schema";
import {
  formatRelative,
  type HistoryItem,
  type VersionTarget,
} from "@/project/history-items";
import { useCompilerClient } from "@/typst/hooks";

export interface VersionPreviewDialogProps {
  /** The live project; versions are compiled from a fork of it. */
  project: ProjectDoc;
  /** The history as listed, newest first, for stepping through it. */
  items: HistoryItem[];
  /** Key of the version shown, or null when closed. */
  current: string | null;
  onNavigate: (key: string) => void;
  onClose: () => void;
  assets: ProjectAssets | null;
  /** The project title, for the PDF's file name. */
  title: string;
  /** Who made the edits of an item, as display names. */
  authorsOf: (item: HistoryItem) => string[];
  /** Leaves the preview for the full version view. */
  onOpenVersion: (target: VersionTarget) => void;
}

/**
 * A quick look at how a version renders, on top of the history list, with
 * arrow keys to step to older and newer ones.
 */
export function VersionPreviewDialog({
  current,
  onClose,
  ...props
}: VersionPreviewDialogProps) {
  // Keeps the last version on screen while the dialog animates out.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);

  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        // Focus the dialog itself: the first button would show its tooltip
        // every time the preview opens.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className="flex h-[min(88svh,960px)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        {shown && <PreviewBody current={shown} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  project,
  items,
  current,
  onNavigate,
  assets,
  title,
  authorsOf,
  onOpenVersion,
}: Omit<VersionPreviewDialogProps, "current" | "onClose"> & {
  current: string;
}) {
  const index = items.findIndex((item) => item.target.key === current);
  const item = items[index];
  // One fork for as long as the dialog is open, moved between versions with
  // checkout. The compiler then only redoes what differs, and the previous
  // version stays on screen until the next one has rendered.
  const [view] = useState(() => new ProjectDoc(project.doc.fork()));
  const [failed, setFailed] = useState(false);
  const frontiers = item?.target.frontiers;
  useLayoutEffect(() => {
    if (!frontiers) return;
    const ok = checkout(view, project, frontiers);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the checkout result is only known after trying it on the fork
    setFailed(!ok);
  }, [view, project, frontiers]);
  const compiler = useCompilerClient(
    view,
    assets ? { assetLoader: (hash) => assets.load(hash) } : undefined,
  );

  if (!item) return null;
  const { target, tags } = item;
  // Newest first, so older is further down the list.
  const older = items[index + 1];
  const newer = items[index - 1];
  const when = target.time !== null ? formatRelative(target.time) : null;
  const authors = authorsOf(item);
  const details = [
    target.time !== null ? absolute.format(target.time) : null,
    item.detail,
    authors.length > 0 ? `by ${authors.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepKeys
        onStep={(direction) => {
          const next = direction === "older" ? older : newer;
          if (next) onNavigate(next.target.key);
        }}
      />
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b py-2.5 pr-2.5 pl-4">
        <div className="min-w-0 flex-1">
          <DialogTitle className="flex min-w-0 items-center gap-1.5 text-base">
            {tags.length > 0 ? (
              <>
                <TagIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="truncate">
                  {tags.map((t) => t.name).join(", ")}
                </span>
              </>
            ) : (
              <span className="truncate">{when ?? "Unknown time"}</span>
            )}
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {details.join(" · ")}
          </DialogDescription>
        </div>
        <div className="flex items-center gap-1.5">
          {items.length > 1 && (
            <div className="flex items-center gap-0.5">
              <NavButton
                label="Older version"
                text="Older"
                hint="←"
                to={older?.target.label}
                onClick={() => older && onNavigate(older.target.key)}
              >
                <ChevronLeftIcon />
              </NavButton>
              <NavButton
                label="Newer version"
                text="Newer"
                hint="→"
                to={newer?.target.label}
                iconAfter
                onClick={() => newer && onNavigate(newer.target.key)}
              >
                <ChevronRightIcon />
              </NavButton>
              <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />
            </div>
          )}
          <PdfDownloadButton
            compiler={failed ? null : compiler}
            name={[title, target.label]}
            labelled
          />
          <Button size="sm" onClick={() => onOpenVersion(target)}>
            <ArrowUpRightIcon />
            Open version
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <XIcon />
            </Button>
          </DialogClose>
        </div>
      </header>
      {failed ? (
        <p className="flex flex-1 items-center justify-center bg-muted/40 p-6 text-sm text-muted-foreground">
          This version cannot be opened.
        </p>
      ) : (
        <PreviewPane
          client={compiler}
          variant="viewer"
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}

/**
 * ← and → step through versions. On the window rather than the dialog:
 * focus can drop to the body inside a modal, e.g. when the download button
 * disables itself while it works, and the keys should still step then.
 */
function StepKeys({
  onStep,
}: {
  onStep: (direction: "older" | "newer") => void;
}) {
  const step = useEffectEvent(onStep);
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) {
        return;
      }
      // Leave the arrows to menus, fields, and a page zoomed in wider than
      // the canvas, where they scroll sideways.
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('[role="menu"], input, textarea')) return;
      const viewport = el?.closest<HTMLElement>(
        '[data-testid="preview-viewport"]',
      );
      if (viewport && viewport.scrollWidth > viewport.clientWidth) return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? "older" : "newer");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}

/**
 * Moves the fork to `frontiers`, first pulling in what the live doc gained
 * since the fork was made (the list can refresh while the dialog is open).
 * False for frontiers neither doc has, e.g. from a malformed tag.
 */
function checkout(view: ProjectDoc, project: ProjectDoc, frontiers: OpId[]) {
  try {
    view.doc.checkout(frontiers);
    return true;
  } catch {
    try {
      view.doc.import(
        project.doc.export({ mode: "update", from: view.doc.oplogVersion() }),
      );
      view.doc.checkout(frontiers);
      return true;
    } catch (err) {
      console.error("cannot open version", err);
      return false;
    }
  }
}

function NavButton({
  label,
  text,
  hint,
  to,
  iconAfter = false,
  onClick,
  children,
}: {
  label: string;
  /** Visible text; the icon alone on narrow screens. */
  text: string;
  hint: string;
  /** Label of the version it leads to; none at either end of the list. */
  to: string | undefined;
  iconAfter?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      disabled={to === undefined}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground"
    >
      {!iconAfter && children}
      <span className="max-sm:sr-only">{text}</span>
      {iconAfter && children}
    </Button>
  );
  // Disabled buttons get no pointer events, so no tooltip at the ends.
  if (to === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">
        {to} <span className="opacity-60">{hint}</span>
      </TooltipContent>
    </Tooltip>
  );
}

const absolute = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
