import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjectFonts } from "@/fonts/useProjectFonts";
import { useProject } from "@/project/context";

import { FontsTab } from "./FontsTab";
import { usePackages } from "./hooks";
import { PackagesTab } from "./PackagesTab";
import type { FontsPackagesTarget } from "./types";

export interface FontsPackagesDialogProps {
  /** Where to open; null keeps the dialog closed. */
  open: FontsPackagesTarget | null;
  onClose: () => void;
}

export default function FontsPackagesDialog({
  open,
  onClose,
}: FontsPackagesDialogProps) {
  // A new target while the dialog is open (a second hint clicked) has to
  // reset the tab and the prefilled field, so the body remounts per target.
  const [seen, setSeen] = useState(open);
  const [generation, setGeneration] = useState(0);
  if (open !== seen) {
    setSeen(open);
    setGeneration((n) => n + 1);
  }
  return (
    <Dialog open={open !== null} onOpenChange={(next) => !next && onClose()}>
      {open && (
        <DialogContent className="flex h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <Body key={generation} target={open} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function Body({
  target,
  onClose,
}: {
  target: FontsPackagesTarget;
  onClose: () => void;
}) {
  const { readOnly, assets, openFile } = useProject();
  const [tab, setTab] = useState(target.tab);
  const fonts = useProjectFonts();
  const packages = usePackages();
  const canEdit = !readOnly && assets !== null;

  return (
    <>
      <DialogHeader className="gap-1.5 p-4 pr-12 pb-3">
        <DialogTitle>Fonts &amp; Packages</DialogTitle>
        <DialogDescription>
          Everything the compiler loads besides your files. Changes apply for
          every collaborator.
        </DialogDescription>
      </DialogHeader>
      {!canEdit && (
        <p
          role="note"
          className="mx-4 mb-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"
        >
          {readOnly
            ? "You can view fonts and packages. Ask an editor to change them."
            : "Fonts and packages can't be added to this project."}
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next as FontsPackagesTarget["tab"])}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList className="mx-4 mb-3 w-fit">
          <TabsTrigger value="fonts" className="px-3">
            Fonts
            <Count n={fonts.families.length} />
          </TabsTrigger>
          <TabsTrigger value="packages" className="px-3">
            Packages
            <Count n={packages.length} />
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="fonts"
          className="min-h-0 overflow-y-auto border-t px-4 py-4"
        >
          <FontsTab
            fonts={fonts}
            canEdit={canEdit}
            onOpenFile={(id) => {
              openFile(id);
              onClose();
            }}
          />
        </TabsContent>
        <TabsContent
          value="packages"
          className="min-h-0 overflow-y-auto border-t px-4 py-4"
        >
          <PackagesTab
            packages={packages}
            canEdit={canEdit}
            prefill={target.prefill}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Count({ n }: { n: number }) {
  return (
    <Badge
      variant="secondary"
      className="h-4 min-w-4 bg-background/60 px-1 text-[0.6875rem] tabular-nums"
    >
      {n}
    </Badge>
  );
}
