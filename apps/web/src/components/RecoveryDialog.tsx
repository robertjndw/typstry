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
import { cleanPersonalSpace, cleanProjects } from "@/mls/revoke";
import { defaultBackend } from "@/persist/local-doc-store";

interface Created {
  words: string;
  /** Settles when the projects were brought up to date, whatever came of it. */
  spread?: Promise<void>;
}

async function createAndSpread(): Promise<Created> {
  const backend = await defaultBackend();
  const words = await createRecoveryKey(backend);
  // A recovered device can only remove the lost ones with the owner key,
  // which it reads from the shares the owner's devices seal to the recovery
  // key. Those go in with a refresh of their leaf, so the projects are
  // opened for it now instead of whenever they next see a commit.
  // The personal space first: its owner key is the one that gets the
  // recovery key a share too.
  // Nothing was revoked, so the links stay as they are.
  const keep = { resetLinks: false };
  const spread = cleanPersonalSpace(backend, undefined, keep)
    .then(() => cleanProjects(backend, undefined, keep))
    .then(() => undefined)
    .catch((error: unknown) =>
      console.warn("could not bring the recovery key into the projects", error),
    );
  return { words, spread };
}

/**
 * Explains the recovery key and makes one. The words are shown once and the
 * dialog cannot be closed before they are confirmed stored, since nothing
 * else keeps them. Nothing is created until the button is pressed.
 */
export function RecoveryDialog({
  open,
  onOpenChange,
  create = createAndSpread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replaceable for tests. */
  create?: () => Promise<Created>;
}) {
  const [words, setWords] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy, reset } = useCopyToClipboard(
    "Copying failed. Select the words and copy them manually.",
  );
  const [stored, setStored] = useState(false);
  const [spreading, setSpreading] = useState(false);

  function close(next: boolean) {
    // Closing would lose the only copy of the words.
    if (!next && words !== null && !stored) return;
    if (!next) {
      setWords(null);
      setStored(false);
      setSpreading(false);
      reset();
      setError(null);
    }
    onOpenChange(next);
  }

  async function make() {
    setWorking(true);
    setError(null);
    try {
      const created = await create();
      setWords(created.words);
      if (created.spread) {
        setSpreading(true);
        // The dialog may be gone by then; a stale update is harmless.
        void created.spread.then(() => setSpreading(false));
      }
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
            <p role="status" className="text-sm text-muted-foreground">
              {spreading
                ? "Updating your projects…"
                : "Your projects are up to date."}
            </p>
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
