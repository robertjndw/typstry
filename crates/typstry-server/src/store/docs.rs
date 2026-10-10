//! The encrypted record log of project documents.
//!
//! Only the project's room actor writes here, so sequence numbers need no
//! coordination beyond what the actor already tracks in memory.

use axum::body::Bytes;
use sqlx::{Sqlite, SqlitePool, Transaction};

/// Rows per multi-row insert. Three parameters each keeps a statement under
/// the 999 bound parameters older SQLite builds allow.
const INSERT_CHUNK: usize = 300;
/// Sequence numbers per `DELETE ... IN (...)`, for the same reason.
const DELETE_CHUNK: usize = 500;

/// One change to a project's log, applied in order by [`write_batch`].
#[derive(Debug, Clone)]
pub enum Write {
    Append {
        seq: i64,
        data: Bytes,
    },
    /// Stores a snapshot and drops the records it makes redundant, which
    /// may include records appended earlier in the same batch.
    Snapshot {
        seq: i64,
        data: Bytes,
        obsolete: Vec<i64>,
    },
}

/// Every stored record of the project as `(seq, data)`, in sequence order.
pub async fn load(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<(i64, Vec<u8>)>> {
    sqlx::query_as("SELECT seq, data FROM doc_records WHERE project_id = ? ORDER BY seq")
        .bind(project_id)
        .fetch_all(pool)
        .await
}

/// Applies `writes` in one transaction, so a batch is stored whole or not at
/// all, and a crash can never leave deltas gone without the snapshot that
/// replaced them.
pub async fn write_batch(
    pool: &SqlitePool,
    project_id: &str,
    writes: &[Write],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let mut rest = writes;
    while let Some(first) = rest.first() {
        match first {
            Write::Append { .. } => {
                let run = rest
                    .iter()
                    .take_while(|write| matches!(write, Write::Append { .. }))
                    .count();
                for chunk in rest[..run].chunks(INSERT_CHUNK) {
                    insert(&mut tx, project_id, chunk).await?;
                }
                rest = &rest[run..];
            }
            Write::Snapshot { obsolete, .. } => {
                insert(&mut tx, project_id, &rest[..1]).await?;
                delete(&mut tx, project_id, obsolete).await?;
                rest = &rest[1..];
            }
        }
    }
    tx.commit().await
}

async fn insert(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    writes: &[Write],
) -> sqlx::Result<()> {
    let mut query = sqlx::QueryBuilder::new("INSERT INTO doc_records (project_id, seq, data) ");
    query.push_values(writes, |mut row, write| {
        let (Write::Append { seq, data } | Write::Snapshot { seq, data, .. }) = write;
        row.push_bind(project_id)
            .push_bind(*seq)
            .push_bind(&data[..]);
    });
    query.build().execute(&mut **tx).await?;
    Ok(())
}

async fn delete(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
    seqs: &[i64],
) -> sqlx::Result<()> {
    for chunk in seqs.chunks(DELETE_CHUNK) {
        let mut query = sqlx::QueryBuilder::new("DELETE FROM doc_records WHERE project_id = ");
        query.push_bind(project_id).push(" AND seq IN (");
        let mut list = query.separated(", ");
        for seq in chunk {
            list.push_bind(seq);
        }
        query.push(")").build().execute(&mut **tx).await?;
    }
    Ok(())
}

pub async fn record_count(pool: &SqlitePool, project_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_records WHERE project_id = ?")
        .bind(project_id)
        .fetch_one(pool)
        .await
}
