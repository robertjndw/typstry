import { DownloadIcon, FileDownIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ownBuffer } from "@/crypto/project-key";
import {
  useDownload,
  useZipDownload,
  type ZipDownloadOptions,
} from "@/hooks/use-download";
import { downloadFilename } from "@/lib/download";
import { toError } from "@/lib/errors";
import type { CompilerClient } from "@/typst/compiler-client";

/** Downloads the given project state as a zip of all its files. */
export function DownloadButton({
  variant = "ghost",
  className,
  ...options
}: ZipDownloadOptions & {
  variant?: "ghost" | "outline";
  className?: string;
}) {
  const { busy, run } = useZipDownload(options);

  return (
    <Button
      variant={variant}
      size="sm"
      disabled={busy}
      onClick={run}
      title="Download all files as a zip"
      className={className}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
      <span className="max-md:sr-only">Download</span>
    </Button>
  );
}

/** Compiles the main file and downloads the result as a PDF. */
export function PdfDownloadButton({
  compiler,
  name,
  labelled = false,
}: {
  compiler: CompilerClient | null;
  /** Parts of the file name, e.g. the title and a version label. */
  name: string[];
  /** A text button for where it is the main action, not a toolbar icon. */
  labelled?: boolean;
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

  const icon = busy ? (
    <Loader2Icon className="animate-spin" />
  ) : (
    <FileDownIcon />
  );
  if (labelled) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !compiler}
        onClick={run}
      >
        {icon}
        <span className="max-sm:sr-only">Download PDF</span>
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Download PDF"
      title="Download PDF"
      disabled={busy || !compiler}
      onClick={run}
    >
      {icon}
    </Button>
  );
}
