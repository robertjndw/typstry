import { DownloadIcon, FileDownIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import { Button } from "@/components/ui/button";
import { ownBuffer } from "@/crypto/project-key";
import type { ProjectDoc } from "@/doc/schema";
import { ExportError, exportZip } from "@/export/zip";
import { downloadFilename, saveFile } from "@/lib/download";
import { toError } from "@/lib/errors";
import type { CompilerClient } from "@/typst/compiler-client";

/** Saves whatever `produce` returns, with a toast if that fails. */
function useDownload(
  produce: () => Promise<Blob>,
  filename: string,
  describeError: (err: unknown) => string,
) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      saveFile(await produce(), filename);
    } catch (err) {
      console.error(err);
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, run: () => void run() };
}

/** Downloads the given project state as a zip of all its files. */
export function DownloadButton({
  project,
  assets,
  name,
  mtime,
  variant = "ghost",
}: {
  project: ProjectDoc;
  assets: ProjectAssets | null;
  /** Parts of the file name, e.g. the title and a version label. */
  name: string[];
  /** Modification time stamped on the zip entries, unix ms. */
  mtime?: number;
  variant?: "ghost" | "outline";
}) {
  const { busy, run } = useDownload(
    async () => {
      const { zip, skipped } = await exportZip(
        project,
        assets ? (hash) => assets.load(hash) : null,
        mtime,
      );
      if (skipped.length > 0) {
        toast.warning(
          `Left out ${skipped.length === 1 ? skipped[0] : `${skipped.length} files`}: the name is not safe to unpack.`,
        );
      }
      return new Blob([zip], { type: "application/zip" });
    },
    downloadFilename(name, "zip"),
    (err) =>
      err instanceof ExportError
        ? `Download failed: ${err.message}. Check your connection and try again.`
        : "Download failed. See the console for details.",
  );

  return (
    <Button
      variant={variant}
      size="sm"
      disabled={busy}
      onClick={run}
      title="Download all files as a zip"
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
      Download
    </Button>
  );
}

/** Compiles the main file and downloads the result as a PDF. */
export function PdfDownloadButton({
  compiler,
  name,
}: {
  compiler: CompilerClient | null;
  /** Parts of the file name, e.g. the title and a version label. */
  name: string[];
}) {
  const { busy, run } = useDownload(
    async () => {
      if (!compiler) throw new Error("the compiler is not running");
      const pdf = await compiler.exportPdf();
      return new Blob([ownBuffer(pdf)], { type: "application/pdf" });
    },
    downloadFilename(name, "pdf"),
    (err) => `Could not create the PDF: ${toError(err).message}`,
  );

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Download PDF"
      title="Download PDF"
      disabled={busy || !compiler}
      onClick={run}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <FileDownIcon />}
    </Button>
  );
}
