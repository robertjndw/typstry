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

/// Resolves a share token to its project and the access it grants.
pub async fn resolve_token(
    pool: &SqlitePool,
    token: &str,
) -> sqlx::Result<Option<(String, Permission)>> {
    if !token::looks_valid(token) {
        return Ok(None);
    }
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT id, edit_token FROM projects WHERE edit_token = ?1 OR view_token = ?1",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, edit_token)| {
        let permission = if edit_token == token {
            Permission::Write
        } else {
            Permission::Read
        };
        (id, permission)
    }))
}
