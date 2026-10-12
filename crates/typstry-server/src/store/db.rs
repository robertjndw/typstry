use std::path::Path;
use std::time::Duration;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

pub async fn open(path: &Path) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // NORMAL is durable enough under WAL: a crash can only lose the last
        // commits, never corrupt the database, and clients resend updates.
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new().connect_with(options).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// Writes a consistent copy of the whole database to `dest`, which must not
/// exist yet. Safe while the server runs: `VACUUM INTO` reads inside one
/// transaction, and WAL mode keeps writers going meanwhile.
///
/// This covers spaces, documents and blob metadata but not the blob files
/// under `<data>/blobs`. Those are content-addressed and never modified, so
/// a plain `cp -R` or `rsync` of that directory is a valid backup. Copy it
/// after the database: a blob file is written before its row, so every hash
/// the database copy mentions is then already on disk.
pub async fn backup(pool: &SqlitePool, dest: &Path) -> anyhow::Result<()> {
    if dest.exists() {
        anyhow::bail!("{} already exists", dest.display());
    }
    let dest = dest
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("backup path must be valid UTF-8"))?;
    sqlx::query("VACUUM INTO ?")
        .bind(dest)
        .execute(pool)
        .await?;
    Ok(())
}
