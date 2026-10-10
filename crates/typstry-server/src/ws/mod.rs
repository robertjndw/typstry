pub mod conn;
pub mod rate;

use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::response::Response;
use loro_protocol::MAX_MESSAGE_SIZE;

use crate::state::AppState;

/// Protocol messages are capped at 256 KiB; anything larger is split into
/// fragments by the sender, so a bigger frame is a broken or hostile client.
const MAX_FRAME: usize = MAX_MESSAGE_SIZE + 1024;

/// Outdated clients never get here, see [`crate::http::protocol::gate`].
pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| {
            // An upgraded socket is no longer a request axum waits for on
            // graceful shutdown, so the server tracks it itself.
            let connections = state.connections.clone();
            connections.track_future(conn::run(socket, state))
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
    /// Rooms one connection may join. A project needs two (doc and
    /// presence); the rest is slack for switching projects in one tab.
    pub max_rooms: usize,
    /// Bytes of live traffic queued for a slow client before it is
    /// dropped. A join's backfill is queued outside this budget, so it
    /// does not cap the size of a doc a client can load.
    pub outbox_bytes: usize,
}

impl Default for ConnLimits {
    fn default() -> Self {
        Self {
            update_burst: 200,
            updates_per_sec: 50.0,
            max_rooms: 8,
            outbox_bytes: 64 * 1024 * 1024,
        }
    }
}
