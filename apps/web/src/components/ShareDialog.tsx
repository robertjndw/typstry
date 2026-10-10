import { CheckIcon, CopyIcon, Share2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { loadShareLinks, projectUrl } from "@/project/recent";
import type { SharePermission } from "@/sync/api";

export interface ShareDialogProps {
  projectId: string;
  /** The token this page was opened with. */
  token: string;
  /** Encryption key; part of every link, never sent to the server. */
  projectKey: string;
  permission: SharePermission;
  /** From the share lookup; set for edit links, so any editor can pass on a view link. */
  viewToken?: string;
}

export function ShareDialog({
  projectId,
  token,
  projectKey,
  permission,
  viewToken: resolvedViewToken,
}: ShareDialogProps) {
  const [open, setOpen] = useState(false);
  // Read on open so links saved in another tab show up.
  const links = open ? loadShareLinks(projectId) : null;
  const editToken =
    permission === "write" ? (links?.editToken ?? token) : undefined;
  const viewToken =
    permission === "read" ? token : (links?.viewToken ?? resolvedViewToken);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2Icon />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
          <DialogDescription>
            Anyone with a link can open this project. There are no accounts, so
            treat the edit link like a password. The project is end-to-end
            encrypted: the key is in the link, and the server never sees it.
          </DialogDescription>
        </DialogHeader>
        {editToken && (
          <LinkRow label="Can edit" url={projectUrl(editToken, projectKey)} />
        )}
        {viewToken ? (
          <LinkRow label="Can view" url={projectUrl(viewToken, projectKey)} />
        ) : (
          <p className="text-xs text-muted-foreground">
            The view-only link is only known to the browser that created this
            project.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const id = `share-${label.replace(/\s+/g, "-").toLowerCase()}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copying failed. Select the link and copy it manually.");
    }
  }

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={url}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label.toLowerCase()} link`}
          onClick={copy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}
