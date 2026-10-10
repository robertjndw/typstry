import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  KeyRoundIcon,
  PenLineIcon,
  Share2Icon,
  ShieldCheckIcon,
  UserXIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ProjectKey } from "@/crypto/project-key";
import { cn } from "@/lib/utils";
import { loadShareLinks, projectUrl } from "@/project/recent";
import type { SharePermission } from "@/sync/api";

export interface ShareDialogProps {
  projectId: string;
  /** The token this page was opened with. */
  token: string;
  /** Its secrets are part of every link and never sent to the server. */
  projectKey: ProjectKey;
  permission: SharePermission;
  /** From the share lookup; set for edit links, so any editor can pass on a view link. */
  viewToken?: string;
}

const FACTS: { Icon: LucideIcon; text: string }[] = [
  {
    Icon: UserXIcon,
    text: "There are no accounts. Whoever has a link has its access, so treat the edit link like a password.",
  },
  {
    Icon: KeyRoundIcon,
    text: "The project is end-to-end encrypted. The key is part of the link and never sent to the server.",
  },
  {
    Icon: ShieldCheckIcon,
    text: "Only the edit link can sign changes, so view links stay read-only even if the server were compromised.",
  },
];

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
  const editSecret = projectKey.editSecret;
  const editToken =
    permission === "write" && editSecret
      ? (links?.editToken ?? token)
      : undefined;
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
      <DialogContent className="gap-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
          <DialogDescription>
            Anyone with a link can open this project.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {editToken && editSecret && (
            <LinkRow
              label="Can edit"
              hint="Anyone with this link can edit"
              Icon={PenLineIcon}
              url={projectUrl(editToken, editSecret)}
            />
          )}
          {viewToken ? (
            <LinkRow
              label="Can view"
              hint="Anyone with this link can view"
              Icon={EyeIcon}
              url={projectUrl(viewToken, projectKey.viewSecret)}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              The view-only link is only known to the browser that created this
              project.
            </p>
          )}
        </div>
        <details className="group rounded-lg border bg-muted/30 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-2 font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
            About links and encryption
          </summary>
          <ul className="grid gap-2.5 px-3 pt-1 pb-3">
            {FACTS.map(({ Icon, text }) => (
              <li key={text} className="flex gap-2.5 text-muted-foreground">
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </details>
      </DialogContent>
    </Dialog>
  );
}

function LinkRow({
  label,
  hint,
  Icon,
  url,
}: {
  label: string;
  hint: string;
  Icon: LucideIcon;
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = `share-${label.replace(/\s+/g, "-").toLowerCase()}`;

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copying failed. Select the link and copy it manually.");
    }
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={id}
          className="flex items-center gap-1.5 text-sm font-medium"
        >
          <Icon aria-hidden className="size-3.5 text-muted-foreground" />
          {label}
        </label>
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          aria-describedby={`${id}-hint`}
          readOnly
          value={url}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Tooltip open={copied || undefined}>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label={`Copy ${label.toLowerCase()} link`}
              className={cn(copied && "text-success hover:text-success")}
              onClick={copy}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : "Copy link"}</TooltipContent>
        </Tooltip>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} link copied` : ""}
      </span>
    </div>
  );
}
