//! One WebSocket connection speaking Loro Protocol v1.
//!
//! A connection can join several rooms; for typstry that is `%ELO` (the
//! encrypted doc) and `%EPH` (encrypted presence) of the same project.
//! Room ids are project ids and the join auth is the share token as UTF-8.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use futures_util::{SinkExt, StreamExt};
use loro_protocol::{
    BatchId, CrdtType, JoinErrorCode, ProtocolMessage, UpdateStatusCode, try_decode,
};
use tokio::sync::{Notify, mpsc};
use tokio::time::{MissedTickBehavior, interval, timeout};
use typstry_wire::fragment::Reassembler;

use super::rate::TokenBucket;
use crate::http::AppState;
use crate::room::{ConnId, JoinOutcome, Outbound, Outbox, RoomCmd};
use crate::store::projects::{self, Permission};

/// Frames buffered per connection before the client counts as too slow.
const OUTBOX_CAPACITY: usize = 1024;

/// The JS client pings every 30 s, so silence this long means a dead peer.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Neither code is in the JS client's fatal list (1008, 1011, 4400-4499), so
/// it reconnects and resyncs after either.
const CLOSE_PROTOCOL_ERROR: u16 = 1002;
const CLOSE_GOING_AWAY: u16 = 1001;

struct Joined {
    room: mpsc::Sender<RoomCmd>,
    permission: Permission,
}

struct Conn {
    id: ConnId,
    state: AppState,
    outbox: Outbox,
    joined: HashMap<([u8; 4], String), Joined>,
    fragments: Reassembler,
    doc_updates: TokenBucket,
    presence_updates: TokenBucket,
}

pub async fn run(socket: WebSocket, state: AppState) {
    let id = state.rooms.next_conn_id();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Outbound>(OUTBOX_CAPACITY);
    let overflow = Arc::new(Notify::new());

    let mut writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let (msg, last) = match frame {
                Outbound::Binary(bytes) => (Message::Binary(bytes), false),
                Outbound::Text(text) => (Message::Text(Utf8Bytes::from_static(text)), false),
                Outbound::Close(code, reason) => (
                    Message::Close(Some(CloseFrame {
                        code,
                        reason: Utf8Bytes::from_static(reason),
                    })),
                    true,
                ),
            };
            if sink.send(msg).await.is_err() || last {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let limits = &state.limits;
    let bucket = TokenBucket::new(limits.update_burst, limits.updates_per_sec, Instant::now());
    let mut conn = Conn {
        id,
        doc_updates: bucket.clone(),
        presence_updates: bucket,
        state,
        outbox: Outbox {
            tx,
            overflow: overflow.clone(),
        },
        joined: HashMap::new(),
        fragments: Reassembler::default(),
    };

    let mut sweep = interval(Duration::from_secs(1));
    sweep.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut overflowed = false;
    loop {
        tokio::select! {
            next = timeout(IDLE_TIMEOUT, stream.next()) => match next {
                Ok(Some(Ok(msg))) => {
                    if !conn.on_message(msg).await {
                        break;
                    }
                }
                Ok(Some(Err(_)) | None) => break,
                Err(_) => {
                    conn.close(CLOSE_GOING_AWAY, "idle_timeout");
                    break;
                }
            },
            () = overflow.notified() => {
                overflowed = true;
                break;
            }
            _ = sweep.tick() => conn.expire_fragments(),
        }
    }

    conn.leave_all().await;
    drop(conn);
    if overflowed {
        // The queue is full, so a close frame cannot be queued; dropping the
        // socket is the only way to make the client reconnect promptly.
        writer.abort();
    } else if timeout(Duration::from_secs(2), &mut writer).await.is_err() {
        writer.abort();
    }
    tracing::debug!(conn = id, "connection closed");
}

impl Conn {
    /// Returns false when the connection should close.
    async fn on_message(&mut self, msg: Message) -> bool {
        match msg {
            Message::Text(text) => {
                if text.as_str() == "ping" {
                    self.outbox.push(Outbound::Text("pong"));
                }
                true
            }
            Message::Binary(bytes) => match try_decode(&bytes) {
                Some(msg) => {
                    self.on_protocol(msg).await;
                    true
                }
                None => {
                    self.close(CLOSE_PROTOCOL_ERROR, "Protocol error");
                    false
                }
            },
            Message::Close(_) => false,
            Message::Ping(_) | Message::Pong(_) => true,
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
                if let Some(joined) = self.joined.remove(&(crdt.magic_bytes(), room_id)) {
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
        let resolved = match std::str::from_utf8(&auth) {
            Ok(token) => projects::resolve_token(&self.state.db, token).await,
            Err(_) => Ok(None),
        };
        let permission = match resolved {
            Ok(Some((project_id, permission))) if project_id == room_id => permission,
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
        let key = (crdt.magic_bytes(), room_id.clone());
        if !self.joined.contains_key(&key) && self.joined.len() >= self.state.limits.max_rooms {
            self.join_error(crdt, &room_id, JoinErrorCode::AppError, "too many rooms");
            return;
        }
        if let Some(old) = self.joined.remove(&key) {
            leave(&old.room, self.id, crdt).await;
        }

        let outcome = self
            .state
            .rooms
            .join(&room_id, |reply| RoomCmd::Join {
                conn: self.id,
                crdt,
                permission,
                version: version.clone(),
                outbox: self.outbox.clone(),
                reply,
            })
            .await;
        match outcome {
            JoinOutcome::Joined(room) => {
                self.joined.insert(key, Joined { room, permission });
            }
            JoinOutcome::Refused => {}
            JoinOutcome::Unavailable => {
                self.join_error(crdt, &room_id, JoinErrorCode::Unknown, "room unavailable");
            }
        }
    }

    fn writable(&self, crdt: CrdtType, room_id: &str) -> Result<&Joined, UpdateStatusCode> {
        let joined = self
            .joined
            .get(&(crdt.magic_bytes(), room_id.to_owned()))
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
        let bucket = match crdt {
            CrdtType::Elo => &mut self.doc_updates,
            _ => &mut self.presence_updates,
        };
        if !bucket.try_take(Instant::now()) {
            tracing::debug!(conn = self.id, room = %room_id, "update rate limited");
            self.ack(crdt, &room_id, batch_id, UpdateStatusCode::RateLimited);
            return;
        }
        let cmd = RoomCmd::Update {
            conn: self.id,
            crdt,
            batch_id,
            updates,
        };
        if room.send(cmd).await.is_err() {
            self.joined.remove(&(crdt.magic_bytes(), room_id.clone()));
            self.ack(crdt, &room_id, batch_id, UpdateStatusCode::Unknown);
        }
    }

    fn expire_fragments(&mut self) {
        for (crdt, room_id, batch_id) in self.fragments.expire(Instant::now()) {
            self.ack(crdt, &room_id, batch_id, UpdateStatusCode::FragmentTimeout);
        }
    }

    async fn leave_all(&mut self) {
        for ((magic, _), joined) in self.joined.drain() {
            let crdt = CrdtType::from_magic_bytes(magic).expect("joined rooms have known magic");
            leave(&joined.room, self.id, crdt).await;
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
