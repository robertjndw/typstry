import {
  AlertTriangleIcon,
  EllipsisIcon,
  FolderIcon,
  Loader2Icon,
  PackageIcon,
  PinIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { PackageRecord } from "@/doc/schema";
import { isZip, readDrop, readFolderPick } from "@/import/sources";
import { toError } from "@/lib/errors";
import { addPackage, findConflict } from "@/packages/add";
import { PackageError } from "@/packages/errors";
import {
  preparePackage,
  type PackageInput,
  type PreparedPackage,
} from "@/packages/normalize";
import { deletePackage } from "@/packages/records";
import {
  compareVersions,
  formatSpec,
  importSnippet,
  isIdent,
  packageKey,
  parsePinInput,
  parseSpec,
  parseVersion,
  TYPST_VERSION,
  type PackageSpec,
} from "@/packages/spec";
import { fetchUniverse } from "@/packages/universe";
import { useProject } from "@/project/context";
import { attempt } from "@/project/tree";

import { CopySnippet } from "./CopySnippet";
import { DropZone } from "./DropZone";
import { formatBytes, plural } from "./format";
import { useUsedPreviewImports } from "./hooks";

const ACCEPT = ".zip,.tar.gz,.tgz";
const DEFAULT_NAMESPACE = "local";

type Source = PackageRecord["source"];

interface Review {
  prepared: PreparedPackage;
  namespace: string;
}

interface Replacement extends Review {
  source: Source;
}

const isTarball = (name: string) => /\.(tar\.gz|tgz)$/i.test(name);

/** The input for a single archive file, or null if it is not one. */
function archiveInput(file: File): PackageInput | null {
  if (isZip(file.name)) return { kind: "zip", file };
  if (isTarball(file.name)) return { kind: "archive", file };
  return null;
}

/** Authors, license, file count and size, for one line of small print. */
function packageFacts(pkg: {
  authors?: string[];
  license?: string;
  fileCount: number;
  unpackedSize: number;
}): string {
  return [
    pkg.authors?.length ? pkg.authors.join(", ") : null,
    pkg.license ?? null,
    plural(pkg.fileCount, "file"),
    formatBytes(pkg.unpackedSize),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The Typst version warning for a package that needs a newer compiler. */
function needsNewerCompiler(record: PackageRecord): boolean {
  const required = record.compiler ? parseVersion(record.compiler) : null;
  const ours = parseVersion(TYPST_VERSION);
  return (
    required !== null && ours !== null && compareVersions(ours, required) < 0
  );
}

function describePackageError(err: unknown): string {
  if (err instanceof PackageError) return err.message;
  console.error(err);
  return `Adding the package failed: ${toError(err).message}`;
}

export function PackagesTab({
  packages,
  canEdit,
  prefill,
}: {
  packages: PackageRecord[];
  canEdit: boolean;
  prefill?: string;
}) {
  const { project, assets } = useProject();
  const used = useUsedPreviewImports();

  const prefilled = prefill ? parseSpec(prefill) : null;
  const [pinText, setPinText] = useState(
    prefilled?.namespace === "preview" ? formatSpec(prefilled) : "",
  );
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const [removing, setRemoving] = useState<PackageRecord | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<PackageRecord | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pinErrorId = useId();

  const pinned = new Set(
    packages.filter((p) => p.namespace === "preview").map((p) => formatSpec(p)),
  );
  const unpinned = used.filter((item) => !pinned.has(item.spec));
  const needsUpload =
    prefill && !prefilled
      ? prefill
      : prefilled && prefilled.namespace !== "preview"
        ? formatSpec(prefilled)
        : null;

  /** Reads an archive or tree and opens the review step. */
  async function read(input: PackageInput, namespace = DEFAULT_NAMESPACE) {
    const id = toast.loading("Reading package…");
    setReading(true);
    try {
      const prepared = await preparePackage(input);
      toast.dismiss(id);
      setReview({ prepared, namespace });
    } catch (err) {
      toast.error(describePackageError(err), { id });
    } finally {
      setReading(false);
    }
  }

  function readFiles(files: File[], namespace?: string) {
    const [only] = files;
    const input = files.length === 1 && only ? archiveInput(only) : null;
    if (input) return void read(input, namespace);
    toast.error(
      "That is not a package archive. Use a .zip, .tar.gz or .tgz file, or choose a folder.",
    );
  }

  function readDropped(data: DataTransfer) {
    // The drop's items are gone once this handler returns, so everything is
    // read before the first await.
    const [only] = Array.from(data.files);
    const input = data.files.length === 1 && only ? archiveInput(only) : null;
    if (input) return void read(input);
    const pending = readDrop(data);
    if (!pending) return;
    void read({ kind: "source", source: pending.source });
  }

  function readFolder(files: File[]) {
    if (files.length === 0) return;
    const pending = readFolderPick(files);
    void read({ kind: "source", source: pending.source });
  }

  /** Stores the package, asking first when it would overwrite another. */
  function commit(
    prepared: PreparedPackage,
    namespace: string,
    source: Source,
  ) {
    const { name, version } = prepared.manifest;
    if (findConflict(project, packageKey({ namespace, name, version }))) {
      setReplacement({ prepared, namespace, source });
      return;
    }
    void store(prepared, namespace, source);
  }

  async function store(
    prepared: PreparedPackage,
    namespace: string,
    source: Source,
  ) {
    if (!assets) return;
    const { name, version } = prepared.manifest;
    const spec = formatSpec({ namespace, name, version });
    const id = toast.loading(`Uploading ${spec}…`);
    try {
      const record = await addPackage(project, assets, prepared, {
        namespace,
        source,
      });
      toast.success(`Added ${spec}`, {
        id,
        action: {
          label: "Copy import",
          onClick: () => {
            navigator.clipboard
              .writeText(importSnippet(record))
              .catch(() => toast.error("Copying failed"));
          },
        },
      });
      setReview(null);
    } catch (err) {
      toast.error(describePackageError(err), { id });
    }
  }

  async function pin(spec: PackageSpec) {
    const label = formatSpec(spec);
    if (pinning) return;
    const existing = findConflict(project, packageKey(spec));
    if (existing?.source === "universe") {
      toast.info(`${label} is already pinned.`);
      return;
    }
    setPinning(label);
    const id = toast.loading(`Downloading ${label}…`);
    try {
      const bytes = await fetchUniverse(spec.name, spec.version);
      toast.loading(`Reading ${label}…`, { id });
      const prepared = await preparePackage({
        kind: "universe",
        name: spec.name,
        version: spec.version,
        bytes,
      });
      toast.dismiss(id);
      setPinText("");
      commit(prepared, "preview", "universe");
    } catch (err) {
      toast.error(describePackageError(err), { id });
    } finally {
      setPinning(null);
    }
  }

  function submitPin() {
    const spec = parsePinInput(pinText);
    if (!spec) {
      setPinError("Enter a package like @preview/cetz:0.4.2.");
      return;
    }
    if (spec.namespace !== "preview") {
      setPinError(
        "Only @preview packages come from Typst Universe. Upload other packages as an archive or folder.",
      );
      return;
    }
    setPinError(null);
    void pin(spec);
  }

  const busy = reading || pinning !== null;

  return (
    <div className="grid gap-5">
      {canEdit && (
        <section aria-label="Add a package" className="grid gap-4">
          <DropZone
            title="Add a package"
            hint="A .zip or .tar.gz of a package with a typst.toml, or a folder."
            accept={ACCEPT}
            chooseLabel="Choose archive…"
            multiple={false}
            busy={reading}
            onFiles={(files) => readFiles(files)}
            onDropData={readDropped}
            extra={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reading}
                onClick={() => folderInput.current?.click()}
              >
                <FolderIcon />
                Choose folder…
              </Button>
            }
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            aria-label="Choose package folder"
            // Not in the DOM typings, but every current browser supports it.
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              readFolder(files);
            }}
          />
          <input
            ref={replaceInput}
            type="file"
            hidden
            accept={ACCEPT}
            aria-label="Choose replacement archive"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              readFiles(files, replaceTarget.current?.namespace);
            }}
          />

          {review && (
            <ReviewCard
              review={review}
              pinned={pinned}
              onNamespace={(namespace) => setReview({ ...review, namespace })}
              onCancel={() => setReview(null)}
              onAdd={() => commit(review.prepared, review.namespace, "upload")}
            />
          )}

          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              submitPin();
            }}
          >
            <label htmlFor="pin-input" className="text-sm font-medium">
              Pin from Typst Universe
            </label>
            <div className="flex gap-2">
              <Input
                id="pin-input"
                value={pinText}
                placeholder="@preview/cetz:0.4.2"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus={prefilled?.namespace === "preview"}
                aria-invalid={pinError !== null}
                aria-describedby={pinError ? pinErrorId : undefined}
                onChange={(e) => {
                  setPinText(e.target.value);
                  setPinError(null);
                }}
                className="font-mono"
              />
              <Button type="submit" disabled={busy || pinText.trim() === ""}>
                {pinning ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <PinIcon />
                )}
                Pin
              </Button>
            </div>
            {pinError ? (
              <p
                id={pinErrorId}
                role="alert"
                className="text-xs text-destructive"
              >
                {pinError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Stores a copy in the project: it compiles offline and never
                changes under you.
              </p>
            )}
          </form>

          {needsUpload && (
            <p
              role="note"
              className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
            >
              This project imports{" "}
              <code className="font-mono text-xs">{needsUpload}</code>, which is
              not on Typst Universe. Upload that package as an archive or
              folder.
            </p>
          )}
        </section>
      )}

      {canEdit && unpinned.length > 0 && (
        <section aria-labelledby="unpinned-heading" className="grid gap-2">
          <h3 id="unpinned-heading" className="text-sm font-medium">
            Used in this project, not pinned
          </h3>
          <ul className="divide-y rounded-lg border">
            {unpinned.map((item) => (
              <li key={item.spec} className="flex items-center gap-3 px-3 py-2">
                <div className="grid min-w-0 flex-1">
                  <code className="truncate font-mono text-sm">
                    {item.spec}
                  </code>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.paths.join(", ")}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Pin ${item.spec}`}
                  disabled={busy}
                  onClick={() => void pin(item)}
                >
                  {pinning === item.spec ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <PinIcon />
                  )}
                  Pin
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {packages.length === 0 ? (
        <EmptyPackages canEdit={canEdit} />
      ) : (
        <section aria-labelledby="installed-heading" className="grid gap-2">
          <h3 id="installed-heading" className="text-sm font-medium">
            In this project
          </h3>
          <ul className="grid gap-3">
            {packages.map((record) => (
              <PackageRow
                key={packageKey(record)}
                record={record}
                canEdit={canEdit}
                onReplace={() => {
                  replaceTarget.current = record;
                  replaceInput.current?.click();
                }}
                onRemove={() => setRemoving(record)}
              />
            ))}
          </ul>
        </section>
      )}

      <ConfirmDeleteDialog
        open={replacement !== null}
        title={
          replacement &&
          `Replace ${formatSpec({ ...replacement.prepared.manifest, namespace: replacement.namespace })}?`
        }
        description="This package is already in the project. Replacing it changes what it compiles to for every collaborator."
        confirmLabel="Replace"
        onCancel={() => setReplacement(null)}
        onConfirm={() => {
          const current = replacement;
          setReplacement(null);
          if (current)
            void store(current.prepared, current.namespace, current.source);
        }}
      />
      <ConfirmDeleteDialog
        open={removing !== null}
        title={removing && `Remove ${formatSpec(removing)}?`}
        description="Anything importing it stops compiling, for every collaborator."
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            const key = packageKey(removing);
            attempt(() => deletePackage(project, key));
          }
          setRemoving(null);
        }}
      />
    </div>
  );
}

function EmptyPackages({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <PackageIcon aria-hidden className="size-6 text-muted-foreground/70" />
      <p className="text-sm font-medium">No packages yet</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {canEdit
          ? "Upload a package, or pin one from Typst Universe so #import works offline."
          : "This project has no packages."}
      </p>
    </div>
  );
}

function ReviewCard({
  review,
  pinned,
  onNamespace,
  onCancel,
  onAdd,
}: {
  review: Review;
  pinned: ReadonlySet<string>;
  onNamespace: (namespace: string) => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  const { prepared, namespace } = review;
  const { manifest } = prepared;
  const nsId = useId();
  const nsErrorId = useId();
  const namespaceOk = isIdent(namespace);
  const unpinned = prepared.dependencies.filter((dep) => !pinned.has(dep));
  return (
    <form
      aria-label="Review package"
      className="grid gap-3 rounded-lg border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (namespaceOk) onAdd();
      }}
    >
      <div className="grid gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-sm font-medium">{manifest.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {manifest.version}
          </span>
        </p>
        {manifest.description && (
          <p className="text-sm text-muted-foreground">
            {manifest.description}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {packageFacts({ ...manifest, ...prepared })}
        </p>
      </div>

      {prepared.warnings.length > 0 && (
        <ul className="grid gap-1 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
          {prepared.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5">
              <AlertTriangleIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-warning"
              />
              {warning}
            </li>
          ))}
        </ul>
      )}
      {prepared.skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {plural(prepared.skipped.length, "file")} could not be kept:{" "}
          {prepared.skipped.slice(0, 3).join(", ")}
          {prepared.skipped.length > 3 && "…"}
        </p>
      )}
      {prepared.dependencies.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium">Imports</p>
          <ul className="flex flex-wrap gap-1.5">
            {prepared.dependencies.map((dep) => (
              <li key={dep}>
                <Badge variant="outline" className="font-mono">
                  {dep}
                </Badge>
              </li>
            ))}
          </ul>
          {unpinned.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Pin these too, or the package will not compile offline.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-1.5">
        <label htmlFor={nsId} className="text-sm font-medium">
          Namespace
        </label>
        <Input
          id={nsId}
          value={namespace}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={!namespaceOk}
          aria-describedby={namespaceOk ? undefined : nsErrorId}
          onChange={(e) => onNamespace(e.target.value.trim())}
          className="font-mono sm:max-w-xs"
        />
        {!namespaceOk && (
          <p id={nsErrorId} role="alert" className="text-xs text-destructive">
            Use letters, digits, - and _, starting with a letter.
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <p className="text-xs font-medium">Import it with</p>
        {namespaceOk ? (
          <CopySnippet
            text={importSnippet({
              namespace,
              name: manifest.name,
              version: manifest.version,
            })}
            label="import line"
          />
        ) : (
          <p className="rounded-md border border-dashed px-2 py-1.5 font-mono text-xs text-muted-foreground">
            Pick a valid namespace first
          </p>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!namespaceOk}>
          Add package
        </Button>
      </div>
    </form>
  );
}

function PackageRow({
  record,
  canEdit,
  onReplace,
  onRemove,
}: {
  record: PackageRecord;
  canEdit: boolean;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const spec = formatSpec(record);
  return (
    <li aria-label={spec} className="grid gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-sm font-medium">{record.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {record.version}
          </span>
          <Badge variant="outline" className="font-mono">
            @{record.namespace}
          </Badge>
          <Badge variant="secondary">
            {record.source === "universe" ? "Universe" : "Uploaded"}
          </Badge>
          {needsNewerCompiler(record) && (
            <Badge className="bg-warning/15 text-foreground">
              <AlertTriangleIcon aria-hidden className="text-warning" />
              Needs Typst {record.compiler}
            </Badge>
          )}
        </div>
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${spec}`}
              >
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onReplace}>Replace…</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {record.description && (
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {record.description}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{packageFacts(record)}</p>
      <CopySnippet text={importSnippet(record)} label={`import for ${spec}`} />
    </li>
  );
}
