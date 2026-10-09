use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;

use super::{AppState, internal};
use crate::store::projects;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    project_id: String,
    edit_token: String,
    view_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    project_id: String,
    permission: &'static str,
}

/// `POST /api/projects`. Takes no body: the title belongs to the encrypted
/// document, which the creating client seeds itself. Whatever body a client
/// does send (`{}`, say) is never read, so it cannot make creation fail.
pub async fn create(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<CreatedProject>), StatusCode> {
    let project = projects::create(&state.db).await.map_err(internal)?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedProject {
            project_id: project.id,
            edit_token: project.edit_token,
            view_token: project.view_token,
        }),
    ))
}

pub async fn share(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<ShareInfo>, StatusCode> {
    match projects::resolve_token(&state.db, &token).await {
        Ok(Some((project_id, permission))) => Ok(Json(ShareInfo {
            project_id,
            permission: permission.as_str(),
        })),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(err) => Err(internal(err)),
    }
}
