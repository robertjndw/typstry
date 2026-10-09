import type { TreeID } from "loro-crdt";
import { DownloadIcon, FileIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ownBuffer } from "@/crypto/project-key";
import { basename } from "@/doc/names";
import { NODE } from "@/doc/schema";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp)$/;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read-only view of a binary file: an image preview or its metadata. */
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
  const mime = data?.get(NODE.mime);
  const name = basename(path);
  const url = useDecryptedUrl(
    assets && typeof hash === "string" ? hash : null,
    typeof mime === "string" ? mime : "application/octet-stream",
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="truncate font-mono" title={path}>
          {path}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {typeof mime === "string" && mime}
          {typeof size === "number" && ` · ${formatSize(size)}`}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-muted/30 p-4">
        {url === "loading" ? (
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        ) : url && typeof mime === "string" && IMAGE_MIME.test(mime) ? (
          <img
            src={url}
            alt={name}
            className="max-h-full max-w-full object-contain shadow-sm"
          />
        ) : (
          <>
            <FileIcon className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Binary files cannot be edited here.
            </p>
          </>
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
    assets.load(hash).then(
      (bytes) => {
        if (!active) return;
        url = URL.createObjectURL(new Blob([ownBuffer(bytes)], { type: mime }));
        setState({ hash, url });
      },
      (err: unknown) => {
        console.error(err);
        if (active) setState({ hash, url: null });
      },
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assets, hash, mime]);

  if (!assets || !hash) return undefined;
  if (state?.hash !== hash) return "loading";
  return state.url ?? undefined;
}
