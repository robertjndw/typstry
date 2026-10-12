import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  KeyRoundIcon,
  PenLineIcon,
  Share2Icon,
  ShieldCheckIcon,
  UserMinusIcon,
  UserXIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { MembersSection } from "@/components/MembersSection";
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
import { guard, type SpaceCrypto } from "@/crypto/space-crypto";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { LinkSecret } from "@/crypto/wasm";
import { cn } from "@/lib/utils";
import type { MlsSession } from "@/mls/session";
import { projectUrl } from "@/project/recent";
import { loadSpaceKey, loadShareLinks } from "@/space/space-links";
import type { SharePermission } from "@/sync/api";

export interface ShareDialogProps {
  projectId: string;
  /** The token this page was opened with. */
  token: string;
  /** Its secrets are part of every link and never sent to the server. */
  crypto: SpaceCrypto;
  permission: SharePermission;
  /** From the share lookup; set for edit links, so any editor can pass on a view link. */
  viewToken?: string;
  /** The project's member group; null while it is not known yet. */
  mls: MlsSession | null;
}

/**
 * The secrets to put in the links. After a rotation the stored key and the
 * stored tokens are the new pair, while `crypto` can still be the one opened
 * with the old link for a moment; mixing the two would show a link that does
 * not open anything.
 */
function secretsOf(
  stored: string | null,
  crypto: SpaceCrypto,
): { editSecret: string | null; viewSecret: string } {
  try {
    if (stored) {
      const link = guard(() => LinkSecret.parse(stored));
      return {
        editSecret: link.canAttest() ? stored : null,
        viewSecret: link.viewSecret(),
      };
    }
  } catch {
    // A key this build cannot read; the open project's own is all there is.
  }
  return { editSecret: crypto.editSecret, viewSecret: crypto.viewSecret };
}

const FACTS: { Icon: LucideIcon; text: string }[] = [
  {
    Icon: UserXIcon,
    text: "There are no accounts. Anyone with a current link can join, so treat the edit link like a password.",
  },
  {
    Icon: KeyRoundIcon,
    text: "The project is end-to-end encrypted. The key is part of the link and never sent to the server.",
  },
  {
    Icon: ShieldCheckIcon,
    text: "Members are authenticated per device. Each one signs what it writes, and only the edit link can make a device an editor, so view links stay read-only even if the server were compromised.",
  },
  {
    Icon: UserMinusIcon,
    text: "Removing a member or resetting the links cuts off everything added afterwards, and the members who remain get the new links automatically. What someone already saw, they keep, and anyone who still has a current link can join again.",
  },
];

export function ShareDialog({
  projectId,
  token,
  crypto,
  permission,
  viewToken: resolvedViewToken,
  mls,
}: ShareDialogProps) {
  const [open, setOpen] = useState(false);
  // Read on open so links saved in another tab show up.
  const links = open ? loadShareLinks(projectId) : null;
  const { editSecret, viewSecret } = secretsOf(
    open ? loadSpaceKey(projectId) : null,
    crypto,
  );
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
      <DialogContent className="max-h-[calc(100svh-2rem)] gap-5 overflow-y-auto sm:max-w-md">
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
              url={projectUrl(viewToken, viewSecret)}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              The view-only link is only known to the browser that created this
              project.
            </p>
          )}
        </div>
        <MembersSection mls={mls} />
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
  const { copied, copy } = useCopyToClipboard(
    "Copying failed. Select the link and copy it manually.",
  );
  const id = `share-${label.replace(/\s+/g, "-").toLowerCase()}`;

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
              onClick={() => void copy(url)}
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
