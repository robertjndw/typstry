//! The MLS group state of spaces: the commit log and the sealed
//! GroupInfo and keyring newcomers bootstrap from.
//!
//! Epochs: the group is at `head_epoch`, and the commit submitted at epoch
//! N is the one that moves it to N + 1. A commit is stored under the epoch
//! it extends, so the log reads 0, 1, 2 ... and a client at epoch E needs
//! the commits from E on. Only the space's room actor writes here, but
//! the conditional updates below keep the invariants even without it.
//!
//! The owner key is the one thing here that the server checks rather than
//! stores blindly: a rotation swaps the space's tokens, so it lands only
//! if it is signed with the owner key on record (see
//! [`typstry_wire::owner`]).

use sqlx::{SqliteConnection, SqlitePool};
use typstry_wire::ds::Rotate;
use typstry_wire::owner::{OwnerKey, RotationClaim, verify_rotation};

use super::spaces::{self, RotateError, now_secs};
use super::{sql, unsql};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub incarnation: u64,
    pub head_epoch: u64,
    pub group_id: Vec<u8>,
    pub group_info: Vec<u8>,
    pub keyring: Vec<u8>,
    pub owner_key: OwnerKey,
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
    /// The owner key a rotation moved on to.
    pub owner_key: Option<OwnerKey>,
}

/// epoch, data, envelope, owner key.
type CommitRow = (i64, Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>);

/// incarnation, head, group id, group info, keyring, owner key.
type GroupRow = (i64, i64, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>);

pub async fn load_group(pool: &SqlitePool, space_id: &str) -> sqlx::Result<Option<Group>> {
    let row: Option<GroupRow> = sqlx::query_as(
        "SELECT incarnation, head_epoch, group_id, group_info, keyring, owner_key
         FROM mls_groups WHERE space_id = ?",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await?;
    row.map(
        |(incarnation, head, group_id, group_info, keyring, owner_key)| {
            Ok(Group {
                incarnation: unsql(incarnation),
                head_epoch: unsql(head),
                group_id,
                group_info,
                keyring,
                owner_key: owner_key_of(owner_key)?,
            })
        },
    )
    .transpose()
}

/// The schema holds the length to 32, so anything else is a damaged row.
fn owner_key_of(bytes: Vec<u8>) -> sqlx::Result<OwnerKey> {
    OwnerKey::try_from(bytes).map_err(|bytes| {
        sqlx::Error::Decode(format!("an owner key of {} bytes", bytes.len()).into())
    })
}

pub async fn load_head(pool: &SqlitePool, space_id: &str) -> sqlx::Result<Option<Head>> {
    let row: Option<(i64, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT incarnation, head_epoch, group_id FROM mls_groups WHERE space_id = ?",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(incarnation, epoch, group_id)| Head {
        incarnation: unsql(incarnation),
        epoch: unsql(epoch),
        group_id,
    }))
}

/// Creates the group at incarnation 0, epoch 0, with the owner key its
/// first rotation has to be signed with. False if there already is one, so
/// of two racing creators only one wins.
pub async fn init_group(
    pool: &SqlitePool,
    space_id: &str,
    group_id: &[u8],
    group_info: &[u8],
    keyring: &[u8],
    owner_key: &OwnerKey,
) -> sqlx::Result<bool> {
    let done = sqlx::query(
        "INSERT INTO mls_groups
           (space_id, incarnation, head_epoch, group_id, group_info, keyring, owner_key)
         VALUES (?, 0, 0, ?, ?, ?, ?)
         ON CONFLICT (space_id) DO NOTHING",
    )
    .bind(space_id)
    .bind(group_id)
    .bind(group_info)
    .bind(keyring)
    .bind(owner_key.as_slice())
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
/// instantly with a busy snapshot when another space writes in between.
pub async fn append_commit(
    conn: &mut SqliteConnection,
    space_id: &str,
    args: &SubmitArgs<'_>,
) -> sqlx::Result<Append> {
    let moved = sqlx::query(
        "UPDATE mls_groups
         SET head_epoch = head_epoch + 1, group_info = ?, keyring = COALESCE(?, keyring)
         WHERE space_id = ? AND incarnation = ? AND head_epoch = ?",
    )
    .bind(args.group_info)
    .bind(args.keyring)
    .bind(space_id)
    .bind(sql(args.incarnation))
    .bind(sql(args.epoch))
    .execute(&mut *conn)
    .await?;
    if moved.rows_affected() == 0 {
        let row: Option<(i64, i64)> =
            sqlx::query_as("SELECT incarnation, head_epoch FROM mls_groups WHERE space_id = ?")
                .bind(space_id)
                .fetch_optional(&mut *conn)
                .await?;
        return Ok(match row {
            None => Append::NoGroup,
            Some((current, _)) if unsql(current) != args.incarnation => Append::WrongIncarnation,
            Some((_, head)) => Append::Conflict { head: unsql(head) },
        });
    }
    sqlx::query(
        "INSERT INTO mls_commits
           (space_id, incarnation, epoch, data, envelope, owner_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(space_id)
    .bind(sql(args.incarnation))
    .bind(sql(args.epoch))
    .bind(args.commit)
    .bind(args.envelope)
    .bind(args.rotate.as_ref().map(|r| r.next_owner_key.as_slice()))
    .bind(now_secs())
    .execute(&mut *conn)
    .await?;
    Ok(Append::Appended)
}

/// Commits that extended an epoch in `since..=until`, in order.
pub async fn commits_since(
    pool: &SqlitePool,
    space_id: &str,
    incarnation: u64,
    since: u64,
    until: u64,
) -> sqlx::Result<Vec<StoredCommit>> {
    let rows: Vec<CommitRow> = sqlx::query_as(
        "SELECT epoch, data, envelope, owner_key FROM mls_commits
         WHERE space_id = ? AND incarnation = ? AND epoch >= ? AND epoch <= ? ORDER BY epoch",
    )
    .bind(space_id)
    .bind(sql(incarnation))
    .bind(sql(since))
    .bind(sql(until))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|(epoch, data, envelope, owner_key)| {
            Ok(StoredCommit {
                epoch: unsql(epoch),
                data,
                envelope,
                owner_key: owner_key.map(owner_key_of).transpose()?,
            })
        })
        .collect()
}

/// What keeps a space's commit log from growing without bound. Anyone
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
    space_id: &str,
    incarnation: u64,
    head_epoch: u64,
    limits: PruneLimits,
) -> sqlx::Result<u64> {
    // The newest commit extended `head_epoch - 1`, and always stays.
    let mut gone = 0;
    gone += sqlx::query(
        "DELETE FROM mls_commits
         WHERE space_id = ?1 AND incarnation = ?2 AND epoch < ?3 - ?4",
    )
    .bind(space_id)
    .bind(sql(incarnation))
    .bind(sql(head_epoch))
    .bind(sql(limits.keep_last))
    .execute(pool)
    .await?
    .rows_affected();
    gone += sqlx::query(
        "DELETE FROM mls_commits
         WHERE space_id = ?1 AND incarnation = ?2 AND epoch < ?3 - 1 AND created_at < ?4",
    )
    .bind(space_id)
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
         WHERE space_id = ?1 AND incarnation = ?2 AND epoch < ?3 - 1
           AND epoch IN (
             SELECT epoch FROM (
               SELECT epoch, SUM(LENGTH(data) + COALESCE(LENGTH(envelope), 0))
                        OVER (ORDER BY epoch DESC) AS total
               FROM mls_commits
               WHERE space_id = ?1 AND incarnation = ?2
             ) WHERE total > ?4
           )",
    )
    .bind(space_id)
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
/// incarnation, so of two editors resetting at once only one succeeds. The
/// owner key and the tokens stay: any editor may reset, and must not get to
/// pick who signs the next rotation.
pub async fn reset_group(
    pool: &SqlitePool,
    space_id: &str,
    expected: u64,
    group_id: &[u8],
    group_info: &[u8],
    keyring: &[u8],
) -> sqlx::Result<Reset> {
    let mut tx = pool.begin().await?;
    let done = sqlx::query(
        "UPDATE mls_groups SET incarnation = incarnation + 1, head_epoch = 0, group_id = ?,
           group_info = ?, keyring = ?
         WHERE space_id = ? AND incarnation = ?",
    )
    .bind(group_id)
    .bind(group_info)
    .bind(keyring)
    .bind(space_id)
    .bind(sql(expected))
    .execute(&mut *tx)
    .await?;
    if done.rows_affected() == 0 {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM mls_groups WHERE space_id = ?")
            .bind(space_id)
            .fetch_optional(&mut *tx)
            .await?;
        return Ok(if exists.is_some() {
            Reset::WrongIncarnation
        } else {
            Reset::NoGroup
        });
    }
    sqlx::query("DELETE FROM mls_commits WHERE space_id = ?")
        .bind(space_id)
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
    /// A rotation's new tokens and owner key, and the current owner key's
    /// signature over the whole submission.
    pub rotate: Option<&'a Rotate>,
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
    /// The rotation is not signed with the space's owner key.
    #[error("the rotation is not signed with the owner key")]
    OwnerProof,
    /// A rotation has to move the owner key on, or a removed owner device
    /// would keep one that still signs.
    #[error("the rotation keeps the owner key")]
    SameOwnerKey,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// The commit, its GroupInfo and keyring, and the token swap of a rotation,
/// in one transaction: any failure leaves the space exactly as it was.
///
/// A rotation's owner proof is checked after the epoch, so of two owner
/// devices rotating at once the second hears `Conflict` and follows, rather
/// than `NotOwner` for a key that only just changed. It is checked against
/// the key read inside the transaction, which the epoch's write lock keeps
/// from changing underneath.
pub async fn submit(
    pool: &SqlitePool,
    space_id: &str,
    args: &SubmitArgs<'_>,
) -> Result<Submitted, SubmitError> {
    let mut tx = pool.begin().await?;
    match append_commit(&mut tx, space_id, args).await? {
        Append::Appended => {}
        Append::Conflict { head } => return Ok(Submitted::Conflict { head }),
        Append::NoGroup => return Ok(Submitted::NoGroup),
        Append::WrongIncarnation => return Ok(Submitted::WrongIncarnation),
    }
    let retired = match &args.rotate {
        Some(rotate) => {
            swap_owner_key(&mut tx, space_id, args, rotate).await?;
            Some(
                spaces::rotate_tokens(
                    &mut tx,
                    space_id,
                    &rotate.edit_token,
                    &rotate.view_token,
                    args.epoch,
                )
                .await
                .map_err(|err| match err {
                    RotateError::Db(err) => SubmitError::Db(err),
                    other => SubmitError::Rotate(other),
                })?,
            )
        }
        None => None,
    };
    tx.commit().await?;
    Ok(Submitted::Accepted { retired })
}

/// Checks the owner proof of a rotation that was just appended and moves
/// the owner key on to the one it names.
async fn swap_owner_key(
    conn: &mut SqliteConnection,
    space_id: &str,
    args: &SubmitArgs<'_>,
    rotate: &Rotate,
) -> Result<(), SubmitError> {
    let (group_id, current): (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT group_id, owner_key FROM mls_groups WHERE space_id = ?")
            .bind(space_id)
            .fetch_one(&mut *conn)
            .await?;
    let current = owner_key_of(current)?;
    let claim = RotationClaim {
        group_id: &group_id,
        epoch: args.epoch,
        commit: args.commit,
        group_info: args.group_info,
        keyring: args.keyring.unwrap_or_default(),
        envelope: args.envelope.unwrap_or_default(),
        edit_token: &rotate.edit_token,
        view_token: &rotate.view_token,
        next_owner_key: &rotate.next_owner_key,
    };
    if !verify_rotation(&current, &claim, &rotate.owner_proof) {
        return Err(SubmitError::OwnerProof);
    }
    if rotate.next_owner_key == current {
        return Err(SubmitError::SameOwnerKey);
    }
    let swapped =
        sqlx::query("UPDATE mls_groups SET owner_key = ? WHERE space_id = ? AND owner_key = ?")
            .bind(rotate.next_owner_key.as_slice())
            .bind(space_id)
            .bind(current.as_slice())
            .execute(&mut *conn)
            .await?;
    // Nothing else writes the key inside this transaction, so a miss means
    // the row changed under us; refuse rather than swap tokens on a key
    // that was never checked.
    if swapped.rows_affected() != 1 {
        return Err(SubmitError::OwnerProof);
    }
    Ok(())
}
