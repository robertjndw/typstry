import type { TreeID } from "loro-crdt";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  FileIcon,
  Trash2Icon,
  TypeIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useId } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { deleteNode } from "@/doc/fs-ops";
import {
  BUILTIN_FAMILIES,
  BUILTIN_BYTES,
  FONT_BUNDLES,
  type FontBundleId,
} from "@/fonts/builtin";
import {
  ensureFontsDir,
  partitionFontFiles,
  validateFontFile,
} from "@/fonts/upload-fonts";
import { useFontSample } from "@/fonts/useFontSample";
import type {
  FontFamilyGroup,
  ProjectFontFace,
  ProjectFonts,
} from "@/fonts/useProjectFonts";
import { toError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";
import { attempt, uploadReporting } from "@/project/tree";

import { CopySnippet } from "./CopySnippet";
import { DropZone } from "./DropZone";
import { formatBytes, plural } from "./format";
import { useFontBundles } from "./hooks";

const SAMPLE = "The quick brown fox jumps over the lazy dog";
const ACCEPT = ".ttf,.otf,.ttc,.otc";

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

function describeFace(face: ProjectFontFace): string {
  const { weight, italic, style } = face.info;
  const named = WEIGHT_NAMES[weight];
  if (!named) return `${style} · ${weight}`;
  // The font's own style string wins when it says more than the numbers.
  const label = style && style.toLowerCase() !== "regular" ? style : named;
  return `${label} · ${weight}${italic && !/italic|oblique/i.test(label) ? " · Italic" : ""}`;
}

/** Whether the element is on screen, so samples load lazily. */
function useVisible() {
  const ref = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && setVisible(true),
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}

export function FontsTab({
  fonts,
  canEdit,
  onOpenFile,
}: {
  fonts: ProjectFonts;
  canEdit: boolean;
  onOpenFile: (id: TreeID) => void;
}) {
  const { project, assets } = useProject();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{
    nodeId: TreeID;
    path: string;
  } | null>(null);
  const { families, unsupported, errors, loading } = fonts;
  const failed = Object.entries(errors);
  const empty =
    families.length === 0 &&
    unsupported.length === 0 &&
    failed.length === 0 &&
    !loading;

  async function addFonts(files: File[]) {
    if (!assets) return;
    const { ok, woff, other } = partitionFontFiles(files);
    if (woff.length > 0) {
      toast.error(
        `${woff.map((f) => f.name).join(", ")}: Typst can't read WOFF or WOFF2 fonts. Convert them to TTF or OTF first, for example with fonttools.`,
      );
    }
    if (other.length > 0) {
      toast.error(
        `${other.map((f) => f.name).join(", ")}: not a font file. Use TTF, OTF or a collection (TTC, OTC).`,
      );
    }
    const valid: File[] = [];
    for (const file of ok) {
      try {
        await validateFontFile(file);
        valid.push(file);
      } catch (err) {
        toast.error(`${file.name}: ${toError(err).message}`);
      }
    }
    if (valid.length === 0) return;
    setBusy(true);
    try {
      const dir = attempt(() => ensureFontsDir(project));
      if (dir === undefined) return;
      const created = await uploadReporting(project, assets, valid, dir);
      if (created.length > 0) {
        toast.success(`Added ${plural(created.length, "font file")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      {canEdit && (
        <DropZone
          title="Add fonts"
          hint="TTF, OTF and collections. Saved to fonts/"
          accept={ACCEPT}
          chooseLabel="Choose fonts…"
          busy={busy}
          onFiles={(files) => void addFonts(files)}
        />
      )}

      {unsupported.length > 0 && (
        <FontNotice title="Web fonts Typst can't use" tone="warning">
          <p>Convert these to TTF or OTF and upload them again.</p>
          <FontPathList
            items={unsupported}
            canEdit={canEdit}
            onOpen={onOpenFile}
            onRemove={setRemoving}
          />
        </FontNotice>
      )}
      {failed.length > 0 && (
        <FontNotice title="Fonts that could not be read" tone="destructive">
          <ul className="grid gap-1">
            {failed.map(([path, message]) => (
              <li key={path} className="break-words">
                <span className="font-mono text-xs">{path}</span>: {message}
              </li>
            ))}
          </ul>
        </FontNotice>
      )}

      {empty ? (
        <EmptyFonts canEdit={canEdit} />
      ) : (
        <ul aria-label="Fonts in this project" className="grid gap-3">
          {families.map((group) => (
            <FamilyCard
              key={group.family}
              group={group}
              load={fonts.load}
              canEdit={canEdit}
              onOpen={onOpenFile}
              onRemove={setRemoving}
            />
          ))}
          {loading && (
            <li aria-label="Loading fonts">
              <Skeleton className="h-24 rounded-lg" />
            </li>
          )}
        </ul>
      )}

      <BuiltinFonts canEdit={canEdit} />

      <ConfirmDeleteDialog
        open={removing !== null}
        title={removing && `Remove ${removing.path}?`}
        description="The font file is deleted for everyone in this project. Documents set in it fall back to another font."
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) attempt(() => deleteNode(project, removing.nodeId));
          setRemoving(null);
        }}
      />
    </div>
  );
}

function FontNotice({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "warning" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <div
      role="note"
      className={cn(
        "grid gap-1.5 rounded-lg border p-3 text-sm",
        tone === "warning"
          ? "border-warning/40 bg-warning/10"
          : "border-destructive/30 bg-destructive/5",
      )}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangleIcon
          aria-hidden
          className={cn(
            "size-4",
            tone === "warning" ? "text-warning" : "text-destructive",
          )}
        />
        {title}
      </p>
      <div className="grid gap-2 text-muted-foreground">{children}</div>
    </div>
  );
}

function FontPathList({
  items,
  canEdit,
  onOpen,
  onRemove,
}: {
  items: { path: string; nodeId: TreeID }[];
  canEdit: boolean;
  onOpen: (id: TreeID) => void;
  onRemove: (target: { nodeId: TreeID; path: string }) => void;
}) {
  return (
    <ul className="grid gap-1">
      {items.map((item) => (
        <li key={item.nodeId} className="flex items-center gap-1">
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-6 min-w-0 justify-start px-0 font-mono text-foreground"
            onClick={() => onOpen(item.nodeId)}
          >
            <span className="truncate">{item.path}</span>
          </Button>
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label={`Remove ${item.path}`}
              onClick={() => onRemove(item)}
            >
              <Trash2Icon />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function EmptyFonts({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <TypeIcon aria-hidden className="size-6 text-muted-foreground/70" />
      <p className="text-sm font-medium">No custom fonts yet</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {canEdit
          ? "Typst's built-in fonts are always available. Add your own above, then use them with #set text(font: …)."
          : "This project only uses Typst's built-in fonts."}
      </p>
    </div>
  );
}

function FamilyCard({
  group,
  load,
  canEdit,
  onOpen,
  onRemove,
}: {
  group: FontFamilyGroup;
  load: ProjectFonts["load"];
  canEdit: boolean;
  onOpen: (id: TreeID) => void;
  onRemove: (target: { nodeId: TreeID; path: string }) => void;
}) {
  const { ref, visible } = useVisible();
  // Only the first face of a collection can be previewed, and the regular
  // weight represents the family best.
  const head =
    group.faces
      .filter((face) => face.info.index === 0)
      .sort(
        (a, b) =>
          Math.abs(a.info.weight - 400) - Math.abs(b.info.weight - 400) ||
          Number(a.info.italic) - Number(b.info.italic),
      )[0] ?? null;
  const sample = useFontSample(
    load,
    head?.hash ?? "",
    head?.info.index ?? 1,
    visible && head !== null,
  );
  return (
    <li ref={ref} className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3
          className="min-w-0 truncate text-lg leading-tight font-medium"
          style={
            sample.family
              ? { fontFamily: `"${sample.family}", sans-serif` }
              : {}
          }
        >
          {group.family}
        </h3>
        <CopySnippet
          className="max-w-full"
          text={`#set text(font: ${JSON.stringify(group.family)})`}
          label={`font snippet for ${group.family}`}
        />
      </div>
      <ul
        aria-label={`Faces of ${group.family}`}
        className="grid divide-y rounded-md border bg-muted/20"
      >
        {group.faces.map((face) => (
          <FaceRow
            key={`${face.nodeId}:${face.info.index}`}
            face={face}
            load={load}
            visible={visible}
            canEdit={canEdit}
            onOpen={onOpen}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </li>
  );
}

function FaceRow({
  face,
  load,
  visible,
  canEdit,
  onOpen,
  onRemove,
}: {
  face: ProjectFontFace;
  load: ProjectFonts["load"];
  visible: boolean;
  canEdit: boolean;
  onOpen: (id: TreeID) => void;
  onRemove: (target: { nodeId: TreeID; path: string }) => void;
}) {
  const sample = useFontSample(load, face.hash, face.info.index, visible);
  const label = describeFace(face);
  return (
    <li className="grid gap-1.5 px-3 py-2">
      <div className="min-h-7 text-base leading-7">
        {sample.status === "ready" ? (
          <p
            className="truncate"
            style={{ fontFamily: `"${sample.family}", sans-serif` }}
          >
            {SAMPLE}
          </p>
        ) : sample.status === "unsupported" || sample.status === "error" ? (
          <p className="text-xs text-muted-foreground">
            {sample.status === "unsupported"
              ? "No preview for fonts inside a collection."
              : "Preview unavailable."}
          </p>
        ) : (
          <Skeleton className="h-4 w-2/3" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{label}</span>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-5 min-w-0 gap-1 px-0 font-mono text-muted-foreground"
          title={`Open ${face.path}`}
          onClick={() => onOpen(face.nodeId)}
        >
          <FileIcon aria-hidden />
          <span className="truncate">{face.path}</span>
        </Button>
        <span className="tabular-nums">{formatBytes(face.size)}</span>
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={`Remove ${face.path}`}
            onClick={() => onRemove(face)}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
    </li>
  );
}

function BuiltinFonts({ canEdit }: { canEdit: boolean }) {
  const bundles = useFontBundles();
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        Built-in fonts
        <ChevronDownIcon
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 border-t px-3 py-3">
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">
            Always available ({formatBytes(BUILTIN_BYTES)}).
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {BUILTIN_FAMILIES.map((family) => (
              <li key={family}>
                <Badge variant="outline">{family}</Badge>
              </li>
            ))}
          </ul>
        </div>
        <div className="grid gap-3">
          {(["cjk", "emoji"] as const).map((id) => (
            <BundleRow
              key={id}
              id={id}
              checked={bundles[id]}
              disabled={!canEdit}
              onChange={(on) => bundles.set(id, on)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Downloaded once, then cached.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function BundleRow({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: FontBundleId;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const bundle = FONT_BUNDLES[id];
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid min-w-0 gap-0.5">
        <p id={titleId} className="text-sm font-medium">
          {bundle.label}
          <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
            ~{formatBytes(bundle.bytes)}
          </span>
        </p>
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {bundle.families.join(", ")}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      />
    </div>
  );
}
