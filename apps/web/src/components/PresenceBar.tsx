import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePresenceSummary } from "@/presence/context";
import { initials, type Identity } from "@/presence/identity";
import { useProject } from "@/project/context";

const MAX_SHOWN = 5;

/** Avatars of everybody else here; clicking one opens their file. */
export function PresenceBar() {
  const peers = usePresenceSummary();
  const { index, openFile } = useProject();
  if (peers.length === 0) return null;

  const shown = peers.slice(0, MAX_SHOWN);
  const hidden = peers.slice(MAX_SHOWN);

  return (
    <div
      role="list"
      aria-label="People in this project"
      className="flex items-center -space-x-1.5"
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
                className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 enabled:cursor-pointer"
              >
                <PersonAvatar identity={peer} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {peer.name}
              {path && <span className="opacity-70">in {path}</span>}
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
