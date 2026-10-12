use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Serialize;
use tokio::time::Instant;

use super::{AppError, AppState};
use crate::relay::AllocateError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    channel: u16,
    /// Opens the first seat of the channel; whoever lacks it can only take
    /// the second.
    claim: String,
    /// Seconds until the channel is dropped if the pairing is not done.
    expires_in: u64,
}

/// `POST /api/relay`. Takes no body.
pub async fn allocate(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<Channel>), AppError> {
    let (channel, claim) = state
        .relay
        .allocate(Instant::now())
        .map_err(|AllocateError::Full| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((
        StatusCode::CREATED,
        Json(Channel {
            channel,
            claim,
            expires_in: state.relay.ttl().as_secs(),
        }),
    ))
}
