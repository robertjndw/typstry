import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toError } from "@/lib/errors";
import {
  IdentityConflictError,
  RecoveryError,
  recoverFromLink,
} from "@/mls/recovery";
import { defaultBackend } from "@/persist/local-doc-store";

/**
 * Gets this browser back into an account from a recovery key and a link to
 * one of its projects. The project is where the account's graph is read
 * from, since nothing else survives losing every device.
 */
export function Recover() {
  const navigate = useNavigate();
  const [words, setWords] = useState("");
  const [showWords, setShowWords] = useState(false);
  const [link, setLink] = useState("");
  const [keepOthers, setKeepOthers] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Offered only once the browser turned out to hold another identity.
  const [conflict, setConflict] = useState(false);
  const [recovered, setRecovered] = useState<{
    path: string;
    projects: number;
  } | null>(null);

  function open(path: string) {
    const url = new URL(path, window.location.origin);
    void navigate({ pathname: url.pathname, hash: url.hash });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await recoverFromLink(await defaultBackend(), {
        words,
        link,
        keepOthers,
        replace,
      });
      // The words are the whole account; nothing should hold them longer
      // than it takes to use them.
      setWords("");
      // Only worth a stop when the rest of the list came back too.
      if (result.projects > 0) setRecovered(result);
      else open(result.path);
    } catch (err) {
      if (!(err instanceof RecoveryError)) console.error(err);
      if (err instanceof IdentityConflictError) setConflict(true);
      setError(toError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Recover with a recovery key
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter the words of your recovery key and a link you can edit with to
          one of your projects. This browser becomes your device again and opens
          the project as you.
        </p>
      </div>
      {recovered ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm">
            You are back.{" "}
            {recovered.projects === 1
              ? "1 project came back with its owner key."
              : `${recovered.projects} projects came back with their owner keys.`}
          </p>
          <Button onClick={() => open(recovered.path)}>Open project</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex gap-2">
            {/* Masked against shoulder surfing and screen sharing; pasting
                still works. The data attributes keep password managers from
                offering to save the words. */}
            <Input
              aria-label="Recovery words"
              placeholder="The 17 words"
              type={showWords ? "text" : "password"}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              value={words}
              onChange={(e) => setWords(e.target.value)}
              className="h-9 font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="lg"
              aria-pressed={showWords}
              onClick={() => setShowWords((show) => !show)}
            >
              {showWords ? "Hide" : "Show"}
            </Button>
          </div>
          <Input
            aria-label="Project link"
            placeholder="https://…/p/…#…"
            autoComplete="off"
            spellCheck={false}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            className="h-9"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepOthers}
              onChange={(e) => setKeepOthers(e.target.checked)}
            />
            Keep my other devices
          </label>
          {conflict && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              Replace the identity this browser already has
            </label>
          )}
          <Button
            type="submit"
            disabled={busy || !words.trim() || !link.trim()}
          >
            Recover
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </PageShell>
  );
}
