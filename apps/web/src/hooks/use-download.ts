import { useState } from "react";
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import type { ProjectDoc } from "@/doc/schema";
import { ExportError, exportZip } from "@/export/zip";
import { downloadFilename, saveFile } from "@/lib/download";

/** Saves whatever `produce` returns, with a toast if that fails. */
export function useDownload(
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

export interface ZipDownloadOptions {
  project: ProjectDoc;
  assets: ProjectAssets | null;
  /** Parts of the file name, e.g. the title and a version label. */
  name: string[];
  /** Modification time stamped on the zip entries, unix ms. */
  mtime?: number;
}

/** Zips the given project state and saves it; for buttons and menu items. */
export function useZipDownload({
  project,
  assets,
  name,
  mtime,
}: ZipDownloadOptions) {
  return useDownload(
    async () => {
      const { zip, skipped, packages, packagesLeftOut } = await exportZip(
        project,
        assets ? (hash) => assets.load(hash) : null,
        mtime,
      );
      if (skipped.length > 0) {
        toast.warning(
          `Left out ${skipped.length === 1 ? skipped[0] : `${skipped.length} files`}: the name is not safe to unpack.`,
        );
      }
      if (packagesLeftOut.length > 0) {
        toast.warning(
          `Left out ${packagesLeftOut.length === 1 ? packagesLeftOut[0] : `${packagesLeftOut.length} packages`}: the project has files in typst-packages/.`,
        );
      }
      if (packages > 0) {
        toast.success("Packages are under typst-packages/ in the zip.");
      }
      return new Blob([zip], { type: "application/zip" });
    },
    downloadFilename(name, "zip"),
    (err) =>
      err instanceof ExportError
        ? `Download failed: ${err.message}. Check your connection and try again.`
        : "Download failed. See the console for details.",
  );
}
