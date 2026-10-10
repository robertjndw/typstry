//! Protocol versions: outdated clients get a 426 instead of odd failures.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Error as WsError;
use tower::ServiceExt;
use typstry_server::http::AppState;
use typstry_server::store::blobs::BlobStore;
use typstry_wire::{MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION};

mod common;

const TOO_OLD: u32 = MIN_PROTOCOL_VERSION - 1;

async fn json(res: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(res.into_body(), 4096).await.unwrap()).unwrap()
}

#[tokio::test]
async fn info_names_the_versions() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;
    let app = common::app(AppState::new(pool, BlobStore::new(dir.path())), dir.path());

    // Even a client that is too old may ask.
    let res = app
        .oneshot(
            Request::get("/api/info")
                .header(PROTOCOL_HEADER, TOO_OLD)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = json(res).await;
    assert_eq!(body["protocol"], PROTOCOL_VERSION);
    assert_eq!(body["minProtocol"], MIN_PROTOCOL_VERSION);
}

#[tokio::test]
async fn the_api_refuses_outdated_clients() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;
    let app = common::app(AppState::new(pool, BlobStore::new(dir.path())), dir.path());
    let created = common::create_project(app.clone()).await;
    let share = format!("/api/share/{}", created.edit);

    let get = |version: Option<&str>| {
        let mut req = Request::get(&share);
        if let Some(v) = version {
            req = req.header(PROTOCOL_HEADER, v);
        }
        app.clone().oneshot(req.body(Body::empty()).unwrap())
    };

    let res = get(Some(&TOO_OLD.to_string())).await.unwrap();
    assert_eq!(res.status(), StatusCode::UPGRADE_REQUIRED);
    let body = json(res).await;
    assert!(
        body["error"].as_str().unwrap().contains("upgrade"),
        "{body}"
    );
    assert_eq!(body["minProtocol"], MIN_PROTOCOL_VERSION);

    for ok in [Some(PROTOCOL_VERSION.to_string()), None] {
        let res = get(ok.as_deref()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{ok:?}");
    }
    // Newer clients are let through; keeping up with them is our job.
    let res = get(Some(&(PROTOCOL_VERSION + 1).to_string()))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = get(Some("one")).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Health checks never send a version and never get refused.
    let res = app
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn the_websocket_refuses_outdated_clients() {
    let dir = tempfile::tempdir().unwrap();
    let pool = common::open_db(dir.path()).await;
    let app = common::app(AppState::new(pool, BlobStore::new(dir.path())), dir.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    match connect_async(format!("ws://{addr}/ws?protocol={TOO_OLD}")).await {
        Err(WsError::Http(res)) => {
            assert_eq!(res.status(), StatusCode::UPGRADE_REQUIRED);
            let body: Value = serde_json::from_slice(res.body().as_deref().unwrap()).unwrap();
            assert_eq!(body["minProtocol"], MIN_PROTOCOL_VERSION);
        }
        other => panic!("expected a 426, got {other:?}"),
    }

    for query in [format!("?protocol={PROTOCOL_VERSION}"), String::new()] {
        let (mut ws, _) = connect_async(format!("ws://{addr}/ws{query}"))
            .await
            .unwrap();
        ws.close(None).await.unwrap();
    }
}
