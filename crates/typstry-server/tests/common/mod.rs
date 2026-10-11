//! Setup shared by the integration tests.

// Each test crate compiles its own copy and uses a different subset.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::response::Response;
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;
use tower::ServiceExt;
use typstry_server::config::Config;
use typstry_server::http::{AppState, router};
use typstry_server::room::RoomConfig;
use typstry_server::store::db;
use typstry_server::ws::ConnLimits;

pub struct Created {
    pub id: String,
    pub edit: String,
    pub view: String,
}

pub async fn open_db(dir: &Path) -> SqlitePool {
    db::open(&dir.join("test.db")).await.unwrap()
}

/// The app without a web build, which the API and WebSocket do not need.
pub fn app(state: AppState, dir: &Path) -> Router {
    router(state, &dir.join("no-dist"))
}

pub struct Served {
    pub addr: SocketAddr,
    pub state: AppState,
    pub task: JoinHandle<()>,
}

/// The app on a free local port, for tests that need a real socket.
pub async fn serve(data: &Path, rooms: RoomConfig, limits: ConnLimits) -> Served {
    let pool = open_db(data).await;
    let config = Config {
        data_dir: data.to_owned(),
        rooms,
        limits,
        ..Config::default()
    };
    let state = AppState::from_config(pool, &config);
    let app = app(state.clone(), data);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Served { addr, state, task }
}

pub async fn json(res: Response) -> Value {
    serde_json::from_slice(&to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap()
}

pub async fn create_project(app: Router) -> Created {
    let res = app
        .oneshot(Request::post("/api/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = json(res).await;
    let field = |key: &str| body[key].as_str().unwrap().to_owned();
    Created {
        id: field("projectId"),
        edit: field("editToken"),
        view: field("viewToken"),
    }
}
