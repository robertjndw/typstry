import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  Loader2Icon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Combobox, type ComboboxOption } from "@/components/Combobox";
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
import {
  fetchSnapshot,
  listRefs,
  parseGitUrl,
  repoName,
  type GitFolder,
  type GitSnapshot,
  type RemoteRefs,
} from "@/import/git";
import type { ImportSource } from "@/import/import";
import { toError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { GitTemplate } from "@/sync/api";

/** Reads the chosen files once the snapshot is in; Home reports progress. */
export type GitLoad = (
  onProgress: (phase: string) => void,
) => Promise<ImportSource>;

export interface GitImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: GitTemplate[];
  /** What the running import is doing; null while idle. */
  status: string | null;
  error: string | null;
  /** The title typed on the start page, carried over as a starting point. */
  initialTitle: string;
  onSubmit: (load: GitLoad, title: string) => void;
}

/** Start a project from one of the instance's templates or any public repo. */
export function GitImportDialog({
  open,
  onOpenChange,
  status,
  ...rest
}: GitImportDialogProps) {
  const busy = status !== null;
  const offersTemplates = rest.templates.length > 0;
  return (
    <Dialog
      open={open}
      // The import cannot be cancelled halfway, so the dialog stays until it
      // either navigates away or fails.
      onOpenChange={(next) => !busy && onOpenChange(next)}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {offersTemplates
              ? "Start from a template"
              : "Start from a Git repository"}
          </DialogTitle>
          <DialogDescription>
            {offersTemplates
              ? "Pick a template, or copy the files of any public Git repository."
              : "Copies the files of a public repository into a new project."}{" "}
            The project is not linked to the repository afterwards.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so every visit starts with empty fields. */}
        {open && (
          <GitImportForm
            {...rest}
            status={status}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Long enough that typing a URL does not look up every prefix of it. */
const LOOKUP_DELAY_MS = 400;

type Lookup =
  | { url: string; state: "loading" }
  | { url: string; state: "ready"; refs: RemoteRefs }
  | { url: string; state: "error"; message: string };

type Snapshot =
  | { key: string; state: "loading"; progress: string | null }
  | { key: string; state: "ready"; snapshot: GitSnapshot }
  | { key: string; state: "error"; message: string };

/** Where the dialog should land once the repository is known. */
interface Hint {
  ref?: string;
  path?: string;
}

function tryParse(input: string) {
  if (!input.trim()) return null;
  try {
    return parseGitUrl(input);
  } catch (err) {
    return { error: toError(err).message };
  }
}

function GitImportForm({
  templates,
  status,
  error,
  initialTitle,
  onSubmit,
  onCancel,
}: Omit<GitImportDialogProps, "open" | "onOpenChange"> & {
  onCancel: () => void;
}) {
  const id = useId();
  const busy = status !== null;
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState(initialTitle);
  const [chosen, setChosen] = useState<GitTemplate | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Skips the typing delay for a template or a pasted link.
  const immediate = useRef(false);
  const hint = useRef<Hint>({});
  // One fetch per repository and ref, shared by the folder list and submit.
  const snapshots = useRef(new Map<string, Promise<GitSnapshot>>());

  const parsed = useMemo(() => tryParse(url), [url]);
  const repoUrl = parsed && "url" in parsed ? parsed.url : null;
  const refs =
    lookup?.url === repoUrl && lookup?.state === "ready" ? lookup.refs : null;

  // A link to a branch or folder says where to land. For a repository that
  // is already looked up, it lands there right away.
  function changeUrl(value: string) {
    setUrl(value);
    setChosen(null);
    const next = tryParse(value);
    const nextUrl = next && "url" in next ? next.url : null;
    // Same repository means no new lookup, so clear the flag or the next
    // keystroke would skip the debounce.
    if (nextUrl === null || nextUrl === repoUrl) immediate.current = false;
    if (!next || !("url" in next)) return;
    // A plain link to another repository must not inherit the last one's.
    if (next.ref || next.path || refs?.url !== next.url)
      hint.current = { ref: next.ref, path: next.path };
    if (refs?.url !== next.url) return;
    const wanted = resolveHint(refs, { ref: next.ref, path: next.path });
    if (wanted.ref && hasRef(refs, wanted.ref)) setRef(wanted.ref);
    if (next.path !== undefined) setPath(wanted.path ?? "");
  }

  // State left over from an earlier URL or ref is ignored by comparing its
  // key, rather than reset here.
  useEffect(() => {
    if (!repoUrl) return;
    let live = true;
    const run = () => {
      setLookup({ url: repoUrl, state: "loading" });
      listRefs(repoUrl).then(
        (found) => {
          if (!live) return;
          setLookup({ url: repoUrl, state: "ready", refs: found });
          const wanted = resolveHint(found, hint.current);
          setRef(
            wanted.ref && hasRef(found, wanted.ref)
              ? wanted.ref
              : (found.defaultBranch ?? found.branches[0] ?? ""),
          );
          setPath(wanted.path ?? "");
        },
        (err: unknown) => {
          if (live)
            setLookup({
              url: repoUrl,
              state: "error",
              message: toError(err).message,
            });
        },
      );
    };
    const delay = immediate.current ? 0 : LOOKUP_DELAY_MS;
    immediate.current = false;
    const timer = setTimeout(run, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repoUrl]);

  // Fetching the snapshot is what lists the folders, and it is the same
  // download the import needs, so it starts as soon as the ref is known.
  const snapKey = refs && ref ? `${refs.url}#${ref}` : null;
  useEffect(() => {
    if (!snapKey || !refs) return;
    let live = true;
    let pending = snapshots.current.get(snapKey);
    if (!pending) {
      pending = fetchSnapshot(refs.url, ref, (progress) => {
        if (live) setSnap({ key: snapKey, state: "loading", progress });
      });
      // Each snapshot holds a whole pack in memory, so only the current one
      // is kept; going back to an earlier ref fetches it again.
      snapshots.current.clear();
      snapshots.current.set(snapKey, pending);
      // A failed fetch is not worth keeping; picking the ref again retries.
      const failed = pending;
      failed.catch(() => {
        if (snapshots.current.get(snapKey) === failed)
          snapshots.current.delete(snapKey);
      });
    }
    pending.then(
      (snapshot) => {
        if (!live) return;
        setSnap({ key: snapKey, state: "ready", snapshot });
        setPath((current) =>
          snapshot.folders.some((f) => f.path === current) ? current : "",
        );
      },
      (err: unknown) => {
        if (live)
          setSnap({
            key: snapKey,
            state: "error",
            message: toError(err).message,
          });
      },
    );
    return () => {
      live = false;
    };
    // refs and ref are both part of snapKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapKey]);

  const snapshot =
    snap?.key === snapKey && snap?.state === "ready" ? snap.snapshot : null;
  const folder = snapshot?.folders.find((f) => f.path === path) ?? null;

  const refOptions = useMemo((): ComboboxOption[] => {
    if (!refs) return [];
    return [
      ...refs.branches.map((name) => ({
        value: name,
        label: name,
        group: "Branches",
        badge: name === refs.defaultBranch ? "default" : undefined,
      })),
      ...refs.tags.map((name) => ({ value: name, label: name, group: "Tags" })),
    ];
  }, [refs]);

  const folderOptions = useMemo(
    () => (snapshot ? folderChoices(snapshot.folders) : []),
    [snapshot],
  );

  function choose(template: GitTemplate) {
    setChosen(template);
    hint.current = { ref: template.ref, path: template.path };
    const next = tryParse(template.url);
    const nextUrl = next && "url" in next ? next.url : null;
    // Only skip the debounce when this actually starts a new lookup.
    immediate.current = nextUrl !== null && nextUrl !== repoUrl;
    setUrl(template.url);
    // The same repository is already looked up, so land on the template's
    // ref and folder right away.
    if (refs && nextUrl === refs.url) {
      setRef(
        template.ref && hasRef(refs, template.ref)
          ? template.ref
          : (refs.defaultBranch ?? ""),
      );
      setPath(template.path ?? "");
    }
  }

  const fallbackTitle =
    chosen?.name ??
    (repoUrl
      ? (path.split("/").filter(Boolean).at(-1) ?? repoName(repoUrl))
      : undefined);

  const lookupError =
    parsed && "error" in parsed
      ? parsed.error
      : lookup?.url === repoUrl && lookup?.state === "error"
        ? lookup.message
        : null;
  const snapError =
    snap?.key === snapKey && snap?.state === "error" ? snap.message : null;
  const ready = !!refs && !!ref && !snapError;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready || !snapKey) return;
    const pending = snapshots.current.get(snapKey);
    if (!pending) return;
    const chosenPath = path;
    onSubmit(
      async (onProgress) => {
        const snapshot = await pending;
        onProgress("Reading files");
        return snapshot.read(chosenPath);
      },
      title.trim() || chosen?.name || "",
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Start from Git"
      className="-mx-4 -mb-4 flex min-h-0 flex-col"
    >
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-5">
        {templates.length > 0 && (
          <>
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend className="mb-2 text-sm font-medium">Templates</legend>
              <div
                role="radiogroup"
                aria-label="Templates"
                className="grid gap-2 sm:grid-cols-2"
              >
                {templates.map((t) => (
                  <TemplateCard
                    key={`${t.url}#${t.ref ?? ""}#${t.path ?? ""}#${t.name}`}
                    template={t}
                    selected={chosen === t}
                    onSelect={() => choose(t)}
                  />
                ))}
              </div>
            </fieldset>
            <div
              aria-hidden
              className="flex items-center gap-3 text-xs text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border" />
              or use any public repository
              <span className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-url`} className="text-sm font-medium">
            Repository URL
          </label>
          <div className="relative">
            <Input
              id={`${id}-url`}
              value={url}
              placeholder="https://github.com/owner/repo"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              autoFocus={templates.length === 0}
              disabled={busy}
              aria-invalid={!!lookupError || undefined}
              aria-describedby={`${id}-url-status`}
              className="h-9 pr-9"
              onPaste={() => {
                immediate.current = true;
              }}
              onChange={(e) => changeUrl(e.target.value)}
            />
            <LookupIcon
              state={
                lookupError
                  ? "error"
                  : refs
                    ? "ready"
                    : repoUrl
                      ? "loading"
                      : null
              }
            />
          </div>
          <p
            id={`${id}-url-status`}
            aria-live="polite"
            className={cn(
              "text-xs",
              lookupError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {lookupError ??
              (refs
                ? describeRepo(refs)
                : repoUrl
                  ? "Looking up the repository…"
                  : "Paste a link from GitHub, GitLab, Gitea or any other HTTPS host. Links to a branch or folder work too.")}
          </p>
        </div>

        <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-ref`} className="text-sm font-medium">
              Branch or tag
            </label>
            <Combobox
              id={`${id}-ref`}
              value={ref}
              options={refOptions}
              onChange={setRef}
              placeholder={
                repoUrl && !refs && !lookupError ? "Loading…" : "Default branch"
              }
              searchPlaceholder="Find a branch or tag"
              disabled={busy || !refs}
              loading={!!repoUrl && !refs && !lookupError}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${id}-path`} className="text-sm font-medium">
              Folder
            </label>
            <Combobox
              id={`${id}-path`}
              value={path}
              options={folderOptions}
              onChange={setPath}
              placeholder={
                snapKey && !snapshot && !snapError
                  ? snap?.key === snapKey &&
                    snap.state === "loading" &&
                    snap.progress
                    ? snap.progress
                    : "Loading folders…"
                  : "Whole repository"
              }
              searchPlaceholder="Find a folder"
              disabled={busy || !snapshot}
              loading={!!snapKey && !snapshot && !snapError}
              aria-describedby={`${id}-path-status`}
            />
          </div>
          {(snapError || folder) && (
            <p
              id={`${id}-path-status`}
              aria-live="polite"
              className={cn(
                "-mt-3 text-xs sm:col-span-2",
                snapError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {snapError ??
                (folder &&
                  snapshot &&
                  describeFolder(folder, snapshot.folders))}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-title`} className="text-sm font-medium">
            Project title{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </label>
          <Input
            id={`${id}-title`}
            value={title}
            placeholder={fallbackTitle ?? "Named after the repository"}
            maxLength={120}
            autoComplete="off"
            disabled={busy}
            className="h-9"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {status ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
            {status}
          </p>
        ) : (
          error && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )
        )}
      </div>

      <DialogFooter className="mx-0 mb-0">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !ready}>
          {busy && <Loader2Icon className="animate-spin" />}
          {busy ? "Creating project…" : "Create project"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function hasRef(refs: RemoteRefs, name: string): boolean {
  return refs.branches.includes(name) || refs.tags.includes(name);
}

/**
 * A link puts the ref and the folder in one path, and parseGitUrl can only
 * guess that the first segment is the ref. With the refs known, the longest
 * prefix that names one wins, so "feature/x/docs" can be the branch
 * "feature/x" and the folder "docs".
 */
function resolveHint(refs: RemoteRefs, hint: Hint): Hint {
  if (!hint.ref || hasRef(refs, hint.ref)) return hint;
  const parts = [hint.ref, ...(hint.path ? hint.path.split("/") : [])];
  for (let n = parts.length; n > 1; n--) {
    const ref = parts.slice(0, n).join("/");
    if (hasRef(refs, ref)) {
      const rest = parts.slice(n).join("/");
      return { ref, path: rest || undefined };
    }
  }
  return hint;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeRepo(refs: RemoteRefs): string {
  const parts = [plural(refs.branches.length, "branch", "branches")];
  if (refs.tags.length > 0) parts.push(plural(refs.tags.length, "tag"));
  let repo = repoName(refs.url);
  try {
    repo = new URL(refs.url).pathname.replace(/^\/|\.git$/g, "");
  } catch {
    // The short name will do.
  }
  return `${repo} · ${parts.join(", ")}`;
}

function describeFolder(folder: GitFolder, folders: GitFolder[]): string {
  const files = plural(folder.files, "file");
  if (folder.manifest) return `${files}, a Typst template or package`;
  if (folder.typst) return `${files}, with Typst files at the top`;
  const inside = folders.filter(
    (f) =>
      (f.manifest || f.typst) &&
      (folder.path === "" || f.path.startsWith(`${folder.path}/`)),
  ).length;
  return inside > 0
    ? `${files}, but no Typst files at the top. ${plural(inside, "folder")} inside ${inside === 1 ? "has" : "have"} some.`
    : `${files}, and no Typst files in it.`;
}

/**
 * The whole repository first, then folders that hold Typst files (most
 * likely what people are after), then the rest.
 */
function folderChoices(folders: GitFolder[]): ComboboxOption[] {
  const option = (f: GitFolder, group?: string): ComboboxOption => ({
    value: f.path,
    label: f.path || "Whole repository",
    hint: plural(f.files, "file"),
    badge: f.manifest ? "template" : f.typst ? "typst" : undefined,
    group,
  });
  const [root, ...rest] = folders;
  const typst = rest.filter((f) => f.manifest || f.typst);
  const other = rest.filter((f) => !f.manifest && !f.typst);
  return [
    ...(root ? [option(root)] : []),
    ...typst.map((f) => option(f, "Typst folders")),
    ...other.map((f) =>
      option(f, typst.length > 0 ? "Other folders" : "Folders"),
    ),
  ];
}

function LookupIcon({
  state,
}: {
  state: "loading" | "ready" | "error" | null;
}) {
  if (!state) return null;
  const className =
    "pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2";
  if (state === "loading")
    return (
      <Loader2Icon
        aria-hidden
        className={cn(className, "animate-spin text-muted-foreground")}
      />
    );
  if (state === "error")
    return (
      <AlertCircleIcon
        aria-hidden
        className={cn(className, "text-destructive")}
      />
    );
  return (
    <CheckCircle2Icon
      aria-hidden
      className={cn(className, "text-emerald-600 dark:text-emerald-500")}
    />
  );
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: GitTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  // The host is the same for most templates and would crowd out the part
  // that tells them apart; the tooltip still has the full address.
  const source = useMemo(() => {
    let repo = template.url;
    try {
      repo = new URL(template.url).pathname.replace(/^\/|\.git$/g, "");
    } catch {
      // Shown as configured.
    }
    return [repo, template.path].filter(Boolean).join("/");
  }, [template]);
  const full = [template.url, template.ref, template.path]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      title={full}
      onClick={onSelect}
      className={cn(
        "relative flex h-full min-w-0 flex-col gap-1 rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="font-medium">{template.name}</span>
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input",
          )}
        >
          {selected && <CheckIcon className="size-3" />}
        </span>
      </span>
      {template.description && (
        <span className="line-clamp-2 text-muted-foreground">
          {template.description}
        </span>
      )}
      <span className="truncate font-mono text-xs text-muted-foreground/80">
        {source}
      </span>
    </button>
  );
}
