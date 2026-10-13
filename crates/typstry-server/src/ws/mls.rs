//! One WebSocket connection speaking the MLS delivery service protocol of
//! `typstry_wire::ds`.
//!
//! It is its own socket because Loro's `CrdtType` is a closed enum. The
//! connection only decodes, rate limits and forwards: what a token may do
//! is decided by the space's room, which sees rotations in the same
//! order as everything else and so never acts on a stale permission.

use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use tokio::sync::mpsc;
use tokio::time::timeout_at;
use typstry_wire::ds::{ClientMessage, DsError, MAX_DS_MESSAGE, RefusalCode, ServerMessage};

use super::rate::TokenBucket;
use super::{
    CLOSE_GOING_AWAY, CLOSE_POLICY, CLOSE_PROTOCOL_ERROR, CLOSE_TRY_AGAIN, IDLE_TIMEOUT, Socket,
    admit,
};
use crate::room::{ConnId, JoinOutcome, Outbound, Outbox, RoomCmd};
use crate::state::AppState;
use crate::store::spaces;

/// Frames buffered per connection before the client counts as too slow.
const OUTBOX_FRAMES: usize = 512;

/// Whoever opens a socket and then says nothing is not a client. Counted
/// from the upgrade, so keepalive pings do not stretch it.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Outdated clients never get here, see [`crate::http::protocol::gate`].
pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let permit = match admit(&state) {
        Ok(permit) => permit,
        Err(refused) => return refused.into_response(),
    };
    ws.max_message_size(MAX_DS_MESSAGE)
        .max_frame_size(MAX_DS_MESSAGE)
        .on_upgrade(move |socket| {
            let connections = state.connections.clone();
            connections.track_future(async move {
                run(socket, state).await;
                drop(permit);
            })
        })
}

struct Conn {
    id: ConnId,
    state: AppState,
    outbox: Outbox,
    /// The space's room, once the Hello was accepted.
    room: Option<mpsc::Sender<RoomCmd>>,
    requests: TokenBucket,
}

async fn run(socket: WebSocket, state: AppState) {
    let id = state.rooms.next_conn_id();
    let (mut socket, outbox) = Socket::open(socket, &state, OUTBOX_FRAMES);

    let limits = &state.limits;
    let mut conn = Conn {
        id,
        requests: TokenBucket::new(limits.update_burst, limits.updates_per_sec, Instant::now()),
        state,
        outbox,
        room: None,
    };

    let hello_deadline = tokio::time::Instant::now() + HELLO_TIMEOUT;
    loop {
        let next = if conn.room.is_some() {
            socket.next(IDLE_TIMEOUT).await
        } else {
            match timeout_at(hello_deadline, socket.next(IDLE_TIMEOUT)).await {
                Ok(next) => next,
                Err(_) => {
                    conn.close(CLOSE_GOING_AWAY, "hello_timeout");
                    None
                }
            }
        };
        let Some(bytes) = next else {
            break;
        };
        if !conn.on_binary(&bytes).await {
            break;
        }
    }

    if let Some(room) = conn.room.take() {
        let _ = room.send(RoomCmd::DsLeave { conn: id }).await;
    }
    drop(conn);
    socket.finish().await;
    tracing::debug!(conn = id, "delivery service connection closed");
}

impl Conn {
    /// Returns false when the connection should close.
    async fn on_binary(&mut self, bytes: &[u8]) -> bool {
        match ClientMessage::decode(bytes) {
            Ok(msg) => self.on_protocol(msg).await,
            Err(err) => {
                tracing::debug!(conn = self.id, %err, "bad delivery service message");
                let reason = match err {
                    DsError::UnsupportedVersion(_) => "unsupported_version",
                    _ => "Protocol error",
                };
                self.close(CLOSE_PROTOCOL_ERROR, reason);
                false
            }
        }
    }

    async fn on_protocol(&mut self, msg: ClientMessage) -> bool {
        match (&self.room, msg) {
            (
                None,
                ClientMessage::Hello {
                    token,
                    incarnation,
                    since_epoch,
                },
            ) => self.hello(token, incarnation, since_epoch).await,
            // Hello first, and only once.
            (None, _) | (Some(_), ClientMessage::Hello { .. }) => {
                self.close(CLOSE_PROTOCOL_ERROR, "Protocol error");
                false
            }
            (Some(room), msg) => {
                if !self.requests.try_take(Instant::now(), 1) {
                    tracing::debug!(conn = self.id, "delivery service rate limited");
                    self.send(&ServerMessage::Refused {
                        req: req_of(&msg),
                        code: RefusalCode::RateLimited,
                    });
                    return true;
                }
                let cmd = RoomCmd::DsMessage { conn: self.id, msg };
                if room.send(cmd).await.is_err() {
                    self.close(CLOSE_GOING_AWAY, "room unavailable");
                    return false;
                }
                true
            }
        }
    }

    async fn hello(&mut self, token: String, incarnation: u64, since_epoch: u64) -> bool {
        let resolved = match spaces::resolve_ds(&self.state.db, &token).await {
            Ok(resolved) => resolved,
            Err(err) => {
                tracing::error!(%err, "token lookup failed");
                self.close(CLOSE_TRY_AGAIN, "try_again_later");
                return false;
            }
        };
        let Some((space_id, access)) = resolved else {
            // Unknown tokens and malformed ones look the same.
            self.send(&ServerMessage::Refused {
                req: 0,
                code: RefusalCode::Forbidden,
            });
            self.close(CLOSE_POLICY, "auth_failed");
            return false;
        };
        let outcome = self
            .state
            .rooms
            .join(&space_id, |reply| RoomCmd::DsHello {
                conn: self.id,
                token: token.clone(),
                access: access.clone(),
                incarnation,
                since_epoch,
                outbox: self.outbox.clone(),
                reply,
            })
            .await;
        match outcome {
            JoinOutcome::Joined(room) => {
                self.room = Some(room);
                true
            }
            // The room refuses a hello only when it could not load the
            // group or the log, or the client's queue overflowed on the
            // backfill. None of that says the token is bad.
            JoinOutcome::Refused => {
                self.close(CLOSE_TRY_AGAIN, "try_again_later");
                false
            }
            JoinOutcome::Unavailable => {
                self.close(CLOSE_GOING_AWAY, "room unavailable");
                false
            }
        }
    }

    fn send(&self, msg: &ServerMessage) {
        self.outbox
            .push(Outbound::Binary(Bytes::from(msg.encode())));
    }

    fn close(&self, code: u16, reason: &'static str) {
        self.outbox.push(Outbound::Close(code, reason));
    }
}

fn req_of(msg: &ClientMessage) -> u64 {
    match msg {
        ClientMessage::Submit { req, .. }
        | ClientMessage::Init { req, .. }
        | ClientMessage::Reset { req, .. } => *req,
        ClientMessage::Hello { .. } | ClientMessage::Fetch { .. } => 0,
    }
}
