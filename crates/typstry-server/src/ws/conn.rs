//! One WebSocket connection speaking Loro Protocol v1.
//!
//! A connection can join several rooms; for typstry that is `%ELO` (the
//! encrypted doc) and `%EPH` (encrypted presence) of the same space.
//! Room ids are space ids and the join auth is the share token as UTF-8.

use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::WebSocket;
use loro_protocol::{
    BatchId, CrdtType, JoinErrorCode, ProtocolMessage, UpdateStatusCode, try_decode,
};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};
use typstry_wire::elo::container_len;
use typstry_wire::fragment::Reassembler;

use super::rate::TokenBucket;
use super::{CLOSE_PROTOCOL_ERROR, IDLE_TIMEOUT, Socket};
use crate::room::{ConnId, JoinOutcome, MAX_PRESENCE_BYTES, Outbound, Outbox, RoomCmd};
use crate::state::AppState;
use crate::store::spaces::{self, Permission};

/// Frames buffered per connection before the client counts as too slow.
/// Only small frames ever reach this many; big ones hit the byte budget in
/// [`super::ConnLimits::outbox_bytes`] first.
const OUTBOX_FRAMES: usize = 512;

struct Joined {
    crdt: CrdtType,
    room_id: String,
    room: mpsc::Sender<RoomCmd>,
    permission: Permission,
}

struct Conn {
    id: ConnId,
    state: AppState,
    outbox: Outbox,
    /// A handful at most (`max_rooms`), so a scan beats hashing an owned key
    /// for every update.
    joined: Vec<Joined>,
    fragments: Reassembler,
    doc_updates: TokenBucket,
    presence_updates: TokenBucket,
}

pub async fn run(socket: WebSocket, state: AppState) {
    let id = state.rooms.next_conn_id();
    let (mut socket, outbox) = Socket::open(socket, &state, OUTBOX_FRAMES);

    let limits = &state.limits;
    let bucket = TokenBucket::new(limits.update_burst, limits.updates_per_sec, Instant::now());
    let mut conn = Conn {
        id,
        doc_updates: bucket.clone(),
        presence_updates: bucket,
        state,
        outbox,
        joined: Vec::new(),
        fragments: Reassembler::default(),
    };

    let mut sweep = interval(Duration::from_secs(1));
    sweep.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            next = socket.next(IDLE_TIMEOUT) => match next {
                Some(bytes) => {
                    if !conn.on_binary(&bytes).await {
                        break;
                    }
                }
                None => break,
            },
            _ = sweep.tick() => conn.expire_fragments(),
        }
    }

    conn.leave_all().await;
    drop(conn);
    socket.finish().await;
    tracing::debug!(conn = id, "connection closed");
}

impl Conn {
    /// Returns false when the connection should close.
    async fn on_binary(&mut self, bytes: &[u8]) -> bool {
        match try_decode(bytes) {
            Some(msg) => {
                self.on_protocol(msg).await;
                true
            }
            None => {
                self.close(CLOSE_PROTOCOL_ERROR, "Protocol error");
                false
            }
        }
    }

    async fn on_protocol(&mut self, msg: ProtocolMessage) {
        match msg {
            ProtocolMessage::JoinRequest {
                crdt,
                room_id,
                auth,
                version,
            } => self.join(crdt, room_id, auth, version).await,
            ProtocolMessage::DocUpdate {
                crdt,
                room_id,
                updates,
                batch_id,
            } => self.update(crdt, room_id, batch_id, updates).await,
            ProtocolMessage::DocUpdateFragmentHeader {
                crdt,
                room_id,
                batch_id,
                fragment_count,
                total_size_bytes,
            } => {
                if let Err(status) = self.writable(crdt, &room_id) {
                    self.ack(crdt, &room_id, batch_id, status);
                    return;
                }
                // The actor refuses oversized presence anyway; this keeps a
                // client from making us buffer megabytes of it first.
                if crdt == CrdtType::LoroEphemeralStore
                    && total_size_bytes > MAX_PRESENCE_BYTES as u64
                {
                    self.ack(crdt, &room_id, batch_id, UpdateStatusCode::PayloadTooLarge);
                    return;
                }
                if let Err(status) =
                    self.fragments
                        .start(crdt, &room_id, batch_id, fragment_count, total_size_bytes)
                {
                    self.ack(crdt, &room_id, batch_id, status);
                }
            }
            ProtocolMessage::DocUpdateFragment {
                crdt,
                room_id,
                batch_id,
                index,
                fragment,
            } => match self
                .fragments
                .push(crdt, &room_id, batch_id, index, fragment)
            {
                Ok(Some(update)) => self.update(crdt, room_id, batch_id, vec![update]).await,
                Ok(None) => {}
                Err(status) => self.ack(crdt, &room_id, batch_id, status),
            },
            ProtocolMessage::Leave { crdt, room_id } => {
                if let Some(i) = self.find(crdt, &room_id) {
                    let joined = self.joined.swap_remove(i);
                    leave(&joined.room, self.id, crdt).await;
                }
            }
            ProtocolMessage::Ack {
                status, room_id, ..
            } => {
                if status != UpdateStatusCode::Ok {
                    tracing::warn!(conn = self.id, room = %room_id, ?status, "client rejected an update");
                }
            }
            // Server-to-client messages; a client has no business sending them.
            ProtocolMessage::JoinResponseOk { .. }
            | ProtocolMessage::JoinError { .. }
            | ProtocolMessage::RoomError { .. } => {}
        }
    }

    async fn join(&mut self, crdt: CrdtType, room_id: String, auth: Vec<u8>, version: Vec<u8>) {
        if !matches!(crdt, CrdtType::Elo | CrdtType::LoroEphemeralStore) {
            self.join_error(
                crdt,
                &room_id,
                JoinErrorCode::Unknown,
                "unsupported crdt type",
            );
            return;
        }
        let token = std::str::from_utf8(&auth).unwrap_or_default();
        let resolved = spaces::resolve_token(&self.state.db, token).await;
        let permission = match resolved {
            Ok(Some((space_id, permission))) if space_id == room_id => permission,
            Ok(_) => {
                // Unknown rooms and wrong tokens look the same on purpose.
                self.join_error(crdt, &room_id, JoinErrorCode::AuthFailed, "auth_failed");
                return;
            }
            Err(err) => {
                tracing::error!(%err, "token lookup failed");
                self.join_error(crdt, &room_id, JoinErrorCode::Unknown, "internal error");
                return;
            }
        };

        // A repeated join (the client's rejoin path) replaces the old one.
        let existing = self.find(crdt, &room_id);
        if existing.is_none() && self.joined.len() >= self.state.limits.max_rooms {
            self.join_error(crdt, &room_id, JoinErrorCode::AppError, "too many rooms");
            return;
        }
        if let Some(i) = existing {
            let old = self.joined.swap_remove(i);
            leave(&old.room, self.id, crdt).await;
        }

        let outcome = self
            .state
            .rooms
            .join(&room_id, |reply| RoomCmd::Join {
                conn: self.id,
                crdt,
                permission,
                token: token.to_owned(),
                version: version.clone(),
                outbox: self.outbox.clone(),
                reply,
            })
            .await;
        match outcome {
            JoinOutcome::Joined(room) => {
                self.joined.push(Joined {
                    crdt,
                    room_id,
                    room,
                    permission,
                });
            }
            JoinOutcome::Refused => {}
            JoinOutcome::Unavailable => {
                self.join_error(crdt, &room_id, JoinErrorCode::Unknown, "room unavailable");
            }
        }
    }

    fn find(&self, crdt: CrdtType, room_id: &str) -> Option<usize> {
        self.joined
            .iter()
            .position(|joined| joined.crdt == crdt && joined.room_id == room_id)
    }

    fn writable(&self, crdt: CrdtType, room_id: &str) -> Result<&Joined, UpdateStatusCode> {
        let joined = self
            .find(crdt, room_id)
            .map(|i| &self.joined[i])
            .ok_or(UpdateStatusCode::PermissionDenied)?;
        // Viewers may still publish presence so others can see where they
        // are looking; only the document itself is write-protected.
        if crdt == CrdtType::Elo && joined.permission != Permission::Write {
            return Err(UpdateStatusCode::PermissionDenied);
        }
        Ok(joined)
    }

    async fn update(
        &mut self,
        crdt: CrdtType,
        room_id: String,
        batch_id: BatchId,
        updates: Vec<Vec<u8>>,
    ) {
        let room = match self.writable(crdt, &room_id) {
            Ok(joined) => joined.room.clone(),
            Err(status) => {
                self.ack(crdt, &room_id, batch_id, status);
                return;
            }
        };
        // Refused with an ack rather than a disconnect. The edit stays in
        // the client's doc and reaches the server on the next rejoin, which
        // sends every span the server's coverage lacks.
        //
        // Charged per record rather than per message: one message can carry
        // thousands of tiny records, and each is a row to store and index.
        // The count comes from the container's header, so this does not
        // decode what the room parses anyway. An undecodable payload costs
        // one; the room rejects it.
        let (bucket, cost) = match crdt {
            CrdtType::Elo => {
                let records: u64 = updates
                    .iter()
                    .map(|update| container_len(update).unwrap_or(1))
                    .sum();
                (&mut self.doc_updates, records)
            }
            _ => (&mut self.presence_updates, updates.len() as u64),
        };
        let cost = u32::try_from(cost.max(1)).unwrap_or(u32::MAX);
        if !bucket.try_take(Instant::now(), cost) {
            tracing::debug!(conn = self.id, room = %room_id, "update rate limited");
            self.ack(crdt, &room_id, batch_id, UpdateStatusCode::RateLimited);
            return;
        }
        let cmd = RoomCmd::Update {
            conn: self.id,
            crdt,
            batch_id,
            updates: updates.into_iter().map(Bytes::from).collect(),
        };
        if room.send(cmd).await.is_err() {
            if let Some(i) = self.find(crdt, &room_id) {
                self.joined.swap_remove(i);
            }
            self.ack(crdt, &room_id, batch_id, UpdateStatusCode::Unknown);
        }
    }

    fn expire_fragments(&mut self) {
        for (crdt, room_id, batch_id) in self.fragments.expire(Instant::now()) {
            self.ack(crdt, &room_id, batch_id, UpdateStatusCode::FragmentTimeout);
        }
    }

    async fn leave_all(&mut self) {
        for joined in std::mem::take(&mut self.joined) {
            leave(&joined.room, self.id, joined.crdt).await;
        }
    }

    fn ack(&self, crdt: CrdtType, room_id: &str, ref_id: BatchId, status: UpdateStatusCode) {
        self.send(&ProtocolMessage::Ack {
            crdt,
            room_id: room_id.to_owned(),
            ref_id,
            status,
        });
    }

    fn join_error(&self, crdt: CrdtType, room_id: &str, code: JoinErrorCode, message: &str) {
        self.send(&ProtocolMessage::JoinError {
            crdt,
            room_id: room_id.to_owned(),
            code,
            message: message.to_owned(),
            receiver_version: None,
            app_code: None,
        });
    }

    fn send(&self, msg: &ProtocolMessage) {
        self.outbox.push_message(msg);
    }

    fn close(&self, code: u16, reason: &'static str) {
        self.outbox.push(Outbound::Close(code, reason));
    }
}

/// A gone room has already dropped the peer, so a failed send needs nothing.
async fn leave(room: &mpsc::Sender<RoomCmd>, conn: ConnId, crdt: CrdtType) {
    let _ = room.send(RoomCmd::Leave { conn, crdt }).await;
}
