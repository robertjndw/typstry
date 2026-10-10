use std::time::Duration;

use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::config::Config;
use crate::room::{RoomConfig, RoomRegistry};
use crate::store::blobs::BlobStore;
use crate::ws::ConnLimits;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub rooms: RoomRegistry,
    pub blobs: BlobStore,
    pub limits: ConnLimits,
    /// Cancelled when the server starts shutting down; open WebSockets
    /// close with "going away" so clients reconnect elsewhere or later.
    pub shutdown: CancellationToken,
    /// Every open WebSocket connection.
    pub connections: TaskTracker,
}

impl AppState {
    /// State with the default limits, for tests and embedding.
    pub fn new(db: SqlitePool, blobs: BlobStore) -> Self {
        Self::build(db, blobs, RoomConfig::default(), ConnLimits::default())
    }

    pub fn from_config(db: SqlitePool, config: &Config) -> Self {
        let blobs = BlobStore::new(&config.data_dir).with_max_size(config.max_upload_bytes);
        Self::build(db, blobs, config.rooms.clone(), config.limits.clone())
    }

    fn build(db: SqlitePool, blobs: BlobStore, rooms: RoomConfig, limits: ConnLimits) -> Self {
        Self {
            rooms: RoomRegistry::new(db.clone(), rooms),
            db,
            blobs,
            limits,
            shutdown: CancellationToken::new(),
            connections: TaskTracker::new(),
        }
    }

    /// Closes every WebSocket, giving them up to `grace` to say goodbye,
    /// then stops the rooms. Connections go first so no update reaches a
    /// room after it stopped; what they already queued is still handled.
    pub async fn stop(&self, grace: Duration) {
        self.shutdown.cancel();
        self.connections.close();
        if tokio::time::timeout(grace, self.connections.wait())
            .await
            .is_err()
        {
            tracing::warn!(
                open = self.connections.len(),
                "connections still open after the grace period"
            );
        }
        self.rooms.shutdown().await;
    }
}
