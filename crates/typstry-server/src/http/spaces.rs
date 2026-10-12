use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;

use super::{AppError, AppState};
use crate::store::spaces;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSpace {
    space_id: String,
    edit_token: String,
    view_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    space_id: String,
    permission: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_token: Option<String>,
    /// The token was replaced by a rotation. It still names the space and
    /// what it used to grant, so a client can go and catch up.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    retired: bool,
}

/// `POST /api/spaces`. Takes no body: the title belongs to the encrypted
/// document, which the creating client seeds itself. Whatever body a client
/// does send (`{}`, say) is never read, so it cannot make creation fail.
pub async fn create(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<CreatedSpace>), AppError> {
    let space = spaces::create(&state.db).await?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedSpace {
            space_id: space.id,
            edit_token: space.edit_token,
            view_token: space.view_token,
        }),
    ))
}

pub async fn share(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<ShareInfo>, AppError> {
    if let Some(found) = spaces::resolve_share(&state.db, &token).await? {
        return Ok(Json(ShareInfo {
            space_id: found.space_id,
            permission: found.permission.as_str(),
            view_token: found.view_token,
            retired: false,
        }));
    }
    let retired = spaces::resolve_retired(&state.db, &token)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(ShareInfo {
        space_id: retired.space_id,
        permission: retired.permission.as_str(),
        view_token: None,
        retired: true,
    }))
}
