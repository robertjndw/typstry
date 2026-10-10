use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Bytes;
use loro::VersionVector;
use loro_protocol::{BatchId, CrdtType, JoinErrorCode, ProtocolMessage, UpdateStatusCode};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};
use typstry_wire::elo::encode_container;
use typstry_wire::fragment::encode_update;

use super::elo::{self, DocIndex, PeerId, Record, Version};
use super::registry::Inner;
use super::{ConnId, MAX_PRESENCE_BYTES, Outbound, Outbox, RoomCmd};
use crate::store::docs;
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
    presence: HashMap<ConnId, Presence>,
    peers: HashMap<(ConnId, [u8; 4]), Outbox>,
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
            presence: HashMap::new(),
            peers: HashMap::new(),
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

        let mut tick = interval(self.registry.config.tick);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(RoomCmd::Shutdown { done }) => {
                        self.registry.remove(&self.project_id, self.generation);
                        let _ = done.send(());
                        break;
                    }
                    Some(cmd) => self.handle(cmd).await,
                    None => break,
                },
                _ = tick.tick() => {
                    if self.on_tick(&rx) {
                        break;
                    }
                }
            }
        }
        tracing::debug!(project = %self.project_id, "room unloaded");
    }

    async fn load(&mut self) -> anyhow::Result<()> {
        let records = docs::load(&self.registry.db, &self.project_id).await?;
        self.last_seq = records.last().map_or(0, |(seq, _)| *seq);
        self.index = DocIndex::load(records).map_err(anyhow::Error::msg)?;
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
                version,
                outbox,
                reply,
            } => {
                let joined = self.join(conn, crdt, permission, &version, outbox);
                let _ = reply.send(joined);
            }
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
            RoomCmd::Shutdown { .. } => unreachable!("handled in run"),
        }
    }

    fn join(
        &mut self,
        conn: ConnId,
        crdt: CrdtType,
        permission: Permission,
        version: &[u8],
        outbox: Outbox,
    ) -> bool {
        let (server_version, extra, backfill): (_, _, Vec<Bytes>) = match crdt {
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
                    elo::pack(&self.index.backfill(&client))
                        .into_iter()
                        .map(Bytes::from)
                        .collect(),
                )
            }
            CrdtType::LoroEphemeralStore => {
                let others = self
                    .presence
                    .iter()
                    .filter(|&(&other, _)| other != conn)
                    .map(|(_, presence)| presence.data.clone())
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
        for data in backfill {
            for frame in encode_update(crdt, &self.project_id, &data) {
                if !outbox.push(Outbound::Binary(frame.into())) {
                    return false;
                }
            }
        }
        self.peers.insert((conn, crdt.magic_bytes()), outbox);
        self.empty_since = None;
        true
    }

    async fn doc_update(&mut self, conn: ConnId, batch_id: BatchId, updates: Vec<Vec<u8>>) {
        let mut status = UpdateStatusCode::Ok;
        let mut relays = Vec::new();
        for update in &updates {
            let records = match elo::parse_container(update) {
                Ok(records) => records,
                Err(err) => {
                    tracing::debug!(project = %self.project_id, %err, "rejected update");
                    status = UpdateStatusCode::InvalidUpdate;
                    break;
                }
            };
            // Only spans this payload added are relayed: duplicates are
            // already known to everyone who could have them, and snapshots
            // only exist to compact the log, peers already hold their ops.
            let mut fresh: Vec<&[u8]> = Vec::new();
            let mut failed = false;
            for (record, bytes) in records {
                let stored = match record {
                    Record::Delta { peer, start, end } => {
                        self.store_delta(peer, start, end, bytes).await
                    }
                    Record::Snapshot { vv } => self.store_snapshot(vv, bytes).await.map(|()| false),
                };
                match stored {
                    Ok(true) => fresh.push(bytes),
                    Ok(false) => {}
                    Err(err) => {
                        tracing::error!(project = %self.project_id, %err, "failed to store record");
                        status = UpdateStatusCode::Unknown;
                        failed = true;
                        break;
                    }
                }
            }
            // What was stored before a failure still goes out: it is durable,
            // and peers would otherwise only see it on their next rejoin.
            if !fresh.is_empty() {
                relays.push(encode_container(&fresh));
            }
            if failed {
                break;
            }
        }

        self.ack(conn, CrdtType::Elo, batch_id, status);
        for relay in &relays {
            self.broadcast(conn, CrdtType::Elo, relay);
        }
    }

    /// Returns whether the span was new and got stored.
    async fn store_delta(
        &mut self,
        peer: PeerId,
        start: u64,
        end: u64,
        bytes: &[u8],
    ) -> sqlx::Result<bool> {
        if self.index.covers(peer, end) {
            return Ok(false);
        }
        // Bumped even if the write fails: a failure may still have reached
        // the disk, and reusing its seq would then collide.
        self.last_seq += 1;
        docs::append(&self.registry.db, &self.project_id, self.last_seq, bytes).await?;
        self.index
            .add_delta(self.last_seq, peer, start, end, bytes.to_vec());
        Ok(true)
    }

    /// A snapshot that would not let anything go is dropped without a word:
    /// the client cannot do anything better with a rejection, and its ops
    /// are already stored as deltas.
    async fn store_snapshot(&mut self, vv: Version, bytes: &[u8]) -> sqlx::Result<()> {
        let Some(obsolete) = self.index.snapshot_replaces(&vv) else {
            return Ok(());
        };
        self.last_seq += 1;
        docs::replace_with_snapshot(
            &self.registry.db,
            &self.project_id,
            self.last_seq,
            bytes,
            &obsolete,
        )
        .await?;
        self.index
            .install_snapshot(self.last_seq, vv, bytes.to_vec());
        tracing::debug!(
            project = %self.project_id,
            seq = self.last_seq,
            replaced = obsolete.len(),
            bytes = bytes.len(),
            "compacted"
        );
        Ok(())
    }

    fn presence_update(&mut self, conn: ConnId, batch_id: BatchId, updates: Vec<Vec<u8>>) {
        let crdt = CrdtType::LoroEphemeralStore;
        let blobs: Vec<Bytes> = updates
            .into_iter()
            .filter(|blob| !blob.is_empty())
            .map(Bytes::from)
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
        for blob in &blobs {
            self.broadcast(conn, crdt, blob);
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
    fn broadcast(&mut self, from: ConnId, crdt: CrdtType, update: &[u8]) {
        let magic = crdt.magic_bytes();
        let frames: Vec<Bytes> = encode_update(crdt, &self.project_id, update)
            .into_iter()
            .map(Bytes::from)
            .collect();
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
        if crdt == CrdtType::LoroEphemeralStore {
            self.presence.remove(&conn);
        }
        if self.peers.is_empty() {
            self.empty_since = Some(Instant::now());
        }
    }
}
