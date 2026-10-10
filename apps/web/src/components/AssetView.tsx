import type { TreeID } from "loro-crdt";
import { DownloadIcon, FileIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  fileCategory,
  inertBlobType,
  mimeOf,
  PREVIEWABLE_IMAGE,
} from "@/assets/file-types";
import { Button } from "@/components/ui/button";
import { ownBuffer } from "@/crypto/project-key";
import { basename } from "@/doc/names";
import { NODE } from "@/doc/schema";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read-only view of a binary file: a preview for the formats browsers can
 * show (images, PDFs, audio, video, fonts), otherwise just its metadata.
 */
export function AssetView({
  id,
  className,
}: {
  id: TreeID;
  className?: string;
}) {
  const { project, index, assets } = useProject();
  const path = index.byId.get(id)?.path ?? "";
  const data = project.fs.getNodeByID(id)?.data;
  const hash = data?.get(NODE.hash);
  const size = data?.get(NODE.size);
  const stored = data?.get(NODE.mime);
  const name = basename(path);
  // Older uploads may carry a generic type that the extension can improve
  // on, and the object URL needs a precise one for the browser to render it.
  const mime = mimeOf({
    name,
    type: typeof stored === "string" ? stored : "",
  });
  const url = useDecryptedUrl(
    assets && typeof hash === "string" ? hash : null,
    mime,
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="truncate font-mono text-foreground" title={path}>
          {path}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {mime}
          {typeof size === "number" && ` · ${formatSize(size)}`}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-muted/30 p-4">
        {url === "loading" ? (
          <Loader2Icon
            role="status"
            aria-label="Loading file"
            className="size-6 animate-spin text-muted-foreground"
          />
        ) : url ? (
          <AssetPreview url={url} name={name} mime={mime} />
        ) : (
          <NoPreview
            message={
              assets
                ? "This file could not be loaded."
                : "Binary files cannot be shown here."
            }
          />
        )}
        {url && url !== "loading" && (
          <Button asChild variant="outline" size="sm">
            <a href={url} download={name}>
              <DownloadIcon />
              Download
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function AssetPreview({
  url,
  name,
  mime,
}: {
  url: string;
  name: string;
  mime: string;
}) {
  switch (fileCategory(name, mime)) {
    case "image":
      if (!PREVIEWABLE_IMAGE.test(mime)) break;
      return (
        <img
          src={url}
          alt={name}
          className="max-h-full max-w-full rounded-sm object-contain shadow-sm ring-1 ring-border"
        />
      );
    case "pdf":
      return (
        <iframe
          src={url}
          title={name}
          className="min-h-0 w-full flex-1 rounded-md border bg-background"
        />
      );
    case "audio":
      return <audio src={url} controls className="w-full max-w-md" />;
    case "video":
      return (
        <video src={url} controls className="max-h-full max-w-full shadow-sm" />
      );
    case "font":
      return <FontPreview url={url} />;
  }
  return <NoPreview message="This file type cannot be previewed here." />;
}

function NoPreview({ message }: { message: string }) {
  return (
    <>
      <FileIcon aria-hidden className="size-8 text-muted-foreground/70" />
      <p className="max-w-xs text-center text-sm text-muted-foreground">
        {message}
      </p>
    </>
  );
}

const FONT_SAMPLE = "The quick brown fox jumps over the lazy dog";

let fontPreviews = 0;

/**
 * Renders a sample in the uploaded font. The face is registered under a
 * throwaway family name so it can never shadow a font the UI itself uses.
 */
function FontPreview({ url }: { url: string }) {
  const [state, setState] = useState<{
    url: string;
    family: string | null;
  }>();

  useEffect(() => {
    const family = `typstry-preview-${++fontPreviews}`;
    const face = new FontFace(family, `url(${url})`);
    let active = true;
    face.load().then(
      () => {
        if (!active) return;
        document.fonts.add(face);
        setState({ url, family });
      },
      // Collections (.ttc) and anything else the browser cannot parse.
      () => active && setState({ url, family: null }),
    );
    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [url]);

  if (state?.url !== url)
    return (
      <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
    );
  if (!state.family)
    return <NoPreview message="The browser cannot preview this font." />;
  return (
    <div
      className="flex max-w-full flex-col gap-3 text-center break-words"
      style={{ fontFamily: state.family }}
    >
      <p className="text-4xl">Aa Bb Cc 123</p>
      <p className="text-xl">{FONT_SAMPLE}</p>
      <p className="text-sm">{FONT_SAMPLE}</p>
    </div>
  );
}

function svgDataUrl(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(
      new Blob([ownBuffer(bytes)], { type: "image/svg+xml" }),
    );
  });
}

/**
 * Blobs are stored encrypted, so the browser cannot load them by URL; this
 * decrypts one into an object URL that lives as long as the view.
 */
function useDecryptedUrl(
  hash: string | null,
  mime: string,
): string | "loading" | undefined {
  const { assets } = useProject();
  const [state, setState] = useState<{ hash: string; url: string | null }>();

  useEffect(() => {
    if (!assets || !hash) return;
    let url: string | null = null;
    let active = true;
    assets
      .load(hash)
      .then(async (bytes) => {
        if (!active) return;
        if (mime === "image/svg+xml") {
          // An SVG object URL opened in a tab would be a document on our
          // origin. A data URL renders the same in <img>, and browsers
          // refuse to navigate to one.
          const dataUrl = await svgDataUrl(bytes);
          if (active) setState({ hash, url: dataUrl });
          return;
        }
        url = URL.createObjectURL(
          new Blob([ownBuffer(bytes)], { type: inertBlobType(mime) }),
        );
        setState({ hash, url });
      })
      .catch((err: unknown) => {
        console.error(err);
        if (active) setState({ hash, url: null });
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assets, hash, mime]);

  if (!assets || !hash) return undefined;
  if (state?.hash !== hash) return "loading";
  return state.url ?? undefined;
}
