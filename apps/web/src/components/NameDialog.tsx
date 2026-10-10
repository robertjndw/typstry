import { CheckIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MAX_NAME_LENGTH,
  normalizeName,
  PALETTE,
  type Identity,
} from "@/presence/identity";

export interface NameDialogProps {
  open: boolean;
  initial: Identity;
  /** Called with the chosen identity whenever the dialog closes. */
  onClose: (identity: Identity) => void;
  firstVisit?: boolean;
}

/**
 * Closing the dialog in any way keeps what is in it, so a first-time
 * visitor who just presses Escape still gets the suggested name.
 */
export function NameDialog({
  open,
  initial,
  onClose,
  firstVisit = false,
}: NameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      {open && (
        <NameForm initial={initial} onClose={onClose} firstVisit={firstVisit} />
      )}
    </Dialog>
  );
}

function NameForm({
  initial,
  onClose,
  firstVisit,
}: Omit<NameDialogProps, "open">) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const finish = () =>
    onClose({ name: normalizeName(name) || initial.name, color });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    finish();
  }

  return (
    <DialogContent
      onEscapeKeyDown={finish}
      onPointerDownOutside={finish}
      showCloseButton={false}
      className="sm:max-w-md"
    >
      <form onSubmit={onSubmit} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            {firstVisit ? "What should others call you?" : "Your name"}
          </DialogTitle>
          <DialogDescription>
            Shown next to your cursor and in the list of people here. Stored in
            this browser only.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Your name"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
        <div
          role="radiogroup"
          aria-label="Color"
          className="flex flex-wrap gap-2"
        >
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={c}
              onClick={() => setColor(c)}
              className={cn(
                "flex size-7 items-center justify-center rounded-full text-white transition-transform outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50",
                c === color &&
                  "ring-2 ring-foreground ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: c }}
            >
              {c === color && <CheckIcon className="size-4" />}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button type="submit">{firstVisit ? "Join" : "Save"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
