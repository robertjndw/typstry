//! The encrypted record log of project documents.
//!
//! Only the project's room actor writes here, so sequence numbers need no
//! coordination beyond what the actor already tracks in memory.

use sqlx::SqlitePool;

/// Every stored record of the project as `(seq, data)`, in sequence order.
pub async fn load(pool: &SqlitePool, project_id: &str) -> sqlx::Result<Vec<(i64, Vec<u8>)>> {
    sqlx::query_as("SELECT seq, data FROM doc_records WHERE project_id = ? ORDER BY seq")
        .bind(project_id)
        .fetch_all(pool)
        .await
}

pub async fn append(
    pool: &SqlitePool,
    project_id: &str,
    seq: i64,
    data: &[u8],
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO doc_records (project_id, seq, data) VALUES (?, ?, ?)")
        .bind(project_id)
        .bind(seq)
        .bind(data)
        .execute(pool)
        .await?;
    Ok(())
}

/// Stores a snapshot and drops the records it makes redundant. One
/// transaction, so a crash can never leave the deltas gone without the
/// snapshot that replaced them.
pub async fn replace_with_snapshot(
    pool: &SqlitePool,
    project_id: &str,
    seq: i64,
    snapshot: &[u8],
    obsolete: &[i64],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO doc_records (project_id, seq, data) VALUES (?, ?, ?)")
        .bind(project_id)
        .bind(seq)
        .bind(snapshot)
        .execute(&mut *tx)
        .await?;
    // Chunked to stay well under SQLite's bound-parameter limit.
    for chunk in obsolete.chunks(500) {
        let mut query = sqlx::QueryBuilder::new("DELETE FROM doc_records WHERE project_id = ");
        query.push_bind(project_id).push(" AND seq IN (");
        let mut seqs = query.separated(", ");
        for seq in chunk {
            seqs.push_bind(seq);
        }
        query.push(")").build().execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn record_count(pool: &SqlitePool, project_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_records WHERE project_id = ?")
        .bind(project_id)
        .fetch_one(pool)
        .await
}
