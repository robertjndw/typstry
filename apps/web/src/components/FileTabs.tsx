import { XIcon } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { EntryIcon } from "@/components/FileTree";
import { basename, dirname } from "@/doc/names";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";

/** One tab per open file; the active one is what the editor shows. */
export function FileTabs({ trailing }: { trailing?: ReactNode }) {
  const { index, tabs, openFileId, openFile, closeFile } = useProject();
  const strip = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const list = tabs.flatMap((id) => {
      const entry = index.byId.get(id);
      if (!entry) return [];
      return [
        { id, path: entry.path, kind: entry.kind, name: basename(entry.path) },
      ];
    });
    // Two open "intro.typ"s are only told apart by their folder.
    const counts = new Map<string, number>();
    for (const e of list) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    return list.map((e) => ({
      ...e,
      folder: counts.get(e.name)! > 1 ? dirname(e.path) || "/" : null,
    }));
  }, [tabs, index]);

  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [openFileId]);

  const overflow = useStripOverflow(strip, entries.length);

  if (entries.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 border-b bg-muted/30">
      <div
        ref={strip}
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto overflow-y-hidden"
        // A mask rather than gradient overlays, so the fade works over any
        // tab background, hovered or active, in both themes.
        style={fadeMask(overflow)}
      >
        {entries.map((tab) => {
          const active = tab.id === openFileId;
          return (
            <div
              key={tab.id}
              role="presentation"
              className={cn(
                "group relative flex h-full max-w-56 shrink-0 items-center border-r text-xs transition-colors duration-150",
                active
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                closeFile(tab.id);
              }}
            >
              {active && (
                <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.path}
                className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-3 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => openFile(tab.id)}
              >
                <EntryIcon
                  kind={tab.kind}
                  name={tab.name}
                  open={false}
                  className="size-3.5 text-current"
                />
                <span className="truncate">{tab.name}</span>
                {tab.folder !== null && (
                  <span className="truncate text-muted-foreground">
                    {tab.folder}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.path}`}
                title="Close"
                className={cn(
                  "mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-[opacity,background-color,color] duration-150 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
                  !active && "opacity-0 group-hover:opacity-100",
                )}
                onClick={() => closeFile(tab.id)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

interface Overflow {
  left: boolean;
  right: boolean;
}

const FADE_PX = 24;

function fadeMask({ left, right }: Overflow) {
  if (!left && !right) return undefined;
  const mask = `linear-gradient(to right, transparent 0, #000 ${left ? FADE_PX : 0}px, #000 calc(100% - ${right ? FADE_PX : 0}px), transparent 100%)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * Which edges of the strip have tabs scrolled out of view. Also turns a
 * vertical wheel into horizontal scrolling, since most mice have no other
 * way to reach the hidden tabs.
 */
function useStripOverflow(
  ref: RefObject<HTMLDivElement | null>,
  count: number,
): Overflow {
  const [overflow, setOverflow] = useState<Overflow>({
    left: false,
    right: false,
  });
  const measureRef = useRef<(() => void) | null>(null);

  // Keyed on count so the listeners attach once the strip first renders.
  const hasStrip = count > 0;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Subpixel widths can leave scrollLeft a fraction short of the end.
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setOverflow((prev) =>
        prev.left === left && prev.right === right ? prev : { left, right },
      );
    };
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      el.scrollLeft += event.deltaY * scale;
    };
    measureRef.current = measure;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", onWheel);
      observer?.disconnect();
      measureRef.current = null;
    };
  }, [ref, hasStrip]);

  // Opening or closing a tab changes the scroll width without resizing the
  // strip itself, which the observer would miss.
  useLayoutEffect(() => {
    measureRef.current?.();
  }, [count]);

  return overflow;
}
