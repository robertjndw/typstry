pub mod conn;
pub mod mls;
pub mod rate;
pub mod relay;

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use loro_protocol::MAX_MESSAGE_SIZE;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{Instant, timeout, timeout_at};
use tokio_util::sync::CancellationToken;

use crate::limits::ConnPermit;
use crate::room::{Outbound, Outbox, OutboxReceiver};
use crate::state::AppState;

/// Protocol messages are capped at 256 KiB; anything larger is split into
/// fragments by the sender, so a bigger frame is a broken or hostile client.
const MAX_FRAME: usize = MAX_MESSAGE_SIZE + 1024;

/// The JS client pings every 30 s, so silence this long means a dead peer.
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// How long one frame may take to go out. A client that stops reading
/// fills the socket's buffers, and then the writer waits; past this the
/// connection is dropped, so it cannot keep its queue (which may hold a
/// whole backfill) in memory for good. Frames are at most a few MiB, so a
/// client still reading at a few dozen KiB/s never gets near it.
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// A deliberate close that is no error, like a peer that finished.
pub(crate) const CLOSE_NORMAL: u16 = 1000;

/// Neither code is in the JS client's fatal list (1008, 1011, 4400-4499), so
/// it reconnects and resyncs after either.
pub(crate) const CLOSE_PROTOCOL_ERROR: u16 = 1002;
pub(crate) const CLOSE_GOING_AWAY: u16 = 1001;

/// 1008 is in the JS client's fatal list, so it stops retrying a token that
/// does not work.
pub(crate) const CLOSE_POLICY: u16 = 1008;

/// "Try again later", for failures that are ours and passing, like a
/// database error or a client over its join rate. Unlike 1011 it is in
/// neither client's fatal list, so they reconnect with backoff.
pub(crate) const CLOSE_TRY_AGAIN: u16 = 1013;

/// Writes queued frames to the socket until a close frame goes out or the
/// socket breaks. A frame stuck for [`WRITE_STALL_TIMEOUT`] ends it too, and
/// fires `stalled` so the connection closes.
pub(crate) fn spawn_writer(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: OutboxReceiver,
    stalled: Arc<Notify>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
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
            match timeout(WRITE_STALL_TIMEOUT, sink.send(msg)).await {
                Ok(Ok(())) if !last => {}
                Ok(_) => break,
                Err(_) => {
                    tracing::debug!("client stopped reading, dropping it");
                    // Dropping the queue frees whatever it held; the
                    // socket is not worth a polite close.
                    drop(rx);
                    stalled.notify_one();
                    return;
                }
            }
        }
        let _ = sink.close().await;
    })
}

/// The part of a connection both protocols share: the writer task, text
/// keepalives, and the ways a connection ends without the client asking.
pub(crate) struct Socket {
    stream: SplitStream<WebSocket>,
    outbox: Outbox,
    overflow: Arc<Notify>,
    shutdown: CancellationToken,
    writer: JoinHandle<()>,
    overflowed: bool,
    // When the client last sent anything. The idle deadline counts from here
    // rather than from each `next` call, since a caller racing `next` against
    // a timer restarts it far more often than the client goes quiet.
    heard: Instant,
}

impl Socket {
    /// Also returns the outbox, for the connection and the rooms it joins.
    pub(crate) fn open(socket: WebSocket, state: &AppState, max_frames: usize) -> (Self, Outbox) {
        let (sink, stream) = socket.split();
        let (outbox, rx) = Outbox::channel(
            max_frames,
            state.limits.outbox_bytes,
            state.limits.max_rooms,
        );
        let socket = Self {
            stream,
            outbox: outbox.clone(),
            overflow: outbox.overflow_signal(),
            shutdown: state.shutdown.clone(),
            writer: spawn_writer(sink, rx, outbox.overflow_signal()),
            overflowed: false,
            heard: Instant::now(),
        };
        (socket, outbox)
    }

    /// The next binary message, or None once the connection is over or the
    /// client has been silent for `idle`. Cancel safe, so it can race other
    /// work in a `select!`.
    pub(crate) async fn next(&mut self, idle: Duration) -> Option<Bytes> {
        loop {
            tokio::select! {
                next = timeout_at(self.heard + idle, self.stream.next()) => {
                    if next.is_ok() {
                        self.heard = Instant::now();
                    }
                    match next {
                        Ok(Some(Ok(Message::Binary(bytes)))) => return Some(bytes),
                        Ok(Some(Ok(Message::Text(text)))) => {
                            if text.as_str() == "ping" {
                                self.outbox.push(Outbound::Text("pong"));
                            }
                        }
                        Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
                        Ok(Some(Ok(Message::Close(_)) | Err(_)) | None) => return None,
                        Err(_) => {
                            self.outbox.push(Outbound::Close(CLOSE_GOING_AWAY, "idle_timeout"));
                            return None;
                        }
                    }
                }
                () = self.overflow.notified() => {
                    self.overflowed = true;
                    return None;
                }
                () = self.shutdown.cancelled() => {
                    self.outbox.push(Outbound::Close(CLOSE_GOING_AWAY, "server shutdown"));
                    return None;
                }
            }
        }
    }

    /// Gives the writer a moment to flush what is queued. The connection's
    /// own outbox has to be dropped first, or the writer waits for it.
    pub(crate) async fn finish(self) {
        let Self {
            stream,
            outbox,
            mut writer,
            overflowed,
            ..
        } = self;
        drop(outbox);
        // After an overflow the queue is full, so no close frame can follow;
        // dropping the socket makes the client reconnect promptly. A stalled
        // writer counts as an overflow too.
        if overflowed || timeout(Duration::from_secs(2), &mut writer).await.is_err() {
            writer.abort();
        }
        drop(stream);
    }
}

/// A slot for one more socket, or the answer refusing the upgrade. Refused
/// before the upgrade, as a plain HTTP error, which every client treats as
/// a failed connect and retries with backoff.
pub(crate) fn admit(state: &AppState) -> Result<ConnPermit, StatusCode> {
    state.conns.connect().map_err(|_| {
        tracing::debug!("websocket refused, server full");
        StatusCode::SERVICE_UNAVAILABLE
    })
}

/// Outdated clients never get here, see [`crate::http::protocol::gate`].
pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let permit = match admit(&state) {
        Ok(permit) => permit,
        Err(refused) => return refused.into_response(),
    };
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| {
            // An upgraded socket is no longer a request axum waits for on
            // graceful shutdown, so the server tracks it itself.
            let connections = state.connections.clone();
            connections.track_future(async move {
                conn::run(socket, state).await;
                drop(permit);
            })
        })
}

/// Per-connection abuse limits.
#[derive(Debug, Clone)]
pub struct ConnLimits {
    /// Doc records a connection may send in a burst. The doc and presence
    /// each get their own bucket so cursor chatter cannot starve edits.
    /// Presence is charged per blob.
    pub update_burst: u32,
    /// Sustained records per second, per bucket. Typing produces one doc
    /// record per keystroke at most, so 50/s leaves plenty of headroom.
    pub updates_per_sec: f64,
    /// Rooms one connection may join. A space needs two (doc and
    /// presence); the rest is slack for switching spaces in one tab.
    pub max_rooms: usize,
    /// Bytes of live traffic queued for a slow client before it is
    /// dropped. A join's backfill is queued outside this budget, so it
    /// does not cap the size of a doc a client can load.
    pub outbox_bytes: usize,
}

/// Twice the largest update one client can send (and so the largest relay
/// another one receives), so a client that reads keeps up with a big paste
/// arriving while it is busy. Every connection may pin this much, which is
/// why it is no larger.
pub const DEFAULT_OUTBOX_BYTES: usize = 2 * typstry_wire::fragment::MAX_REASSEMBLED;

impl Default for ConnLimits {
    fn default() -> Self {
        Self {
            update_burst: 200,
            updates_per_sec: 50.0,
            max_rooms: 8,
            outbox_bytes: DEFAULT_OUTBOX_BYTES,
        }
    }
}
