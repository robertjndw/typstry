import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRoster } from "@/mls/context";
import { usePresenceSummary } from "@/presence/context";
import { initials, type Identity } from "@/presence/identity";
import { useProject } from "@/project/context";

const MAX_SHOWN = 5;

/** Avatars of everybody else here; clicking one opens their file. */
export function PresenceBar() {
  const summary = usePresenceSummary();
  const roster = useRoster();
  const { index, openFile } = useProject();
  if (summary.length === 0) return null;

  // A name the roster vouches for replaces the one the peer claims for
  // itself: the claim is whatever its page sent, the roster entry is signed.
  const peers = summary.map((peer) => {
    const member = roster?.memberOfPeer(peer.peerId);
    return member
      ? { ...peer, name: member.name, color: member.color, verified: true }
      : { ...peer, verified: false };
  });

  const shown = peers.slice(0, MAX_SHOWN);
  const hidden = peers.slice(MAX_SHOWN);

  return (
    <div
      role="list"
      aria-label="People in this project"
      className="flex shrink-0 items-center -space-x-1.5"
    >
      {shown.map((peer) => {
        const path = peer.fileId
          ? index.byId.get(peer.fileId)?.path
          : undefined;
        return (
          <Tooltip key={peer.peerId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="listitem"
                aria-label={path ? `${peer.name}, in ${path}` : peer.name}
                disabled={!path}
                onClick={() => peer.fileId && openFile(peer.fileId)}
                className="animate-in rounded-full duration-200 fade-in-0 outline-none zoom-in-50 focus-visible:ring-3 focus-visible:ring-ring/50 enabled:cursor-pointer"
              >
                <PersonAvatar identity={peer} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {peer.name}
              {peer.verified && (
                <span className="opacity-70"> · verified member</span>
              )}
              {path && <span className="opacity-70"> · in {path}</span>}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="listitem"
              className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background"
            >
              +{hidden.length}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {hidden.map((p) => p.name).join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function PersonAvatar({ identity }: { identity: Identity }) {
  return (
    <Avatar size="sm" className="ring-2 ring-background">
      <AvatarFallback
        className="text-[10px] font-semibold text-white"
        style={{ backgroundColor: identity.color }}
      >
        {initials(identity.name)}
      </AvatarFallback>
    </Avatar>
  );
}
