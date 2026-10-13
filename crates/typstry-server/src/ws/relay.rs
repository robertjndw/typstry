//! One side of a device pairing. The connection joins the channel named in
//! the query and forwards its binary frames to the other side untouched.
//! The server has no say in what they mean: the peers authenticate each
//! other with a code the server never sees.

use std::time::Instant as StdInstant;

use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio::time::Instant;
use typstry_wire::relay::{CHANNEL_MAX, MAX_RELAY_MESSAGE, close_reason};

use super::rate::TokenBucket;
use super::{CLOSE_POLICY, IDLE_TIMEOUT, Socket, admit};
use crate::room::Outbound;
use crate::state::AppState;

/// Frames queued for the writer. Pairing is a handful of messages.
const OUTBOX_FRAMES: usize = 32;

/// A pairing is a few messages in a row and then silence, so this is
/// generous for people and tight for anything else.
const BURST: u32 = 16;
const FRAMES_PER_SEC: f64 = 4.0;

#[derive(Deserialize)]
pub struct JoinQuery {
    /// Parsed after the upgrade, so a bad number is closed with 1008 like an
    /// unknown one instead of failing the handshake.
    channel: Option<String>,
    /// Present for the side that allocated the channel.
    claim: Option<String>,
}

/// Outdated clients never get here, see [`crate::http::protocol::gate`].
pub async fn handler(
    ws: WebSocketUpgrade,
    Query(query): Query<JoinQuery>,
    State(state): State<AppState>,
) -> Response {
    let permit = match admit(&state) {
        Ok(permit) => permit,
        Err(refused) => return refused.into_response(),
    };
    ws.max_message_size(MAX_RELAY_MESSAGE)
        .max_frame_size(MAX_RELAY_MESSAGE)
        .on_upgrade(move |socket| {
            let connections = state.connections.clone();
            connections.track_future(async move {
                run(socket, state, query).await;
                drop(permit);
            })
        })
}

async fn run(socket: WebSocket, state: AppState, query: JoinQuery) {
    let id = state.rooms.next_conn_id();
    let (mut socket, outbox) = Socket::open(socket, &state, OUTBOX_FRAMES);

    let number = query
        .channel
        .and_then(|raw| raw.parse::<u16>().ok())
        .filter(|n| (1..=CHANNEL_MAX).contains(n));
    let joined = number.filter(|&n| {
        state
            .relay
            .join(
                n,
                query.claim.as_deref(),
                id,
                outbox.clone(),
                Instant::now(),
            )
            .is_ok()
    });

    match joined {
        None => {
            // Unknown, expired and full look the same from outside.
            outbox.push(Outbound::Close(CLOSE_POLICY, close_reason::NO_CHANNEL));
        }
        Some(number) => {
            let mut requests = TokenBucket::new(BURST, FRAMES_PER_SEC, StdInstant::now());
            while let Some(frame) = socket.next(IDLE_TIMEOUT).await {
                if !requests.try_take(StdInstant::now(), 1) {
                    tracing::debug!(conn = id, "relay rate limited");
                    outbox.push(Outbound::Close(CLOSE_POLICY, close_reason::RATE_LIMITED));
                    break;
                }
                if !state.relay.forward(number, id, frame, Instant::now()) {
                    break;
                }
            }
            // Frees the channel and drops the registry's outbox handles,
            // which the writer needs gone before it can finish.
            state.relay.leave(number, id);
        }
    }

    drop(outbox);
    socket.finish().await;
    tracing::debug!(conn = id, "relay connection closed");
}
