//! Content-addressed blob store for uploaded assets. Files live on disk at
//! `<data>/blobs/ab/cd/<hex>`; the `blobs` and `space_blobs` tables hold
//! their metadata and which spaces may read them.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tempfile::TempPath;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::token;

pub const DEFAULT_MAX_SIZE: u64 = 25 * 1024 * 1024;
const HASH_PREFIX: &str = "sha256:";
/// Scratch files older than this belong to no running upload.
const STALE_UPLOAD_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone)]
pub struct BlobStore {
    data_dir: PathBuf,
    max_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBlob {
    /// Lowercase hex SHA-256, without the `sha256:` prefix.
    pub hex: String,
    pub size: u64,
}

impl StoredBlob {
    pub fn hash(&self) -> String {
        format!("{HASH_PREFIX}{}", self.hex)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("blob exceeds {0} bytes")]
    TooLarge(u64),
    #[error("reading the upload failed: {0}")]
    Body(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl BlobStore {
    /// Also clears out uploads a crash or kill left half-written.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        let store = Self {
            data_dir: data_dir.into(),
            max_size: DEFAULT_MAX_SIZE,
        };
        store.clear_stale_uploads(STALE_UPLOAD_AGE);
        store
    }

    /// Only files untouched for `age` go: during a rolling restart another
    /// server may share this data dir and be in the middle of an upload,
    /// and a live upload writes to its file far more often than that.
    fn clear_stale_uploads(&self, age: Duration) {
        let tmp_dir = self.tmp_dir();
        let entries = match std::fs::read_dir(&tmp_dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return,
            Err(err) => {
                tracing::warn!(%err, path = %tmp_dir.display(), "could not list stale uploads");
                return;
            }
        };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| {
                    now.duration_since(modified)
                        .is_ok_and(|elapsed| elapsed >= age)
                });
            if stale && let Err(err) = std::fs::remove_file(entry.path()) {
                tracing::warn!(%err, path = %entry.path().display(), "could not clear stale upload");
            }
        }
    }

    pub fn with_max_size(mut self, max_size: u64) -> Self {
        self.max_size = max_size;
        self
    }

    pub fn max_size(&self) -> u64 {
        self.max_size
    }

    /// Scratch space on the same file system as the blobs, so finished
    /// uploads can be renamed into place.
    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    /// Where the blob with this hex digest lives. Callers must pass a value
    /// that went through [`parse_hash`] or came from [`Self::write`].
    pub fn path(&self, hex: &str) -> PathBuf {
        self.data_dir
            .join("blobs")
            .join(&hex[0..2])
            .join(&hex[2..4])
            .join(hex)
    }

    /// Streams `body` into the store, hashing as it goes. Identical content
    /// ends up in one file no matter how often it is uploaded.
    pub async fn write<S, E>(&self, body: S) -> Result<StoredBlob, WriteError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: std::fmt::Display,
    {
        let tmp_dir = self.tmp_dir();
        fs::create_dir_all(&tmp_dir).await?;
        // Deleted on drop unless it made it into the store. Drop also runs
        // when the request is cancelled mid-upload, which no error path
        // would see.
        let tmp = TempPath::try_from_path(tmp_dir.join(format!("upload-{}", token::generate())))?;
        let stored = self.write_tmp(&tmp, body).await?;
        // Renamed into the store or already removed by now.
        tmp.keep().map_err(io::Error::from)?;
        Ok(stored)
    }

    async fn write_tmp<S, E>(&self, tmp: &Path, mut body: S) -> Result<StoredBlob, WriteError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: std::fmt::Display,
    {
        let mut file = fs::File::create(tmp).await?;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|err| WriteError::Body(err.to_string()))?;
            size += chunk.len() as u64;
            // Checked per chunk so an oversized upload is cut off right away
            // instead of being spooled to disk first.
            if size > self.max_size {
                return Err(WriteError::TooLarge(self.max_size));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        drop(file);

        let hex = to_hex(&hasher.finalize());
        let target = self.path(&hex);
        if fs::try_exists(&target).await? {
            fs::remove_file(tmp).await?;
        } else {
            fs::create_dir_all(target.parent().expect("blob path has a parent")).await?;
            // Two concurrent uploads of the same content may both get here;
            // rename replaces atomically and the bytes are identical anyway.
            fs::rename(tmp, &target).await?;
        }
        Ok(StoredBlob { hex, size })
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xf) as usize] as char);
    }
    out
}

/// Accepts exactly `sha256:` followed by 64 lowercase hex digits and returns
/// the digits. This is what keeps request input out of filesystem paths.
pub fn parse_hash(hash: &str) -> Option<&str> {
    let hex = hash.strip_prefix(HASH_PREFIX)?;
    (hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(hex)
}

/// Registers the blob and grants `space_id` access to it.
pub async fn record(pool: &SqlitePool, space_id: &str, hash: &str, size: u64) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .bind(hash)
        .bind(size as i64)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO space_blobs (space_id, hash) VALUES (?, ?)")
        .bind(space_id)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// The blob's size, or None when the space has no access to it.
pub async fn lookup(pool: &SqlitePool, space_id: &str, hash: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar(
        "SELECT b.size FROM space_blobs pb JOIN blobs b ON b.hash = pb.hash \
         WHERE pb.space_id = ? AND pb.hash = ?",
    )
    .bind(space_id)
    .bind(hash)
    .fetch_optional(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_canonical_hashes() {
        let hex = "a".repeat(64);
        assert_eq!(parse_hash(&format!("sha256:{hex}")), Some(hex.as_str()));
        assert_eq!(parse_hash(&hex), None);
        assert_eq!(parse_hash(&format!("sha256:{}", "A".repeat(64))), None);
        assert_eq!(parse_hash(&format!("sha256:{}", "a".repeat(63))), None);
        assert_eq!(parse_hash("sha256:../../../../etc/passwd"), None);
    }

    #[tokio::test]
    async fn failed_and_cancelled_uploads_leave_no_scratch_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).with_max_size(4);
        let body =
            futures_util::stream::iter([Ok::<_, io::Error>(Bytes::from_static(b"too long"))]);
        assert!(matches!(
            store.write(body).await,
            Err(WriteError::TooLarge(4))
        ));

        // A body that never ends, dropped mid-upload like a cancelled request.
        let pending = futures_util::stream::iter([Ok::<_, io::Error>(Bytes::from_static(b"ab"))])
            .chain(futures_util::stream::pending());
        let upload = store.write(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), upload)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(store.tmp_dir()).unwrap().count(), 0);

        let stored = store
            .write(futures_util::stream::iter([Ok::<_, io::Error>(
                Bytes::from_static(b"ok"),
            )]))
            .await
            .unwrap();
        assert!(store.path(&stored.hex).is_file());
        assert_eq!(std::fs::read_dir(store.tmp_dir()).unwrap().count(), 0);
    }

    #[test]
    fn new_clears_only_stale_uploads() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let stale = tmp.join("upload-stale");
        std::fs::write(&stale, b"half").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::now() - STALE_UPLOAD_AGE - Duration::from_secs(60))
            .unwrap();
        // Another server on the same data dir could be writing this one.
        let live = tmp.join("upload-live");
        std::fs::write(&live, b"half").unwrap();

        BlobStore::new(dir.path());
        assert!(!stale.exists());
        assert!(live.exists());
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(to_hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
