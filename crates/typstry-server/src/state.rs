use std::time::Duration;

use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::config::Config;
use crate::http::Csp;
use crate::http::git::GitRelay;
use crate::limits::ConnCeiling;
use crate::relay::RelayRegistry;
use crate::room::RoomRegistry;
use crate::store::blobs::BlobStore;
use crate::ws::ConnLimits;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub rooms: RoomRegistry,
    pub blobs: BlobStore,
    pub limits: ConnLimits,
    pub relay: RelayRegistry,
    /// Caps open WebSockets across all clients.
    pub conns: ConnCeiling,
    /// Outbound client and settings for the Git import relay.
    pub git: GitRelay,
    /// Content security policies for the app's pages.
    pub csp: Csp,
    /// Cancelled when the server starts shutting down; open WebSockets
    /// close with "going away" so clients reconnect elsewhere or later.
    pub shutdown: CancellationToken,
    /// Every open WebSocket connection.
    pub connections: TaskTracker,
}

impl AppState {
    /// State with the default limits, for tests and embedding.
    pub fn new(db: SqlitePool, blobs: BlobStore) -> Self {
        Self::build(db, blobs, &Config::default())
    }

    pub fn from_config(db: SqlitePool, config: &Config) -> Self {
        let blobs = BlobStore::new(&config.data_dir)
            .with_max_size(config.max_upload_bytes)
            .with_space_quota(config.space_quota_bytes);
        Self::build(db, blobs, config)
    }

    fn build(db: SqlitePool, blobs: BlobStore, config: &Config) -> Self {
        let shutdown = CancellationToken::new();
        let relay = RelayRegistry::new(config.relay.clone());
        relay.spawn_sweeper(shutdown.clone());
        Self {
            rooms: RoomRegistry::new(db.clone(), config.rooms.clone()),
            db,
            blobs,
            limits: config.limits.clone(),
            relay,
            conns: ConnCeiling::new(config.max_connections),
            git: GitRelay::new(&config.git),
            csp: Csp::new(&config.font_origins),
            shutdown,
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
