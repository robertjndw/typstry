//! The encrypted record log of space documents.
//!
//! Only the space's room actor writes here, so sequence numbers need no
//! coordination beyond what the actor already tracks in memory.

use axum::body::Bytes;
use sqlx::{Sqlite, SqlitePool, Transaction};

/// Rows per multi-row insert. Three parameters each keeps a statement under
/// the 999 bound parameters older SQLite builds allow.
const INSERT_CHUNK: usize = 300;
/// Sequence numbers per `DELETE ... IN (...)`, for the same reason.
const DELETE_CHUNK: usize = 500;

/// One change to a space's log, applied in order by [`write_batch`].
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

/// Every stored record of the space as `(seq, data)`, in sequence order.
pub async fn load(pool: &SqlitePool, space_id: &str) -> sqlx::Result<Vec<(i64, Vec<u8>)>> {
    sqlx::query_as("SELECT seq, data FROM doc_records WHERE space_id = ? ORDER BY seq")
        .bind(space_id)
        .fetch_all(pool)
        .await
}

/// Applies `writes` in one transaction, so a batch is stored whole or not at
/// all, and a crash can never leave deltas gone without the snapshot that
/// replaced them.
pub async fn write_batch(pool: &SqlitePool, space_id: &str, writes: &[Write]) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    // Appends run together into multi-row inserts; each snapshot is a run
    // of its own, since its deletes must land after what came before it.
    let runs =
        writes.chunk_by(|a, b| matches!((a, b), (Write::Append { .. }, Write::Append { .. })));
    for run in runs {
        match &run[0] {
            Write::Append { .. } => {
                for chunk in run.chunks(INSERT_CHUNK) {
                    insert(&mut tx, space_id, chunk).await?;
                }
            }
            Write::Snapshot { obsolete, .. } => {
                insert(&mut tx, space_id, run).await?;
                delete(&mut tx, space_id, obsolete).await?;
            }
        }
    }
    tx.commit().await
}

async fn insert(
    tx: &mut Transaction<'_, Sqlite>,
    space_id: &str,
    writes: &[Write],
) -> sqlx::Result<()> {
    let mut query = sqlx::QueryBuilder::new("INSERT INTO doc_records (space_id, seq, data) ");
    query.push_values(writes, |mut row, write| {
        let (Write::Append { seq, data } | Write::Snapshot { seq, data, .. }) = write;
        row.push_bind(space_id).push_bind(*seq).push_bind(&data[..]);
    });
    query.build().execute(&mut **tx).await?;
    Ok(())
}

async fn delete(
    tx: &mut Transaction<'_, Sqlite>,
    space_id: &str,
    seqs: &[i64],
) -> sqlx::Result<()> {
    for chunk in seqs.chunks(DELETE_CHUNK) {
        let mut query = sqlx::QueryBuilder::new("DELETE FROM doc_records WHERE space_id = ");
        query.push_bind(space_id).push(" AND seq IN (");
        let mut list = query.separated(", ");
        for seq in chunk {
            list.push_bind(seq);
        }
        query.push(")").build().execute(&mut **tx).await?;
    }
    Ok(())
}

pub async fn record_count(pool: &SqlitePool, space_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_records WHERE space_id = ?")
        .bind(space_id)
        .fetch_one(pool)
        .await
}
