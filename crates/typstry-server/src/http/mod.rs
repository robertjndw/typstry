pub mod assets;
pub mod projects;

use std::path::Path;
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use axum::routing::{get, post};
use sqlx::SqlitePool;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::room::{RoomConfig, RoomRegistry};
use crate::store::blobs::BlobStore;
use crate::ws::{self, ConnLimits};

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub rooms: RoomRegistry,
    pub blobs: BlobStore,
    pub limits: ConnLimits,
}

impl AppState {
    pub fn new(db: SqlitePool, blobs: BlobStore) -> Self {
        Self::with_room_config(db, blobs, RoomConfig::default())
    }

    pub fn with_room_config(db: SqlitePool, blobs: BlobStore, config: RoomConfig) -> Self {
        let rooms = RoomRegistry::new(db.clone(), config);
        Self {
            db,
            rooms,
            blobs,
            limits: ConnLimits::default(),
        }
    }
}

/// Logs an unexpected failure; the client only learns that it was ours.
/// The trace layer's span already says which request it was.
fn internal(err: impl std::fmt::Display) -> StatusCode {
    tracing::error!(%err, "request failed");
    StatusCode::INTERNAL_SERVER_ERROR
}

/// Small database lookups; anything slower than this is stuck.
const API_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router(state: AppState, web_dist: &Path) -> Router {
    let api = Router::new()
        .route("/api/projects", post(projects::create))
        .route("/api/share/{token}", get(projects::share))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::SERVICE_UNAVAILABLE,
            API_TIMEOUT,
        ));
    // Uploads get no timeout: a 25 MB body on a slow link legitimately
    // takes minutes, and the size cap already bounds what one can cost.
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .merge(api)
        .route("/api/p/{token}/assets", post(assets::upload))
        .route("/api/p/{token}/blobs/{hash}", get(assets::blob))
        .route("/ws", get(ws::handler));

    // In dev the Vite server serves the frontend, so a missing dist is normal.
    if web_dist.is_dir() {
        let index = web_dist.join("index.html");
        app = app.fallback_service(ServeDir::new(web_dist).fallback(ServeFile::new(index)));
    } else {
        tracing::info!(path = %web_dist.display(), "web dist not found, static serving disabled");
    }

    app.layer(TraceLayer::new_for_http()).with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}
