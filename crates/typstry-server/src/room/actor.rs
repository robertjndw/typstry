use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Bytes;
use loro::VersionVector;
use loro_protocol::{BatchId, CrdtType, JoinErrorCode, ProtocolMessage, UpdateStatusCode};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};
use typstry_wire::ds::ClientMessage;
use typstry_wire::elo::{PeerId, Record, Version, encode_container, parse_container};

use super::elo::{self, DocIndex};
use super::mls::{Ctx, DsState, Rotation};
use super::registry::Inner;
use super::{
    CLOSE_LINK_ROTATED, CLOSE_LINK_ROTATED_REASON, ConnId, MAX_PRESENCE_BYTES, Outbound, Outbox,
    RoomCmd, update_frames,
};
use crate::store::docs::{self, Write};
use crate::store::projects::Permission;

/// A connection's latest presence. Each blob is that client's whole state,
/// encrypted, so the newest one replaces everything it sent before.
struct Presence {
    data: Bytes,
    at: Instant,
}

pub(super) struct RoomActor {
    project_id: String,
    generation: u64,
    registry: Arc<Inner>,
    index: DocIndex,
    /// The frames a client joining with an empty version gets, which is
    /// every fresh tab and every first sync. Encoding them means copying
    /// the whole doc, so they are kept until the doc changes. That doubles
    /// the room's memory while it is cached, so it is let go once the last
    /// peer leaves rather than kept for the whole unload delay.
    full_backfill: Option<Arc<[Bytes]>>,
    presence: HashMap<ConnId, Presence>,
    peers: HashMap<(ConnId, [u8; 4]), Outbox>,
    /// The token each doc or presence peer joined with.
    peer_tokens: HashMap<(ConnId, [u8; 4]), String>,
    /// Tokens retired while this room was loaded, with the epoch of their
    /// rotation. A join that resolved its token before the rotation must
    /// not slip in after it.
    retired_here: HashMap<String, u64>,
    /// Loaded on the first delivery service command.
    ds: Option<DsState>,
    last_seq: i64,
    empty_since: Option<Instant>,
}

impl RoomActor {
    pub(super) fn new(project_id: String, generation: u64, registry: Arc<Inner>) -> Self {
        Self {
            project_id,
            generation,
            registry,
            index: DocIndex::default(),
            full_backfill: None,
            presence: HashMap::new(),
            peers: HashMap::new(),
            peer_tokens: HashMap::new(),
            retired_here: HashMap::new(),
            ds: None,
            last_seq: 0,
            empty_since: Some(Instant::now()),
        }
    }

    pub(super) async fn run(mut self, mut rx: mpsc::Receiver<RoomCmd>) {
        if let Err(err) = self.load().await {
            tracing::error!(project = %self.project_id, %err, "failed to load room");
            self.registry.remove(&self.project_id, self.generation);
            return;
        }
        tracing::debug!(project = %self.project_id, seq = self.last_seq, "room loaded");

        let stop = self.registry.stop.clone();
        let mut tick = interval(self.registry.config.tick);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(cmd) => self.handle(cmd).await,
                    None => break,
                },
                _ = tick.tick() => {
                    if self.on_tick(&rx) {
                        break;
                    }
                }
                () = stop.cancelled() => {
                    // Server shutdown. Every record is written before its
                    // ack, so there is nothing to flush, but what was queued
                    // before the stop still gets handled.
                    rx.close();
                    while let Some(cmd) = rx.recv().await {
                        self.handle(cmd).await;
                    }
                    self.registry.remove(&self.project_id, self.generation);
                    break;
                }
            }
        }
        tracing::debug!(project = %self.project_id, "room unloaded");
    }

    async fn load(&mut self) -> anyhow::Result<()> {
        let records = docs::load(&self.registry.db, &self.project_id).await?;
        self.last_seq = records.last().map_or(0, |(seq, _)| *seq);
        self.index = DocIndex::load(records)?;
        Ok(())
    }

    /// Returns true when the room unloaded itself.
    fn on_tick(&mut self, rx: &mpsc::Receiver<RoomCmd>) -> bool {
        let config = &self.registry.config;
        self.presence
            .retain(|_, presence| presence.at.elapsed() < config.ephemeral_timeout);
        let idle_long_enough = self
            .empty_since
            .is_some_and(|since| since.elapsed() >= config.unload_after);
        // Nothing to flush first: every record was written before its ack.
        idle_long_enough
            && self
                .registry
                .remove_if_idle(&self.project_id, self.generation, rx)
    }

    async fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join {
                conn,
                crdt,
                permission,
                token,
                version,
                outbox,
                reply,
            } => {
                let joined = self.join(conn, crdt, permission, token, &version, outbox);
                let _ = reply.send(joined);
            }
            // Updates reach the room after the connection decided to send
            // them, so some come from peers the room has dropped since: ones
            // a rotation closed (their link is retired), ones that
            // overflowed, ones that left. Whoever is not a peer right now
            // has no standing to write or to be relayed.
            RoomCmd::Update { conn, crdt, .. }
                if !self.peers.contains_key(&(conn, crdt.magic_bytes())) => {}
            RoomCmd::Update {
                conn,
                crdt,
                batch_id,
                updates,
            } => match crdt {
                CrdtType::Elo => self.doc_update(conn, batch_id, updates).await,
                CrdtType::LoroEphemeralStore => self.presence_update(conn, batch_id, updates),
                _ => self.ack(conn, crdt, batch_id, UpdateStatusCode::Unknown),
            },
            RoomCmd::Leave { conn, crdt } => self.drop_peer(conn, crdt),
            RoomCmd::DsHello {
                conn,
                token,
                access,
                incarnation,
                since_epoch,
                outbox,
                reply,
            } => {
                let joined = if self.ensure_ds().await
                    && let Some(ds) = &mut self.ds
                {
                    let ctx = Ctx {
                        db: &self.registry.db,
                        project_id: &self.project_id,
                        config: &self.registry.config.ds,
                        retired_here: &self.retired_here,
                    };
                    let joined = ds
                        .hello(
                            &ctx,
                            conn,
                            token,
                            access,
                            (incarnation, since_epoch),
                            outbox,
                        )
                        .await;
                    // A refused hello sends no DsLeave later, so it must not
                    // keep the room loaded.
                    if joined {
                        self.empty_since = None;
                    }
                    joined
                } else {
                    false
                };
                let _ = reply.send(joined);
            }
            RoomCmd::DsMessage { conn, msg } => self.ds_message(conn, msg).await,
            RoomCmd::DsLeave { conn } => {
                if let Some(ds) = &mut self.ds {
                    ds.leave(conn);
                }
                self.note_idle();
            }
        }
    }

    /// Loads the group state on first use. False if the database failed.
    async fn ensure_ds(&mut self) -> bool {
        if self.ds.is_some() {
            return true;
        }
        match DsState::load(&self.registry.db, &self.project_id).await {
            Ok(ds) => {
                self.ds = Some(ds);
                true
            }
            Err(err) => {
                tracing::error!(project = %self.project_id, %err, "failed to load group");
                false
            }
        }
    }

    async fn ds_message(&mut self, conn: ConnId, msg: ClientMessage) {
        let Some(ds) = &mut self.ds else { return };
        let ctx = Ctx {
            db: &self.registry.db,
            project_id: &self.project_id,
            config: &self.registry.config.ds,
            retired_here: &self.retired_here,
        };
        let rotation = ds.message(&ctx, conn, msg).await;
        self.note_idle();
        if let Some(rotation) = rotation {
            self.apply_rotation(rotation);
        }
    }

    /// Closes the doc and presence connections that joined with a retired
    /// token and remembers the tokens as retired. The delivery service
    /// sessions were already told by the DS state, and stay open to read.
    fn apply_rotation(&mut self, rotation: Rotation) {
        let stale: Vec<(ConnId, [u8; 4])> = self
            .peer_tokens
            .iter()
            .filter(|&(_, token)| rotation.tokens.contains(token))
            .map(|(&key, _)| key)
            .collect();
        for token in rotation.tokens {
            self.retired_here.insert(token, rotation.epoch);
        }
        for key in stale {
            if let Some(outbox) = self.peers.get(&key) {
                outbox.push(Outbound::Close(
                    CLOSE_LINK_ROTATED,
                    CLOSE_LINK_ROTATED_REASON,
                ));
            }
            self.peers.remove(&key);
            self.peer_tokens.remove(&key);
            self.presence.remove(&key.0);
        }
        self.note_idle();
    }

    fn note_idle(&mut self) {
        let ds_empty = self.ds.as_ref().is_none_or(DsState::is_empty);
        if self.peers.is_empty() {
            self.full_backfill = None;
        }
        if self.peers.is_empty() && ds_empty && self.empty_since.is_none() {
            self.empty_since = Some(Instant::now());
        }
    }

    fn join(
        &mut self,
        conn: ConnId,
        crdt: CrdtType,
        permission: Permission,
        token: String,
        version: &[u8],
        outbox: Outbox,
    ) -> bool {
        if self.retired_here.contains_key(&token) {
            outbox.push_message(&ProtocolMessage::JoinError {
                crdt,
                room_id: self.project_id.clone(),
                code: JoinErrorCode::AuthFailed,
                message: "auth_failed".into(),
                receiver_version: None,
                app_code: None,
            });
            return false;
        }
        // Checked before the backfill is built, which for most versions
        // means copying the doc.
        let Some(backfill) = outbox.start_backfill(&self.project_id, crdt) else {
            return false;
        };
        let (server_version, extra, frames): (_, _, Arc<[Bytes]>) = match crdt {
            CrdtType::Elo => {
                let client = if version.is_empty() {
                    Version::new()
                } else {
                    match VersionVector::decode(version) {
                        Ok(vv) => elo::from_vv(&vv),
                        Err(_) => {
                            // The JS client answers VersionUnknown by retrying
                            // with an empty version, which gets everything.
                            outbox.push_message(&ProtocolMessage::JoinError {
                                crdt,
                                room_id: self.project_id.clone(),
                                code: JoinErrorCode::VersionUnknown,
                                message: "cannot decode version vector".into(),
                                receiver_version: None,
                                app_code: None,
                            });
                            return false;
                        }
                    }
                };
                // The client compacts by uploading a snapshot once the delta
                // count gets high; it cannot see the log any other way.
                let extra = format!("{{\"deltas\":{}}}", self.index.delta_count());
                (
                    self.index.coverage_vv().encode(),
                    Some(extra.into_bytes()),
                    self.backfill_frames(&client),
                )
            }
            CrdtType::LoroEphemeralStore => {
                let others = self
                    .presence
                    .iter()
                    .filter(|&(&other, _)| other != conn)
                    .flat_map(|(_, presence)| {
                        update_frames(crdt, &self.project_id, presence.data.to_vec())
                    })
                    .collect();
                (Vec::new(), None, others)
            }
            _ => unreachable!("connection only forwards supported CRDT types"),
        };

        let ok = ProtocolMessage::JoinResponseOk {
            crdt,
            room_id: self.project_id.clone(),
            permission: match permission {
                Permission::Write => loro_protocol::Permission::Write,
                Permission::Read => loro_protocol::Permission::Read,
            },
            version: server_version,
            extra,
        };
        if !outbox.push_message(&ok) {
            return false;
        }
        for frame in frames.iter() {
            if !outbox.push_backfill(&backfill, frame.clone()) {
                return false;
            }
        }
        self.peers.insert((conn, crdt.magic_bytes()), outbox);
        self.peer_tokens.insert((conn, crdt.magic_bytes()), token);
        self.empty_since = None;
        true
    }

    fn backfill_frames(&mut self, client: &Version) -> Arc<[Bytes]> {
        let full = client.is_empty();
        if full && let Some(frames) = &self.full_backfill {
            return frames.clone();
        }
        let frames: Arc<[Bytes]> = elo::pack(&self.index.backfill(client))
            .into_iter()
            .flat_map(|container| update_frames(CrdtType::Elo, &self.project_id, container))
            .collect();
        if full {
            self.full_backfill = Some(frames.clone());
        }
        frames
    }

    /// Stores a whole update message in one transaction. Every record is
    /// first judged against the index with the batch's earlier records
    /// staged in it, so duplicates within the batch are dropped too; the
    /// staging is undone if the write fails.
    async fn doc_update(&mut self, conn: ConnId, batch_id: BatchId, updates: Vec<Bytes>) {
        let mut status = UpdateStatusCode::Ok;
        let mut writes = Vec::new();
        let mut relays = Vec::new();
        self.index.begin();
        for update in updates {
            let records = match parse_container(&update) {
                Ok(records) => records,
                Err(err) => {
                    // Earlier payloads of the message were fine and are kept.
                    tracing::debug!(project = %self.project_id, %err, "rejected update");
                    status = UpdateStatusCode::InvalidUpdate;
                    break;
                }
            };
            // Only spans this payload added are relayed: duplicates are
            // already known to everyone who could have them, and snapshots
            // only exist to compact the log, peers already hold their ops.
            let count = records.len();
            let share = shares_buffer(&self.index, &records);
            let mut fresh = Vec::new();
            for (record, bytes) in records {
                let bytes = if share {
                    update.slice_ref(bytes)
                } else {
                    Bytes::copy_from_slice(bytes)
                };
                match record {
                    Record::Delta { peer, start, end } => {
                        if self.stage_delta(peer, start, end, &bytes, &mut writes) {
                            fresh.push(bytes);
                        }
                    }
                    Record::Snapshot { vv } => self.stage_snapshot(vv, bytes, &mut writes),
                }
            }
            if fresh.len() == count {
                relays.push(Vec::from(update));
            } else if !fresh.is_empty() {
                let fresh: Vec<&[u8]> = fresh.iter().map(|bytes| &bytes[..]).collect();
                relays.push(encode_container(&fresh));
            }
        }

        if writes.is_empty() {
            self.index.commit();
        } else {
            match docs::write_batch(&self.registry.db, &self.project_id, &writes).await {
                Ok(()) => {
                    self.index.commit();
                    self.full_backfill = None;
                }
                Err(err) => {
                    tracing::error!(project = %self.project_id, %err, "failed to store records");
                    self.index.rollback();
                    status = UpdateStatusCode::Unknown;
                    relays.clear();
                }
            }
        }

        self.ack(conn, CrdtType::Elo, batch_id, status);
        for relay in relays {
            self.broadcast(conn, CrdtType::Elo, relay);
        }
    }

    /// Returns whether the span was new and is staged for storing.
    fn stage_delta(
        &mut self,
        peer: PeerId,
        start: u64,
        end: u64,
        bytes: &Bytes,
        writes: &mut Vec<Write>,
    ) -> bool {
        if self.index.covers(peer, end) {
            return false;
        }
        // Never handed out twice, even if this batch fails to commit: a
        // failure may still have reached the disk, and reusing its seq would
        // then collide.
        self.last_seq += 1;
        writes.push(Write::Append {
            seq: self.last_seq,
            data: bytes.clone(),
        });
        self.index
            .add_delta(self.last_seq, peer, start, end, bytes.clone());
        true
    }

    /// A snapshot that would not let anything go is dropped without a word:
    /// the client cannot do anything better with a rejection, and its ops
    /// are already stored as deltas.
    fn stage_snapshot(&mut self, vv: Version, bytes: Bytes, writes: &mut Vec<Write>) {
        let Some(obsolete) = self.index.snapshot_replaces(&vv) else {
            return;
        };
        self.last_seq += 1;
        tracing::debug!(
            project = %self.project_id,
            seq = self.last_seq,
            replaced = obsolete.len(),
            bytes = bytes.len(),
            "compacting"
        );
        writes.push(Write::Snapshot {
            seq: self.last_seq,
            data: bytes.clone(),
            obsolete,
        });
        self.index.install_snapshot(self.last_seq, vv, bytes);
    }

    fn presence_update(&mut self, conn: ConnId, batch_id: BatchId, updates: Vec<Bytes>) {
        let crdt = CrdtType::LoroEphemeralStore;
        let blobs: Vec<Bytes> = updates
            .into_iter()
            .filter(|blob| !blob.is_empty())
            .collect();
        if blobs.iter().any(|blob| blob.len() > MAX_PRESENCE_BYTES) {
            self.ack(conn, crdt, batch_id, UpdateStatusCode::InvalidUpdate);
            return;
        }
        // A peer dropped for overflowing its outbox may still have updates
        // queued; keeping its blob would replay a ghost to later joiners.
        if let Some(last) = blobs.last()
            && self.peers.contains_key(&(conn, crdt.magic_bytes()))
        {
            self.presence.insert(
                conn,
                Presence {
                    data: last.clone(),
                    at: Instant::now(),
                },
            );
        }
        self.ack(conn, crdt, batch_id, UpdateStatusCode::Ok);
        for blob in blobs {
            self.broadcast(conn, crdt, Vec::from(blob));
        }
    }

    fn ack(&mut self, conn: ConnId, crdt: CrdtType, ref_id: BatchId, status: UpdateStatusCode) {
        let msg = ProtocolMessage::Ack {
            crdt,
            room_id: self.project_id.clone(),
            ref_id,
            status,
        };
        let Some(outbox) = self.peers.get(&(conn, crdt.magic_bytes())) else {
            return;
        };
        if !outbox.push_message(&msg) {
            self.drop_peer(conn, crdt);
        }
    }

    /// Relays an accepted update to every other peer of the same CRDT.
    fn broadcast(&mut self, from: ConnId, crdt: CrdtType, update: Vec<u8>) {
        let magic = crdt.magic_bytes();
        let frames = update_frames(crdt, &self.project_id, update);
        let mut dead = Vec::new();
        for (&(conn, peer_magic), outbox) in &self.peers {
            if conn == from || peer_magic != magic {
                continue;
            }
            if !frames
                .iter()
                .all(|frame| outbox.push(Outbound::Binary(frame.clone())))
            {
                dead.push(conn);
            }
        }
        for conn in dead {
            self.drop_peer(conn, crdt);
        }
    }

    fn drop_peer(&mut self, conn: ConnId, crdt: CrdtType) {
        self.peers.remove(&(conn, crdt.magic_bytes()));
        self.peer_tokens.remove(&(conn, crdt.magic_bytes()));
        if crdt == CrdtType::LoroEphemeralStore {
            self.presence.remove(&conn);
        }
        self.note_idle();
    }
}

/// Whether a payload's stored records may be slices of its buffer rather
/// than copies. Stored records live as long as the room, and a slice keeps
/// the whole buffer (up to 8 MiB reassembled) alive with it, so that only
/// pays off when every record is kept. A guess from the index is enough: a
/// wrong one costs a copy or some memory, not correctness. A snapshot may
/// be refused, so only one that is the whole payload is worth sharing.
fn shares_buffer(index: &DocIndex, records: &[(Record, &[u8])]) -> bool {
    records.iter().all(|(record, _)| match *record {
        Record::Delta { peer, end, .. } => !index.covers(peer, end),
        Record::Snapshot { .. } => records.len() == 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_the_buffer_only_when_every_record_is_kept() {
        let mut index = DocIndex::default();
        index.add_delta(1, 1, 0, 5, Bytes::from_static(b"old"));
        let delta = |peer, start, end| Record::Delta { peer, start, end };
        let snapshot = || Record::Snapshot { vv: Version::new() };

        assert!(shares_buffer(&index, &[(delta(1, 5, 6), b"")]));
        assert!(shares_buffer(
            &index,
            &[(delta(1, 5, 6), b""), (delta(2, 0, 1), b"")]
        ));
        assert!(shares_buffer(&index, &[(snapshot(), b"")]));

        assert!(!shares_buffer(
            &index,
            &[(delta(1, 0, 5), b""), (delta(2, 0, 1), b"")]
        ));
        assert!(!shares_buffer(
            &index,
            &[(snapshot(), b""), (delta(2, 0, 1), b"")]
        ));
    }
}
