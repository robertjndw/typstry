//! The MLS group state of projects: the commit log and the sealed
//! GroupInfo and keyring newcomers bootstrap from.
//!
//! Epochs: the group is at `head_epoch`, and the commit submitted at epoch
//! N is the one that moves it to N + 1. A commit is stored under the epoch
//! it extends, so the log reads 0, 1, 2 ... and a client at epoch E needs
//! the commits from E on. Only the project's room actor writes here, but
//! the conditional updates below keep the invariants even without it.

use sqlx::{SqliteConnection, SqlitePool};

use super::projects::{self, RotateError, now_secs};
use super::{sql, unsql};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub incarnation: u64,
    pub head_epoch: u64,
    pub group_id: Vec<u8>,
    pub group_info: Vec<u8>,
    pub keyring: Vec<u8>,
}

/// What the room actor keeps in memory: the group without its big blobs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub incarnation: u64,
    pub epoch: u64,
    pub group_id: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCommit {
    pub epoch: u64,
    pub data: Vec<u8>,
    pub envelope: Option<Vec<u8>>,
}

/// incarnation, head, group id, group info, keyring.
type GroupRow = (i64, i64, Vec<u8>, Vec<u8>, Vec<u8>);

pub async fn load_group(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Option<Group>> {
    let row: Option<GroupRow> = sqlx::query_as(
        "SELECT incarnation, head_epoch, group_id, group_info, keyring
         FROM mls_groups WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(
        row.map(|(incarnation, head, group_id, group_info, keyring)| Group {
            incarnation: unsql(incarnation),
            head_epoch: unsql(head),
            group_id,
            group_info,
            keyring,
        }),
    )
}

pub async fn load_head(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Option<Head>> {
    let row: Option<(i64, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT incarnation, head_epoch, group_id FROM mls_groups WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(incarnation, epoch, group_id)| Head {
        incarnation: unsql(incarnation),
        epoch: unsql(epoch),
        group_id,
    }))
}

/// Creates the group at incarnation 0, epoch 0. False if there already is
/// one, so of two racing creators only one wins.
pub async fn init_group(
    pool: &SqlitePool,
    project_id: &str,
    group_id: &[u8],
    group_info: &[u8],
    keyring: &[u8],
) -> sqlx::Result<bool> {
    let done = sqlx::query(
        "INSERT INTO mls_groups
           (project_id, incarnation, head_epoch, group_id, group_info, keyring)
         VALUES (?, 0, 0, ?, ?, ?)
         ON CONFLICT (project_id) DO NOTHING",
    )
    .bind(project_id)
    .bind(group_id)
    .bind(group_info)
    .bind(keyring)
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Append {
    Appended,
    /// The group is already past that epoch (or never got there).
    Conflict {
        head: u64,
    },
    NoGroup,
    WrongIncarnation,
}

/// Stores the commit that extends `args.epoch` and moves the group to
/// `args.epoch + 1`, if the group is at exactly that epoch of
/// `args.incarnation`. The GroupInfo (and keyring, if any) that came with
/// the commit describe the epoch after it, so they are swapped in with the
/// same update.
///
/// The conditional update comes first so the transaction takes SQLite's
/// write lock up front; reading first and upgrading later can fail
/// instantly with a busy snapshot when another project writes in between.
pub async fn append_commit(
    conn: &mut SqliteConnection,
    project_id: &str,
    args: &SubmitArgs<'_>,
) -> sqlx::Result<Append> {
    let moved = sqlx::query(
        "UPDATE mls_groups
         SET head_epoch = head_epoch + 1, group_info = ?, keyring = COALESCE(?, keyring)
         WHERE project_id = ? AND incarnation = ? AND head_epoch = ?",
    )
    .bind(args.group_info)
    .bind(args.keyring)
    .bind(project_id)
    .bind(sql(args.incarnation))
    .bind(sql(args.epoch))
    .execute(&mut *conn)
    .await?;
    if moved.rows_affected() == 0 {
        let row: Option<(i64, i64)> =
            sqlx::query_as("SELECT incarnation, head_epoch FROM mls_groups WHERE project_id = ?")
                .bind(project_id)
                .fetch_optional(&mut *conn)
                .await?;
        return Ok(match row {
            None => Append::NoGroup,
            Some((current, _)) if unsql(current) != args.incarnation => Append::WrongIncarnation,
            Some((_, head)) => Append::Conflict { head: unsql(head) },
        });
    }
    sqlx::query(
        "INSERT INTO mls_commits (project_id, incarnation, epoch, data, envelope, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(sql(args.incarnation))
    .bind(sql(args.epoch))
    .bind(args.commit)
    .bind(args.envelope)
    .bind(now_secs())
    .execute(&mut *conn)
    .await?;
    Ok(Append::Appended)
}

/// Commits that extended an epoch in `since..=until`, in order.
pub async fn commits_since(
    pool: &SqlitePool,
    project_id: &str,
    incarnation: u64,
    since: u64,
    until: u64,
) -> sqlx::Result<Vec<StoredCommit>> {
    let rows: Vec<(i64, Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT epoch, data, envelope FROM mls_commits
         WHERE project_id = ? AND incarnation = ? AND epoch >= ? AND epoch <= ? ORDER BY epoch",
    )
    .bind(project_id)
    .bind(sql(incarnation))
    .bind(sql(since))
    .bind(sql(until))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(epoch, data, envelope)| StoredCommit {
            epoch: unsql(epoch),
            data,
            envelope,
        })
        .collect())
}

/// What keeps a project's commit log from growing without bound. Anyone
/// with a view link can append external commits, so the log has to be
/// bounded by what the server decides, not by what clients send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PruneLimits {
    /// Commits older than this (unix seconds) are dropped, except the newest
    /// one, which a member one epoch behind still needs.
    pub older_than: i64,
    /// At most this many of the newest commits are kept, however young.
    pub keep_last: u64,
    /// At most this many bytes of the newest commits are kept, however
    /// young. The newest commit is always kept.
    pub max_bytes: u64,
}

/// Drops commits that are over any of the [`PruneLimits`] and returns how
/// many went. Only the log of `incarnation`, which the caller knows to be
/// the current one at `head_epoch`, is looked at, since a reset already
/// cleared the earlier ones.
pub async fn prune_commits(
    pool: &SqlitePool,
    project_id: &str,
    incarnation: u64,
    head_epoch: u64,
    limits: PruneLimits,
) -> sqlx::Result<u64> {
    // The newest commit extended `head_epoch - 1`, and always stays.
    let mut gone = 0;
    gone += sqlx::query(
        "DELETE FROM mls_commits
         WHERE project_id = ?1 AND incarnation = ?2 AND epoch < ?3 - ?4",
    )
    .bind(project_id)
    .bind(sql(incarnation))
    .bind(sql(head_epoch))
    .bind(sql(limits.keep_last))
    .execute(pool)
    .await?
    .rows_affected();
    gone += sqlx::query(
        "DELETE FROM mls_commits
         WHERE project_id = ?1 AND incarnation = ?2 AND epoch < ?3 - 1 AND created_at < ?4",
    )
    .bind(project_id)
    .bind(sql(incarnation))
    .bind(sql(head_epoch))
    .bind(limits.older_than)
    .execute(pool)
    .await?
    .rows_affected();
    // The running total counts from the newest commit back, so what is
    // dropped is whatever no longer fits under the cap.
    gone += sqlx::query(
        "DELETE FROM mls_commits
         WHERE project_id = ?1 AND incarnation = ?2 AND epoch < ?3 - 1
           AND epoch IN (
             SELECT epoch FROM (
               SELECT epoch, SUM(LENGTH(data) + COALESCE(LENGTH(envelope), 0))
                        OVER (ORDER BY epoch DESC) AS total
               FROM mls_commits
               WHERE project_id = ?1 AND incarnation = ?2
             ) WHERE total > ?4
           )",
    )
    .bind(project_id)
    .bind(sql(incarnation))
    .bind(sql(head_epoch))
    .bind(sql(limits.max_bytes))
    .execute(pool)
    .await?
    .rows_affected();
    Ok(gone)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reset {
    Done { incarnation: u64 },
    WrongIncarnation,
    NoGroup,
}

/// Starts a new incarnation from `expected` and forgets the old log, whose
/// epochs mean nothing to the new group. Compare-and-swap on the
/// incarnation, so of two editors resetting at once only one succeeds.
pub async fn reset_group(
    pool: &SqlitePool,
    project_id: &str,
    expected: u64,
    group_id: &[u8],
    group_info: &[u8],
    keyring: &[u8],
) -> sqlx::Result<Reset> {
    let mut tx = pool.begin().await?;
    let done = sqlx::query(
        "UPDATE mls_groups SET incarnation = incarnation + 1, head_epoch = 0, group_id = ?,
           group_info = ?, keyring = ?
         WHERE project_id = ? AND incarnation = ?",
    )
    .bind(group_id)
    .bind(group_info)
    .bind(keyring)
    .bind(project_id)
    .bind(sql(expected))
    .execute(&mut *tx)
    .await?;
    if done.rows_affected() == 0 {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM mls_groups WHERE project_id = ?")
                .bind(project_id)
                .fetch_optional(&mut *tx)
                .await?;
        return Ok(if exists.is_some() {
            Reset::WrongIncarnation
        } else {
            Reset::NoGroup
        });
    }
    sqlx::query("DELETE FROM mls_commits WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Reset::Done {
        incarnation: expected + 1,
    })
}

pub struct SubmitArgs<'a> {
    pub incarnation: u64,
    pub epoch: u64,
    pub commit: &'a [u8],
    pub group_info: &'a [u8],
    pub keyring: Option<&'a [u8]>,
    pub envelope: Option<&'a [u8]>,
    pub rotate: Option<(&'a str, &'a str)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Submitted {
    /// Applied whole. Carries the old `(edit, view)` tokens of a rotation.
    Accepted {
        retired: Option<(String, String)>,
    },
    Conflict {
        head: u64,
    },
    NoGroup,
    WrongIncarnation,
}

#[derive(Debug, thiserror::Error)]
pub enum SubmitError {
    #[error(transparent)]
    Rotate(RotateError),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// The commit, its GroupInfo and keyring, and the token swap of a rotation,
/// in one transaction: any failure leaves the project exactly as it was.
pub async fn submit(
    pool: &SqlitePool,
    project_id: &str,
    args: &SubmitArgs<'_>,
) -> Result<Submitted, SubmitError> {
    let mut tx = pool.begin().await?;
    match append_commit(&mut tx, project_id, args).await? {
        Append::Appended => {}
        Append::Conflict { head } => return Ok(Submitted::Conflict { head }),
        Append::NoGroup => return Ok(Submitted::NoGroup),
        Append::WrongIncarnation => return Ok(Submitted::WrongIncarnation),
    }
    let retired = match args.rotate {
        Some((edit, view)) => Some(
            projects::rotate_tokens(&mut tx, project_id, edit, view, args.epoch)
                .await
                .map_err(|err| match err {
                    RotateError::Db(err) => SubmitError::Db(err),
                    other => SubmitError::Rotate(other),
                })?,
        ),
        None => None,
    };
    tx.commit().await?;
    Ok(Submitted::Accepted { retired })
}
