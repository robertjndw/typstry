pub mod conn;
pub mod rate;

use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::response::Response;
use loro_protocol::MAX_MESSAGE_SIZE;

use crate::http::AppState;

/// Protocol messages are capped at 256 KiB; anything larger is split into
/// fragments by the sender, so a bigger frame is a broken or hostile client.
const MAX_FRAME: usize = MAX_MESSAGE_SIZE + 1024;

pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| conn::run(socket, state))
}

/// Per-connection abuse limits.
#[derive(Debug, Clone)]
pub struct ConnLimits {
    /// Doc updates a connection may send in a burst. The doc and presence
    /// each get their own bucket so cursor chatter cannot starve edits.
    pub update_burst: u32,
    /// Sustained updates per second, per bucket. Typing produces one doc
    /// update per keystroke at most, so 50/s leaves plenty of headroom.
    pub updates_per_sec: f64,
    /// Rooms one connection may join. A project needs two (doc and
    /// presence); the rest is slack for switching projects in one tab.
    pub max_rooms: usize,
}

impl Default for ConnLimits {
    fn default() -> Self {
        Self {
            update_burst: 200,
            updates_per_sec: 50.0,
            max_rooms: 8,
        }
    }
}
