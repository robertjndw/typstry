use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::{Sqlite, SqlitePool, Transaction};

use super::{sql, unsql};
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
pub struct NewSpace {
    pub id: String,
    pub edit_token: String,
    pub view_token: String,
}

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Inserts the space row. The document starts out empty: the first
/// client seeds it, since its content is encrypted with a key only clients
/// hold.
pub async fn create(pool: &SqlitePool) -> sqlx::Result<NewSpace> {
    let space = NewSpace {
        id: token::generate(),
        edit_token: token::generate(),
        view_token: token::generate(),
    };
    let created_at = now_secs();

    sqlx::query("INSERT INTO spaces (id, edit_token, view_token, created_at) VALUES (?, ?, ?, ?)")
        .bind(&space.id)
        .bind(&space.edit_token)
        .bind(&space.view_token)
        .bind(created_at)
        .execute(pool)
        .await?;
    Ok(space)
}

/// A resolved share token. `view_token` is only set for write access: the
/// edit token already grants more than the view token, so handing it to edit
/// holders leaks nothing, while view holders must never learn the edit link.
pub struct ResolvedShare {
    pub space_id: String,
    pub permission: Permission,
    pub view_token: Option<String>,
}

/// Resolves a share token to its space and the access it grants.
pub async fn resolve_token(
    pool: &SqlitePool,
    token: &str,
) -> sqlx::Result<Option<(String, Permission)>> {
    Ok(resolve_share(pool, token)
        .await?
        .map(|r| (r.space_id, r.permission)))
}

/// Like [`resolve_token`], plus the view token for edit-token holders.
pub async fn resolve_share(pool: &SqlitePool, token: &str) -> sqlx::Result<Option<ResolvedShare>> {
    if !token::looks_valid(token) {
        return Ok(None);
    }
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT id, edit_token, view_token FROM spaces WHERE edit_token = ?1 OR view_token = ?1",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(space_id, edit_token, view_token)| {
        if edit_token == token {
            ResolvedShare {
                space_id,
                permission: Permission::Write,
                view_token: Some(view_token),
            }
        } else {
            ResolvedShare {
                space_id,
                permission: Permission::Read,
                view_token: None,
            }
        }
    }))
}

#[derive(Debug, thiserror::Error)]
pub enum RotateError {
    #[error("new token is not a valid token")]
    InvalidToken,
    /// Also covers handing back one of the space's current tokens, which
    /// would rotate nothing.
    #[error("new token is already in use")]
    TokenInUse,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Swaps the space's tokens for new ones, which the rotating client picked.
/// The old pair moves to `retired_tokens` with the epoch of the commit that
/// carried the rotation. Returns the old `(edit, view)` tokens.
///
/// This runs inside the caller's transaction so that it lands together with
/// the commit, and every check happens before the first write here.
pub async fn rotate_tokens(
    tx: &mut Transaction<'_, Sqlite>,
    space_id: &str,
    new_edit: &str,
    new_view: &str,
    epoch: u64,
) -> Result<(String, String), RotateError> {
    if !token::looks_valid(new_edit) || !token::looks_valid(new_view) {
        return Err(RotateError::InvalidToken);
    }
    if new_edit == new_view {
        return Err(RotateError::TokenInUse);
    }
    let taken: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM spaces WHERE edit_token IN (?1, ?2) OR view_token IN (?1, ?2)
         UNION ALL SELECT 1 FROM retired_tokens WHERE token IN (?1, ?2) LIMIT 1",
    )
    .bind(new_edit)
    .bind(new_view)
    .fetch_optional(&mut **tx)
    .await?;
    if taken.is_some() {
        return Err(RotateError::TokenInUse);
    }
    let (old_edit, old_view): (String, String) =
        sqlx::query_as("SELECT edit_token, view_token FROM spaces WHERE id = ?")
            .bind(space_id)
            .fetch_one(&mut **tx)
            .await?;

    let now = now_secs();
    let epoch = sql(epoch);
    for (token, permission) in [(&old_edit, "write"), (&old_view, "read")] {
        sqlx::query(
            "INSERT INTO retired_tokens (token, space_id, permission, retired_at, retired_epoch)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(token)
        .bind(space_id)
        .bind(permission)
        .bind(now)
        .bind(epoch)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query("UPDATE spaces SET edit_token = ?, view_token = ? WHERE id = ?")
        .bind(new_edit)
        .bind(new_view)
        .bind(space_id)
        .execute(&mut **tx)
        .await?;
    Ok((old_edit, old_view))
}

/// Forgets retired tokens from before `older_than` (unix seconds), which is
/// as long as the commit log keeps the rotations they would read. Past that
/// the holder gets the same answer as for any unknown link.
pub async fn expire_retired(
    pool: &SqlitePool,
    space_id: &str,
    older_than: i64,
) -> sqlx::Result<u64> {
    let done = sqlx::query("DELETE FROM retired_tokens WHERE space_id = ? AND retired_at < ?")
        .bind(space_id)
        .bind(older_than)
        .execute(pool)
        .await?;
    Ok(done.rows_affected())
}

/// A token a rotation replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredToken {
    pub space_id: String,
    /// What the token granted before it was retired.
    pub permission: Permission,
    pub retired_epoch: u64,
}

pub async fn resolve_retired(pool: &SqlitePool, token: &str) -> sqlx::Result<Option<RetiredToken>> {
    if !token::looks_valid(token) {
        return Ok(None);
    }
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT space_id, permission, retired_epoch FROM retired_tokens WHERE token = ?",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(space_id, permission, epoch)| RetiredToken {
        space_id,
        permission: if permission == "write" {
            Permission::Write
        } else {
            Permission::Read
        },
        retired_epoch: unsql(epoch),
    }))
}

/// What a token means to the delivery service, which also serves the
/// holders of retired tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DsAccess {
    Live(Permission),
    Retired { epoch: u64 },
}

pub async fn resolve_ds(
    pool: &SqlitePool,
    token: &str,
) -> sqlx::Result<Option<(String, DsAccess)>> {
    if let Some((space_id, permission)) = resolve_token(pool, token).await? {
        return Ok(Some((space_id, DsAccess::Live(permission))));
    }
    Ok(resolve_retired(pool, token).await?.map(|r| {
        (
            r.space_id,
            DsAccess::Retired {
                epoch: r.retired_epoch,
            },
        )
    }))
}
