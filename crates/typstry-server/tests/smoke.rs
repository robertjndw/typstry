use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use typstry_server::http::{AppState, router};
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::db;

mod common;

#[tokio::test]
async fn healthz_returns_ok() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;
    let app = common::app(AppState::new(pool, BlobStore::new(dir.path())), dir.path());

    let res = app
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(to_bytes(res.into_body(), 1024).await.unwrap(), "ok");
}

#[tokio::test]
async fn spa_fallback_serves_index() {
    let dir = tempfile::tempdir().unwrap();
    let dist = dir.path().join("dist");
    std::fs::create_dir(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>app").unwrap();
    let pool = common::open_db(dir.path()).await;
    let app = router(AppState::new(pool, BlobStore::new(dir.path())), &dist);

    let res = app
        .oneshot(Request::get("/p/sometoken").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(res.into_body(), 1024).await.unwrap(),
        "<!doctype html>app"
    );
}

#[tokio::test]
async fn migrations_create_schema_in_wal_mode() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        tables,
        ["blobs", "doc_records", "project_blobs", "projects"]
    );

    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
}

#[tokio::test]
async fn backup_writes_a_readable_copy() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;
    let state = AppState::new(pool.clone(), BlobStore::new(dir.path()));
    common::create_project(common::app(state, dir.path())).await;

    let dest = dir.path().join("backup.db");
    db::backup(&pool, &dest).await.unwrap();
    // Refuses to overwrite an earlier backup.
    assert!(db::backup(&pool, &dest).await.is_err());

    let copy = db::open(&dest).await.unwrap();
    let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(projects, 1);
    let check: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(check, "ok");
}

#[tokio::test]
async fn create_project_ignores_any_body() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;
    let app = common::app(
        AppState::new(pool.clone(), BlobStore::new(dir.path())),
        dir.path(),
    );
    // No body, an empty object, and a title from an old client that still
    // sends one. The title lives in the encrypted doc, so none of it is read.
    for (content_type, body) in [
        (None, ""),
        (Some("application/json"), "{}"),
        (Some("application/json"), r#"{"title":"Paper"}"#),
    ] {
        let mut req = Request::post("/api/projects");
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED, "{body:?}");
        let created: serde_json::Value =
            serde_json::from_slice(&to_bytes(res.into_body(), 1024).await.unwrap()).unwrap();
        for key in ["projectId", "editToken", "viewToken"] {
            assert_eq!(created[key].as_str().unwrap().len(), 22, "{key}");
        }
    }
    // Nothing is seeded server side; the first client writes the doc.
    let (projects, records): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM projects), (SELECT COUNT(*) FROM doc_records)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((projects, records), (3, 0));
}
