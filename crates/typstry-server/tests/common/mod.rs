//! Setup shared by the integration tests.

// Each test crate compiles its own copy and uses a different subset.
#![allow(dead_code)]

use std::path::Path;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use sqlx::SqlitePool;
use tower::ServiceExt;
use typstry_server::http::{AppState, router};
use typstry_server::store::db;

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

pub async fn create_project(app: Router) -> Created {
    let res = app
        .oneshot(Request::post("/api/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    let field = |key: &str| body[key].as_str().unwrap().to_owned();
    Created {
        id: field("projectId"),
        edit: field("editToken"),
        view: field("viewToken"),
    }
}
