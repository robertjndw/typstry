use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;

use super::{AppError, AppState};
use crate::store::{mls, projects};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    incarnation: u64,
    /// The epoch the GroupInfo describes, which is the group's head.
    epoch: u64,
    group_info: String,
    keyring: String,
}

/// `GET /api/p/{token}/mls`: what a newcomer needs to join the group with
/// an external commit. Live tokens only, since a retired token must not
/// reach the sealed keyring of the generation that replaced it.
pub async fn bootstrap(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, AppError> {
    let (project_id, _) = projects::resolve_token(&state.db, &token)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    let group = mls::load_group(&state.db, &project_id)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    let body = Json(Bootstrap {
        incarnation: group.incarnation,
        epoch: group.head_epoch,
        group_info: STANDARD.encode(&group.group_info),
        keyring: STANDARD.encode(&group.keyring),
    });
    // The keyring changes with every rotation; a cached copy is a stale key.
    let mut res = body.into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}
