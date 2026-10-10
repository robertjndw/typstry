use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;

use super::{AppError, AppState};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    view_token: Option<String>,
}

/// `POST /api/projects`. Takes no body: the title belongs to the encrypted
/// document, which the creating client seeds itself. Whatever body a client
/// does send (`{}`, say) is never read, so it cannot make creation fail.
pub async fn create(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<CreatedProject>), AppError> {
    let project = projects::create(&state.db).await?;
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
) -> Result<Json<ShareInfo>, AppError> {
    let found = projects::resolve_share(&state.db, &token)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(ShareInfo {
        project_id: found.project_id,
        permission: found.permission.as_str(),
        view_token: found.view_token,
    }))
}
