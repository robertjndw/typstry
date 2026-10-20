import { Loader2Icon, UploadIcon } from "lucide-react";
import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A drop target with a real "Choose files…" button next to it, so the
 * zone works without a pointer. Folder drops need the DataTransfer itself,
 * which only exists during the drop event, hence `onDropData`.
 */
export function DropZone({
  title,
  hint,
  accept,
  chooseLabel = "Choose files…",
  busy = false,
  multiple = true,
  onFiles,
  onDropData,
  extra,
}: {
  title: string;
  hint: string;
  accept: string;
  chooseLabel?: string;
  busy?: boolean;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  /** Takes over drops; without it dropped files go to `onFiles`. */
  onDropData?: (data: DataTransfer) => void;
  /** More actions beside the choose button. */
  extra?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);

  function hasFiles(e: DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }

  return (
    <div
      onDragEnter={(e) => hasFiles(e) && (e.preventDefault(), setOver(true))}
      onDragOver={(e) => hasFiles(e) && (e.preventDefault(), setOver(true))}
      onDragLeave={(e) => {
        // Moving over a child fires leave on the zone first.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        if (busy) return;
        if (onDropData) onDropData(e.dataTransfer);
        else onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-5 text-center transition-colors sm:flex-row sm:text-left",
        over ? "border-ring bg-ring/5" : "bg-muted/20",
      )}
    >
      <div
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        {busy ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <UploadIcon className="size-4" />
        )}
      </div>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          aria-describedby={hintId}
          onClick={() => input.current?.click()}
        >
          {chooseLabel}
        </Button>
        {extra}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        aria-label={chooseLabel.replace("…", "")}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          // Cleared so picking the same file again still fires a change.
          e.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}
