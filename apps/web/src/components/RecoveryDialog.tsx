import { CheckIcon, CopyIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { toError } from "@/lib/errors";
import { createRecoveryKey } from "@/mls/recovery";
import { defaultBackend } from "@/persist/local-doc-store";

/**
 * Explains the recovery key and makes one. The words are shown once and the
 * dialog cannot be closed before they are confirmed stored, since nothing
 * else keeps them. Nothing is created until the button is pressed.
 */
export function RecoveryDialog({
  open,
  onOpenChange,
  create = async () => createRecoveryKey(await defaultBackend()),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replaceable for tests. */
  create?: () => Promise<string>;
}) {
  const [words, setWords] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy, reset } = useCopyToClipboard(
    "Copying failed. Select the words and copy them manually.",
  );
  const [stored, setStored] = useState(false);

  function close(next: boolean) {
    // Closing would lose the only copy of the words.
    if (!next && words !== null && !stored) return;
    if (!next) {
      setWords(null);
      setStored(false);
      reset();
      setError(null);
    }
    onOpenChange(next);
  }

  async function make() {
    setWorking(true);
    setError(null);
    try {
      setWords(await create());
    } catch (e) {
      console.error(e);
      setError(toError(e).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={words === null || stored}
      >
        <DialogHeader>
          <DialogTitle>Recovery key</DialogTitle>
          <DialogDescription>
            If you lose every device, these words and a link to one of your
            projects get you back in from a new browser. Keep them private:
            anyone who has them can take over your projects.
          </DialogDescription>
        </DialogHeader>
        {words === null ? (
          <>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              onClick={() => void make()}
              disabled={working}
              className="self-start"
            >
              <KeyRoundIcon />
              Create recovery key
            </Button>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              This is the only time you will see these words.
            </p>
            <div className="flex items-start gap-2">
              <p
                aria-label="Recovery words"
                className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm leading-relaxed break-words select-all"
              >
                {words}
              </p>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy the words"
                onClick={() => void copy(words)}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={stored}
                onChange={(e) => setStored(e.target.checked)}
              />
              I have stored it
            </label>
            <Button
              onClick={() => close(false)}
              disabled={!stored}
              className="self-start"
            >
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
