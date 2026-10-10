//! Client protocol versions, so an outdated CLI or a stale browser tab is
//! told to upgrade instead of failing in odd ways.

use axum::Json;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use typstry_wire::{MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION, protocol_supported};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    protocol: u32,
    min_protocol: u32,
}

/// `GET /api/info`. Not gated, so a client that is too old can still ask
/// what it needs.
pub async fn info() -> Json<Info> {
    Json(Info {
        protocol: PROTOCOL_VERSION,
        min_protocol: MIN_PROTOCOL_VERSION,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TooOld {
    error: &'static str,
    protocol: u32,
    min_protocol: u32,
}

/// 426 for both the HTTP API and the WebSocket handshake.
pub fn too_old() -> Response {
    (
        StatusCode::UPGRADE_REQUIRED,
        Json(TooOld {
            error: "this client is too old for the server; upgrade it",
            protocol: PROTOCOL_VERSION,
            min_protocol: MIN_PROTOCOL_VERSION,
        }),
    )
        .into_response()
}

/// Whether to serve a client that declared `version`. A missing version is
/// let through, since curl, health checks and all clients from before
/// versioning send none. Raising [`MIN_PROTOCOL_VERSION`] won't stop those
/// old clients; if they ever need to be cut off, `None` has to count as too
/// old too.
pub fn accepts(version: Option<u32>) -> bool {
    version.is_none_or(protocol_supported)
}

/// Gates the HTTP API on the `X-Typstry-Protocol` header.
pub async fn gate(req: Request, next: Next) -> Response {
    let version = match req.headers().get(PROTOCOL_HEADER) {
        None => None,
        Some(value) => match value.to_str().ok().and_then(|v| v.trim().parse().ok()) {
            Some(v) => Some(v),
            None => return StatusCode::BAD_REQUEST.into_response(),
        },
    };
    if !accepts(version) {
        return too_old();
    }
    next.run(req).await
}
