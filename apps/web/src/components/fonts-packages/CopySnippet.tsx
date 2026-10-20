import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

/** A one-line code snippet with a copy button; long ones truncate. */
export function CopySnippet({
  text,
  label,
  className,
}: {
  text: string;
  /** What the button copies, for screen readers: "Copy <label>". */
  label: string;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard(
    "Copying failed. Select the text and copy it by hand.",
  );
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2",
        className,
      )}
    >
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        title={text}
      >
        {text}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${label}`}
        onClick={() => void copy(text)}
      >
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
