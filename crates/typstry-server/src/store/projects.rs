use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::SqlitePool;

use crate::token;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Write,
    Read,
}

impl Permission {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::Read => "read",
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewProject {
    pub id: String,
    pub edit_token: String,
    pub view_token: String,
}

/// Inserts the project row. The document starts out empty: the first
/// client seeds it, since its content is encrypted with a key only clients
/// hold.
pub async fn create(pool: &SqlitePool) -> sqlx::Result<NewProject> {
    let project = NewProject {
        id: token::generate(),
        edit_token: token::generate(),
        view_token: token::generate(),
    };
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);

    sqlx::query(
        "INSERT INTO projects (id, edit_token, view_token, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&project.id)
    .bind(&project.edit_token)
    .bind(&project.view_token)
    .bind(created_at)
    .execute(pool)
    .await?;
    Ok(project)
}

/// A resolved share token. `view_token` is only set for write access: the
/// edit token already grants more than the view token, so handing it to edit
/// holders leaks nothing, while view holders must never learn the edit link.
pub struct ResolvedShare {
    pub project_id: String,
    pub permission: Permission,
    pub view_token: Option<String>,
}

/// Resolves a share token to its project and the access it grants.
pub async fn resolve_token(
    pool: &SqlitePool,
    token: &str,
) -> sqlx::Result<Option<(String, Permission)>> {
    Ok(resolve_share(pool, token)
        .await?
        .map(|r| (r.project_id, r.permission)))
}

/// Like [`resolve_token`], plus the view token for edit-token holders.
pub async fn resolve_share(pool: &SqlitePool, token: &str) -> sqlx::Result<Option<ResolvedShare>> {
    if !token::looks_valid(token) {
        return Ok(None);
    }
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT id, edit_token, view_token FROM projects WHERE edit_token = ?1 OR view_token = ?1",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(project_id, edit_token, view_token)| {
        if edit_token == token {
            ResolvedShare {
                project_id,
                permission: Permission::Write,
                view_token: Some(view_token),
            }
        } else {
            ResolvedShare {
                project_id,
                permission: Permission::Read,
                view_token: None,
            }
        }
    }))
}
