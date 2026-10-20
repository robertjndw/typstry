import {
  CheckCheckIcon,
  CheckIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { PersonAvatar } from "@/components/PresenceBar";
import { ToolbarButton } from "@/components/ToolbarButton";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  addComment,
  deleteComment,
  MAX_COMMENT_CHARS,
  normalizeCommentBody,
  reopenThread,
  reply,
  resolveAnchor,
  resolveThread,
  type Comment,
} from "@/doc/comments";
import { getText } from "@/doc/fs-ops";
import type { PathIndex } from "@/doc/paths";
import type { ProjectDoc } from "@/doc/schema";
import { SIDEBAR_AUTOFOCUS_ATTR } from "@/hooks/use-sidebar-tab";
import { cn } from "@/lib/utils";
import { useRoster } from "@/mls/context";
import type { RosterMember } from "@/mls/members";
import { usePresenceContext } from "@/presence/context";
import {
  provisionalIdentity,
  useStoredIdentity,
  type Identity,
} from "@/presence/identity";
import {
  useCommentsUi,
  useCommentsUiState,
  type CommentDraft,
} from "@/project/comments-ui";
import { useProject } from "@/project/context";
import {
  authorIdentity,
  formatAbsolute,
  formatRelative,
} from "@/project/history-items";
import { useReveal } from "@/project/reveal-context";
import {
  arrangeThreads,
  useComments,
  type CommentScope,
  type ThreadView,
} from "@/project/useComments";

const textareaClass =
  "w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** Who this browser writes comments as; the same name presence shows. */
function useCommentIdentity(): Identity {
  const presence = usePresenceContext()?.identity;
  const stored = useStoredIdentity();
  return presence ?? stored ?? provisionalIdentity();
}

/**
 * Whether `peer` wrote as the person using this browser: this page load, a
 * device the roster says is ours, or another device of the same verified
 * person. Only decides what the UI offers; any editor can write any op.
 */
function ownsPeer(
  peer: string,
  localPeer: string,
  memberOfPeer: ((peer: string) => RosterMember | null) | undefined,
  self: RosterMember | undefined,
): boolean {
  if (peer === localPeer) return true;
  const member = memberOfPeer?.(peer);
  if (!member) return false;
  if (member.isSelf) return true;
  return (
    !!self?.person &&
    member.person === self.person &&
    member.personState !== "unverified" &&
    self.personState !== "unverified"
  );
}

/** The Comments sidebar tab: the drafting box and every thread in scope. */
export function CommentsPanel() {
  const { project, index, openFileId, readOnly } = useProject();
  const ui = useCommentsUi();
  const { active, draft } = useCommentsUiState(ui);
  const threads = useComments(project);
  const roster = useRoster();
  const [scope, setScope] = useState<CommentScope>("file");
  const [showResolved, setShowResolved] = useState(false);
  const [deleting, setDeleting] = useState<Comment | null>(null);

  // Without an open file "this file" would always be empty.
  const effectiveScope: CommentScope = openFileId ? scope : "all";
  const { attached, detached } = arrangeThreads(threads, {
    scope: effectiveScope,
    openFileId,
    showResolved,
    index,
  });

  const self = roster?.members.find((m) => m.isSelf);
  const canDelete = (comment: Comment) =>
    !readOnly &&
    ownsPeer(comment.peer, project.doc.peerIdStr, roster?.memberOfPeer, self);

  function confirmDelete() {
    const comment = deleting;
    setDeleting(null);
    if (!comment) return;
    try {
      deleteComment(project, comment.id);
      if (comment.thread === null && active === comment.id) ui?.setActive(null);
    } catch (error) {
      reportError(error, "Could not delete the comment");
    }
  }

  const empty = attached.length === 0 && detached.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase select-none">
          Comments
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Which comments"
          value={effectiveScope}
          disabled={!openFileId}
          // Clicking the active option would clear a single toggle group.
          onValueChange={(value) =>
            (value === "file" || value === "all") && setScope(value)
          }
        >
          <ToggleGroupItem value="file" className="h-6 px-2 text-xs">
            This file
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="h-6 px-2 text-xs">
            All files
          </ToggleGroupItem>
        </ToggleGroup>
        <ToolbarButton
          label="Show resolved"
          tooltip={showResolved ? "Hide resolved" : "Show resolved"}
          aria-pressed={showResolved}
          variant={showResolved ? "secondary" : "ghost"}
          onClick={() => setShowResolved((v) => !v)}
        >
          <CheckCheckIcon />
        </ToolbarButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {draft && !readOnly && ui && (
          <Composer
            key={`${draft.fileId}:${draft.anchor.join(",")}`}
            project={project}
            draft={draft}
            onDone={(id) => {
              ui.cancelDraft();
              if (id) {
                ui.setActive(id);
                // A comment on another file would vanish from "this file".
                if (draft.fileId !== openFileId) setScope("all");
              }
            }}
          />
        )}
        {empty && !draft ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {readOnly
              ? "No comments yet."
              : "No comments yet. Select some text and choose Comment."}
          </p>
        ) : (
          <>
            <ThreadList
              label="Comments"
              threads={attached}
              index={index}
              showPaths={effectiveScope === "all"}
              active={active}
              canDelete={canDelete}
              onDelete={setDeleting}
            />
            {detached.length > 0 && (
              <section aria-labelledby="comments-detached">
                <h3
                  id="comments-detached"
                  className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                >
                  Detached
                </h3>
                <p className="px-3 pb-1 text-xs text-muted-foreground">
                  The text these were about is gone.
                </p>
                <ThreadList
                  label="Detached comments"
                  threads={detached}
                  index={index}
                  showPaths={effectiveScope === "all"}
                  active={active}
                  canDelete={canDelete}
                  onDelete={setDeleting}
                />
              </section>
            )}
          </>
        )}
      </div>
      <ConfirmDeleteDialog
        open={deleting !== null}
        title={
          deleting?.thread === null ? "Delete this thread?" : "Delete reply?"
        }
        description={
          deleting?.thread === null
            ? "The comment and all its replies are removed for everyone."
            : "The reply is removed for everyone."
        }
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function reportError(error: unknown, fallback: string) {
  console.error(error);
  toast.error(error instanceof Error ? error.message : fallback);
}

/** Submits on Mod+Enter, the usual shortcut for multi-line inputs. */
function submitOnModEnter(submit: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
}

function Composer({
  project,
  draft,
  onDone,
}: {
  project: ProjectDoc;
  draft: CommentDraft;
  onDone: (id: string | null) => void;
}) {
  const identity = useCommentIdentity();
  const [body, setBody] = useState("");
  const valid = normalizeCommentBody(body) !== null;

  function submit() {
    if (!valid) return;
    // The draft's cursors followed every edit since it was opened, so this
    // is the text that was selected then, wherever it is now.
    const range = resolveAnchor(project, draft);
    if (!range) {
      toast.error("The selected text is gone. Select it again to comment.");
      onDone(null);
      return;
    }
    try {
      const id = addComment(project, {
        fileId: draft.fileId,
        text: getText(project, draft.fileId),
        from: range.from,
        to: range.to,
        body,
        name: identity.name,
        color: identity.color,
      });
      onDone(id);
    } catch (error) {
      reportError(error, "Could not add the comment");
    }
  }

  return (
    <form
      aria-label="New comment"
      className="grid gap-2 border-b p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Quote>{draft.quote}</Quote>
      <textarea
        {...{ [SIDEBAR_AUTOFOCUS_ATTR]: "" }}
        aria-label="Comment"
        placeholder="Add a comment"
        rows={3}
        maxLength={MAX_COMMENT_CHARS}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={submitOnModEnter(submit)}
        className={textareaClass}
      />
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDone(null)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid}>
          Comment
        </Button>
      </div>
    </form>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="line-clamp-3 border-l-2 border-[oklch(0.75_0.14_85)] pl-2 text-xs whitespace-pre-wrap text-muted-foreground">
      {children}
    </blockquote>
  );
}

function ThreadList({
  label,
  threads,
  index,
  showPaths,
  active,
  canDelete,
  onDelete,
}: {
  label: string;
  threads: ThreadView[];
  index: PathIndex;
  showPaths: boolean;
  active: string | null;
  canDelete: (comment: Comment) => boolean;
  onDelete: (comment: Comment) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <ul aria-label={label} className="grid gap-px">
      {threads.map((view) => (
        <li key={view.thread.id}>
          <ThreadCard
            view={view}
            path={
              showPaths
                ? (index.byId.get(view.thread.root.fileId)?.path ?? null)
                : null
            }
            active={active === view.thread.id}
            canDelete={canDelete}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  );
}

function ThreadCard({
  view,
  path,
  active,
  canDelete,
  onDelete,
}: {
  view: ThreadView;
  path: string | null;
  active: boolean;
  canDelete: (comment: Comment) => boolean;
  onDelete: (comment: Comment) => void;
}) {
  const { project, readOnly } = useProject();
  const ui = useCommentsUi();
  const reveal = useReveal();
  const { thread, range } = view;
  const ref = useRef<HTMLElement>(null);

  // A click on the highlight in the editor brings its thread into view.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const resolved = thread.resolvedAt !== null;
  const author = useAuthor(thread.root);

  function toggleResolved() {
    try {
      if (resolved) reopenThread(project, thread.id);
      else resolveThread(project, thread.id);
    } catch (error) {
      reportError(error, "Could not change the comment");
    }
  }

  return (
    <article
      ref={ref}
      aria-label={`Comment by ${author.name}`}
      data-active={active || undefined}
      className={cn(
        "grid gap-2 border-b px-3 py-2.5 transition-colors",
        active && "bg-muted/60",
        resolved && "opacity-70",
      )}
      onClick={() => ui?.setActive(thread.id)}
    >
      {path && (
        <span className="truncate text-[11px] text-muted-foreground">
          {path}
        </span>
      )}
      {range ? (
        <button
          type="button"
          title="Show in the editor"
          className="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => {
            ui?.setActive(thread.id);
            // Read again: the range may have moved since this render.
            const now = resolveAnchor(project, thread.root);
            if (now) reveal(thread.root.fileId, { kind: "offset", ...now });
          }}
        >
          <Quote>{thread.root.quote}</Quote>
        </button>
      ) : (
        <Quote>{thread.root.quote}</Quote>
      )}
      <CommentItem
        comment={thread.root}
        canDelete={canDelete}
        onDelete={onDelete}
      />
      {thread.replies.map((r) => (
        <div key={r.id} className="border-l pl-2.5">
          <CommentItem comment={r} canDelete={canDelete} onDelete={onDelete} />
        </div>
      ))}
      {!readOnly && (
        <div className="flex items-start gap-1.5">
          {!resolved && <ReplyBox threadId={thread.id} />}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(resolved && "ml-auto")}
            onClick={(e) => {
              e.stopPropagation();
              toggleResolved();
            }}
          >
            {resolved ? <RotateCcwIcon /> : <CheckIcon />}
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        </div>
      )}
      {readOnly && resolved && (
        <span className="text-xs text-muted-foreground">Resolved</span>
      )}
    </article>
  );
}

/**
 * Who wrote `comment`. The roster's signed name wins; the one stored with
 * the comment is only what its author claimed.
 */
function useAuthor(comment: Comment): Identity {
  const { project } = useProject();
  const memberOfPeer = useRoster()?.memberOfPeer;
  return useMemo(
    () =>
      authorIdentity(project, comment.peer, memberOfPeer, {
        name: comment.name,
        color: comment.color,
      }),
    [project, comment, memberOfPeer],
  );
}

function CommentItem({
  comment,
  canDelete,
  onDelete,
}: {
  comment: Comment;
  canDelete: (comment: Comment) => boolean;
  onDelete: (comment: Comment) => void;
}) {
  const author = useAuthor(comment);
  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <PersonAvatar identity={author} />
        <span className="truncate text-xs font-medium">{author.name}</span>
        <time
          dateTime={new Date(comment.createdAt).toISOString()}
          title={formatAbsolute(comment.createdAt)}
          className="shrink-0 text-[11px] text-muted-foreground"
        >
          {formatRelative(comment.createdAt)}
        </time>
        {canDelete(comment) && (
          <ToolbarButton
            label={comment.thread === null ? "Delete thread" : "Delete reply"}
            className="ml-auto size-6"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(comment);
            }}
          >
            <Trash2Icon />
          </ToolbarButton>
        )}
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

function ReplyBox({ threadId }: { threadId: string }) {
  const { project } = useProject();
  const identity = useCommentIdentity();
  const [body, setBody] = useState("");
  const valid = normalizeCommentBody(body) !== null;

  function submit() {
    if (!valid) return;
    try {
      reply(project, threadId, {
        body,
        name: identity.name,
        color: identity.color,
      });
      setBody("");
    } catch (error) {
      reportError(error, "Could not reply");
    }
  }

  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label="Reply"
        placeholder="Reply"
        rows={1}
        maxLength={MAX_COMMENT_CHARS}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={submitOnModEnter(submit)}
        className={textareaClass}
      />
      {body && (
        <Button type="submit" size="sm" disabled={!valid} className="self-end">
          Reply
        </Button>
      )}
    </form>
  );
}
