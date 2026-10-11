//! The delivery service half of a project's room: sequences MLS commits,
//! keeps the sealed GroupInfo and keyring, and relays commits to whoever is
//! subscribed. It never looks inside an MLS message beyond the routing
//! prefix `mls_frame::inspect` reads, so it needs no crypto.
//!
//! Everything runs inside the room actor, which is what serializes
//! submissions: two commits for the same epoch reach this code one after
//! the other, the first moves the head and the second sees a conflict. The
//! database enforces the same rule, so a bug here cannot fork the log.

use std::collections::HashMap;

use axum::body::Bytes;
use loro_protocol::CrdtType;
use sqlx::SqlitePool;
use typstry_wire::ds::{ClientMessage, Permission, RefusalCode, Rotate, ServerMessage};
use typstry_wire::mls_frame::{self, ContentType, WireFormat, split_group_id};

use super::{ConnId, DsConfig, Outbound, Outbox};
use crate::store::mls::{self, Head, PruneLimits, Reset, SubmitArgs, SubmitError, Submitted};
use crate::store::projects::{self, DsAccess};

/// A commit backfill is queued under the outbox's backfill rules, which are
/// keyed by room and CRDT. A delivery service socket carries no doc, so this
/// key never clashes with one.
const BACKFILL_CRDT: CrdtType = CrdtType::Elo;

/// What the room hands in with every command.
pub(super) struct Ctx<'a> {
    pub db: &'a SqlitePool,
    pub project_id: &'a str,
    pub config: &'a DsConfig,
    /// Tokens retired since the room loaded, with their rotation's epoch.
    /// A connection can resolve its token just before a rotation lands.
    pub retired_here: &'a HashMap<String, u64>,
}

/// A rotation that was just applied, for the room to act on.
pub(super) struct Rotation {
    pub epoch: u64,
    pub tokens: [String; 2],
}

struct Peer {
    outbox: Outbox,
    token: String,
    permission: Permission,
    /// For a retired token, the epoch of the rotation that retired it. A
    /// retired session reads the log up to and including that commit, which
    /// is all it needs to find the new links.
    retired_epoch: Option<u64>,
}

struct Submission {
    epoch: u64,
    commit: Vec<u8>,
    group_info: Vec<u8>,
    keyring: Option<Vec<u8>>,
    envelope: Option<Vec<u8>>,
    rotate: Option<Rotate>,
}

pub(super) struct DsState {
    /// The group without its blobs; None while the project has no group.
    head: Option<Head>,
    peers: HashMap<ConnId, Peer>,
}

fn refuse(req: u64, code: RefusalCode) -> ServerMessage {
    ServerMessage::Refused { req, code }
}

fn frame(msg: &ServerMessage) -> Bytes {
    Bytes::from(msg.encode())
}

impl DsState {
    pub(super) async fn load(db: &SqlitePool, project_id: &str) -> sqlx::Result<Self> {
        Ok(Self {
            head: mls::load_head(db, project_id).await?,
            peers: HashMap::new(),
        })
    }

    pub(super) fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    pub(super) fn leave(&mut self, conn: ConnId) {
        self.peers.remove(&conn);
    }

    /// The cache can only be wrong after a failed write, whose outcome the
    /// database may or may not have kept.
    async fn refresh(&mut self, ctx: &Ctx<'_>) {
        match mls::load_head(ctx.db, ctx.project_id).await {
            Ok(head) => self.head = head,
            Err(err) => {
                tracing::error!(project = %ctx.project_id, %err, "failed to reload group head");
            }
        }
    }

    fn ready(&self, permission: Permission, retired: Option<u64>) -> ServerMessage {
        ServerMessage::Ready {
            incarnation: self.head.as_ref().map_or(0, |h| h.incarnation),
            head: self.head.as_ref().map_or(0, |h| h.epoch),
            permission,
            retired,
        }
    }

    pub(super) async fn hello(
        &mut self,
        ctx: &Ctx<'_>,
        conn: ConnId,
        token: String,
        access: DsAccess,
        (incarnation, since): (u64, u64),
        outbox: Outbox,
    ) -> bool {
        let (permission, retired) = match (ctx.retired_here.get(&token), access) {
            (Some(&epoch), _) | (None, DsAccess::Retired { epoch }) => {
                (Permission::Retired, Some(epoch))
            }
            (None, DsAccess::Live(crate::store::projects::Permission::Write)) => {
                (Permission::Write, None)
            }
            (None, DsAccess::Live(crate::store::projects::Permission::Read)) => {
                (Permission::Read, None)
            }
        };
        if !outbox.push(Outbound::Binary(frame(&self.ready(permission, retired)))) {
            return false;
        }
        if let Some(head) = &self.head {
            if head.incarnation == incarnation {
                if !backfill(ctx, &outbox, head.incarnation, since, retired).await {
                    return false;
                }
            } else {
                let msg = ServerMessage::Reinitialized {
                    incarnation: head.incarnation,
                };
                if !outbox.push(Outbound::Binary(frame(&msg))) {
                    return false;
                }
            }
        }
        // Registered only after the backfill was queued, within the same
        // actor turn, so no commit can fall between the log and live relay.
        self.peers.insert(
            conn,
            Peer {
                outbox,
                token,
                permission,
                retired_epoch: retired,
            },
        );
        true
    }

    pub(super) async fn message(
        &mut self,
        ctx: &Ctx<'_>,
        conn: ConnId,
        msg: ClientMessage,
    ) -> Option<Rotation> {
        let permission = self.peers.get(&conn)?.permission;
        let (reply, rotation) = match msg {
            // The connection handles the handshake; a second one is a bug.
            ClientMessage::Hello { .. } => (refuse(0, RefusalCode::Malformed), None),
            ClientMessage::Fetch { since } => {
                let peer = &self.peers[&conn];
                if let Some(head) = &self.head
                    && !backfill(
                        ctx,
                        &peer.outbox,
                        head.incarnation,
                        since,
                        peer.retired_epoch,
                    )
                    .await
                {
                    self.peers.remove(&conn);
                }
                return None;
            }
            ClientMessage::Submit {
                req,
                epoch,
                commit,
                group_info,
                keyring,
                envelope,
                rotate,
            } => {
                let submission = Submission {
                    epoch,
                    commit,
                    group_info,
                    keyring,
                    envelope,
                    rotate,
                };
                self.submit(ctx, conn, permission, req, submission).await
            }
            ClientMessage::Init {
                req,
                group_id,
                group_info,
                keyring,
            } => (
                self.init(ctx, permission, req, group_id, &group_info, &keyring)
                    .await,
                None,
            ),
            ClientMessage::Reset {
                req,
                incarnation,
                group_id,
                group_info,
                keyring,
            } => (
                self.reset(
                    ctx,
                    conn,
                    permission,
                    req,
                    (incarnation, group_id),
                    (&group_info, &keyring),
                )
                .await,
                None,
            ),
        };
        self.reply(conn, &reply);
        if let Some(rotation) = &rotation {
            self.retire_peers(rotation);
        }
        rotation
    }

    fn reply(&mut self, conn: ConnId, msg: &ServerMessage) {
        let Some(peer) = self.peers.get(&conn) else {
            return;
        };
        if !peer.outbox.push(Outbound::Binary(frame(msg))) {
            self.peers.remove(&conn);
        }
    }

    /// Sends to every subscriber but `except`. Retired ones only get what is
    /// asked for with a fetch, apart from news of a reset.
    fn broadcast(&mut self, except: ConnId, msg: &ServerMessage, to_retired: bool) {
        let bytes = frame(msg);
        self.peers.retain(|&conn, peer| {
            if conn == except || (peer.permission == Permission::Retired && !to_retired) {
                return true;
            }
            peer.outbox.push(Outbound::Binary(bytes.clone()))
        });
    }

    /// The old tokens' sessions can still read the log but nothing else.
    fn retire_peers(&mut self, rotation: &Rotation) {
        let ready = self.ready(Permission::Retired, Some(rotation.epoch));
        let bytes = frame(&ready);
        self.peers.retain(|_, peer| {
            if !rotation.tokens.contains(&peer.token) {
                return true;
            }
            peer.permission = Permission::Retired;
            peer.retired_epoch = Some(rotation.epoch);
            peer.outbox.push(Outbound::Binary(bytes.clone()))
        });
    }

    async fn submit(
        &mut self,
        ctx: &Ctx<'_>,
        conn: ConnId,
        permission: Permission,
        req: u64,
        s: Submission,
    ) -> (ServerMessage, Option<Rotation>) {
        let reply = |code| (refuse(req, code), None);
        if permission == Permission::Retired {
            return reply(RefusalCode::Retired);
        }
        let Some(head) = self.head.clone() else {
            return reply(RefusalCode::NoGroup);
        };
        // Sizes first: everything below may copy or store what was sent.
        let max = ctx.config.max_group_info_bytes;
        if s.commit.len() > ctx.config.max_commit_bytes
            || s.group_info.is_empty()
            || s.group_info.len() > max
            || [&s.keyring, &s.envelope]
                .into_iter()
                .any(|blob| blob.as_ref().is_some_and(|blob| blob.len() > max))
        {
            return reply(RefusalCode::Malformed);
        }
        let Ok(info) = mls_frame::inspect(&s.commit) else {
            return reply(RefusalCode::BadCommit);
        };
        let routable = matches!(
            info.wire_format,
            WireFormat::PublicMessage | WireFormat::PrivateMessage
        ) && info.content_type == Some(ContentType::Commit);
        if !routable || info.group_id != Some(&head.group_id[..]) || info.epoch != Some(s.epoch) {
            return reply(RefusalCode::BadCommit);
        }
        // A view link may only join: the one commit it can make is an
        // external one, and it cannot touch keys or links.
        if permission == Permission::Read
            && (!info.is_external_commit()
                || s.rotate.is_some()
                || s.keyring.is_some()
                || s.envelope.is_some())
        {
            return reply(RefusalCode::Forbidden);
        }
        // Token swap, keyring and envelope come all together or not at all.
        // Without the new keyring and the envelope carrying the links,
        // clients cannot follow a rotation, and those two mean nothing
        // without the token swap.
        let parts = [
            s.rotate.is_some(),
            s.keyring.is_some(),
            s.envelope.is_some(),
        ];
        if parts.iter().any(|&p| p) != parts.iter().all(|&p| p) {
            return reply(RefusalCode::Malformed);
        }

        let args = SubmitArgs {
            incarnation: head.incarnation,
            epoch: s.epoch,
            commit: &s.commit,
            group_info: &s.group_info,
            keyring: s.keyring.as_deref(),
            envelope: s.envelope.as_deref(),
            rotate: s
                .rotate
                .as_ref()
                .map(|r| (r.edit_token.as_str(), r.view_token.as_str())),
        };
        match mls::submit(ctx.db, ctx.project_id, &args).await {
            Ok(Submitted::Accepted { retired }) => {
                if let Some(head) = &mut self.head {
                    head.epoch = s.epoch + 1;
                }
                let relay = ServerMessage::Commit {
                    epoch: s.epoch,
                    commit: s.commit,
                    envelope: s.envelope,
                };
                self.broadcast(conn, &relay, false);
                prune(ctx, head.incarnation, s.epoch + 1).await;
                let rotation = retired.map(|(edit, view)| Rotation {
                    epoch: s.epoch,
                    tokens: [edit, view],
                });
                (ServerMessage::Accepted { req }, rotation)
            }
            Ok(Submitted::Conflict { head: current }) => {
                if let Some(head) = &mut self.head {
                    head.epoch = current;
                }
                if s.epoch > current {
                    return reply(RefusalCode::BadCommit);
                }
                (ServerMessage::Conflict { req, head: current }, None)
            }
            Ok(Submitted::NoGroup) => {
                self.head = None;
                reply(RefusalCode::NoGroup)
            }
            Ok(Submitted::WrongIncarnation) => {
                self.refresh(ctx).await;
                reply(RefusalCode::WrongIncarnation)
            }
            Err(SubmitError::Rotate(err)) => {
                tracing::debug!(project = %ctx.project_id, %err, "rotation refused");
                reply(RefusalCode::Malformed)
            }
            Err(SubmitError::Db(err)) => {
                tracing::error!(project = %ctx.project_id, %err, "failed to store commit");
                self.refresh(ctx).await;
                reply(RefusalCode::Internal)
            }
        }
    }

    async fn init(
        &mut self,
        ctx: &Ctx<'_>,
        permission: Permission,
        req: u64,
        group_id: Vec<u8>,
        group_info: &[u8],
        keyring: &[u8],
    ) -> ServerMessage {
        if let Some(code) = write_only(permission) {
            return refuse(req, code);
        }
        if self.head.is_some() {
            return refuse(req, RefusalCode::GroupExists);
        }
        if !blobs_ok(ctx, group_info, keyring)
            || split_group_id(&group_id).is_none_or(|(_, incarnation)| incarnation != 0)
        {
            return refuse(req, RefusalCode::Malformed);
        }
        match mls::init_group(ctx.db, ctx.project_id, &group_id, group_info, keyring).await {
            Ok(true) => {
                self.head = Some(Head {
                    incarnation: 0,
                    epoch: 0,
                    group_id,
                });
                ServerMessage::Accepted { req }
            }
            Ok(false) => {
                self.refresh(ctx).await;
                refuse(req, RefusalCode::GroupExists)
            }
            Err(err) => {
                tracing::error!(project = %ctx.project_id, %err, "failed to create group");
                refuse(req, RefusalCode::Internal)
            }
        }
    }

    async fn reset(
        &mut self,
        ctx: &Ctx<'_>,
        conn: ConnId,
        permission: Permission,
        req: u64,
        (incarnation, group_id): (u64, Vec<u8>),
        (group_info, keyring): (&[u8], &[u8]),
    ) -> ServerMessage {
        if let Some(code) = write_only(permission) {
            return refuse(req, code);
        }
        let Some(head) = &self.head else {
            return refuse(req, RefusalCode::NoGroup);
        };
        // The new group is the same project one incarnation on. A group id
        // that says otherwise would make clients disagree about where they
        // are.
        let well_formed = incarnation
            .checked_add(1)
            .and_then(|next| u32::try_from(next).ok())
            .is_some_and(|next| {
                let old = split_group_id(&head.group_id);
                split_group_id(&group_id).is_some_and(|(project, got)| {
                    got == next && old.is_some_and(|(p, _)| p == project)
                })
            });
        if !blobs_ok(ctx, group_info, keyring) || !well_formed {
            return refuse(req, RefusalCode::Malformed);
        }
        match mls::reset_group(
            ctx.db,
            ctx.project_id,
            incarnation,
            &group_id,
            group_info,
            keyring,
        )
        .await
        {
            Ok(Reset::Done { incarnation }) => {
                self.head = Some(Head {
                    incarnation,
                    epoch: 0,
                    group_id,
                });
                self.broadcast(conn, &ServerMessage::Reinitialized { incarnation }, true);
                ServerMessage::Accepted { req }
            }
            Ok(Reset::WrongIncarnation) => {
                self.refresh(ctx).await;
                refuse(req, RefusalCode::WrongIncarnation)
            }
            Ok(Reset::NoGroup) => {
                self.head = None;
                refuse(req, RefusalCode::NoGroup)
            }
            Err(err) => {
                tracing::error!(project = %ctx.project_id, %err, "failed to reset group");
                self.refresh(ctx).await;
                refuse(req, RefusalCode::Internal)
            }
        }
    }
}

fn write_only(permission: Permission) -> Option<RefusalCode> {
    match permission {
        Permission::Write => None,
        Permission::Read => Some(RefusalCode::Forbidden),
        Permission::Retired => Some(RefusalCode::Retired),
    }
}

fn blobs_ok(ctx: &Ctx<'_>, group_info: &[u8], keyring: &[u8]) -> bool {
    let max = ctx.config.max_group_info_bytes;
    !group_info.is_empty() && !keyring.is_empty() && group_info.len() <= max && keyring.len() <= max
}

/// Queues the commits from `since` on, outside the live frame budget since
/// a long log would otherwise overflow a fresh connection. A retired
/// session gets them only up to the rotation that retired it. False if the
/// connection is gone or the log could not be read.
async fn backfill(
    ctx: &Ctx<'_>,
    outbox: &Outbox,
    incarnation: u64,
    since: u64,
    retired: Option<u64>,
) -> bool {
    let until = retired.unwrap_or(u64::MAX);
    let commits = match mls::commits_since(ctx.db, ctx.project_id, incarnation, since, until).await
    {
        Ok(commits) => commits,
        Err(err) => {
            tracing::error!(project = %ctx.project_id, %err, "failed to read commits");
            return false;
        }
    };
    // Starting a backfill while an earlier one is still queued counts as an
    // overflow and drops the socket, so a fetch with nothing to send (an up
    // to date client asking again) must not start one.
    if commits.is_empty() {
        return true;
    }
    let Some(queue) = outbox.start_backfill(ctx.project_id, BACKFILL_CRDT) else {
        return false;
    };
    commits.into_iter().all(|commit| {
        let msg = ServerMessage::Commit {
            epoch: commit.epoch,
            commit: commit.data,
            envelope: commit.envelope,
        };
        outbox.push_backfill(&queue, frame(&msg))
    })
}

async fn prune(ctx: &Ctx<'_>, incarnation: u64, head_epoch: u64) {
    let cutoff = projects::now_secs()
        .saturating_sub(i64::try_from(ctx.config.commit_retention.as_secs()).unwrap_or(i64::MAX));
    let limits = PruneLimits {
        older_than: cutoff,
        keep_last: ctx.config.keep_last_commits,
        max_bytes: ctx.config.max_log_bytes,
    };
    if let Err(err) =
        mls::prune_commits(ctx.db, ctx.project_id, incarnation, head_epoch, limits).await
    {
        tracing::warn!(project = %ctx.project_id, %err, "failed to prune commits");
    }
    // A retired token is only worth something while the rotation it reads
    // is still in the log.
    if let Err(err) = projects::expire_retired(ctx.db, ctx.project_id, cutoff).await {
        tracing::warn!(project = %ctx.project_id, %err, "failed to expire retired tokens");
    }
}
