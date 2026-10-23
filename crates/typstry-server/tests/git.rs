//! The Git import relay against a local upstream, and `/api/templates`.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::Request as AxumRequest;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::any;
use tower::ServiceExt;
use typstry_server::config::Config;
use typstry_server::http::git::{GitConfig, GitRelay, Template};
use typstry_server::http::{AppState, router};

const ADVERTISEMENT: &str = "application/x-git-upload-pack-advertisement";
const RESULT: &str = "application/x-git-upload-pack-result";

/// Method, path with query, headers and body of a request the upstream got.
type Received = (Method, String, HeaderMap, Bytes);

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Received>>>);

impl Seen {
    fn last(&self) -> Received {
        self.0.lock().unwrap().last().cloned().expect("a request")
    }
}

async fn upstream(req: AxumRequest, seen: Seen) -> Response {
    let (parts, body) = req.into_parts();
    let body = to_bytes(body, 1 << 20).await.unwrap();
    let path = parts.uri.path_and_query().unwrap().to_string();
    seen.0.lock().unwrap().push((
        parts.method.clone(),
        path.clone(),
        parts.headers.clone(),
        body.clone(),
    ));
    let typed = |ct: &'static str, body: Body| ([(header::CONTENT_TYPE, ct)], body).into_response();
    match parts.uri.path() {
        "/o/ok.git/info/refs" => {
            typed(ADVERTISEMENT, Body::from("001e# service=git-upload-pack\n"))
        }
        "/o/ok.git/git-upload-pack" => typed(RESULT, Body::from(body)),
        "/o/big.git/info/refs" => typed(ADVERTISEMENT, Body::from(vec![b'x'; 100])),
        "/o/chunked.git/info/refs" => {
            let chunks = (0..10).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 10])));
            typed(
                ADVERTISEMENT,
                Body::from_stream(futures_util::stream::iter(chunks)),
            )
        }
        "/o/html.git/info/refs" => typed("text/html", Body::from("<script>1</script>")),
        "/o/private.git/info/refs" => StatusCode::UNAUTHORIZED.into_response(),
        "/o/missing.git/info/refs" => StatusCode::NOT_FOUND.into_response(),
        "/o/broken.git/info/refs" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "/o/moved.git/info/refs" => Redirect::temporary("/o/ok.git/info/refs").into_response(),
        "/o/loop.git/info/refs" => Redirect::temporary("/o/loop.git/info/refs").into_response(),
        "/o/away.git/info/refs" => {
            let port = parts.headers[header::HOST]
                .to_str()
                .unwrap()
                .split(':')
                .nth(1)
                .unwrap();
            Redirect::temporary(&format!("http://localhost:{port}/o/ok.git/info/refs"))
                .into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

struct Fixture {
    app: Router,
    seen: Seen,
    /// `127.0.0.1:<port>` of the upstream.
    host: String,
    _dir: tempfile::TempDir,
}

/// The app with a relay that may reach the local upstream over http, which
/// the real one never can.
async fn fixture(git: GitConfig) -> Fixture {
    let seen = Seen::default();
    let handler = seen.clone();
    let upstream = Router::new().fallback(any(move |req| upstream(req, handler.clone())));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: dir.path().to_owned(),
        git: git.clone(),
        ..Config::default()
    };
    let mut state = AppState::from_config(common::open_db(dir.path()).await, &config);
    state.git = GitRelay::new(&git).allow_local_http();
    Fixture {
        app: router(state, &dir.path().join("no-dist")),
        seen,
        host,
        _dir: dir,
    }
}

async fn status(app: &Router, req: Request<Body>) -> StatusCode {
    app.clone().oneshot(req).await.unwrap().status()
}

fn refs(host: &str, repo: &str) -> Request<Body> {
    Request::get(format!(
        "/api/git/{host}/o/{repo}/info/refs?service=git-upload-pack"
    ))
    .body(Body::empty())
    .unwrap()
}

#[tokio::test]
async fn forwards_the_advertisement_with_filtered_headers() {
    let f = fixture(GitConfig::default()).await;
    let req = Request::get(format!(
        "/api/git/{}/o/ok.git/info/refs?service=git-upload-pack",
        f.host
    ))
    .header(header::ACCEPT, "*/*")
    .header(
        header::CONTENT_TYPE,
        "application/x-git-upload-pack-request",
    )
    .header("git-protocol", "version=2")
    .header(header::COOKIE, "session=secret")
    .header(header::AUTHORIZATION, "Bearer secret")
    .header(header::USER_AGENT, "browser/1")
    .header("x-forwarded-for", "9.9.9.9")
    .body(Body::empty())
    .unwrap();
    let res = f.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], ADVERTISEMENT);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!res.headers().contains_key(header::SET_COOKIE));
    assert_eq!(
        to_bytes(res.into_body(), 1 << 20).await.unwrap(),
        "001e# service=git-upload-pack\n"
    );

    let (method, path, headers, _) = f.seen.last();
    assert_eq!(method, Method::GET);
    assert_eq!(path, "/o/ok.git/info/refs?service=git-upload-pack");
    assert_eq!(headers[header::ACCEPT], "*/*");
    assert_eq!(headers["git-protocol"], "version=2");
    assert!(
        headers[header::USER_AGENT]
            .to_str()
            .unwrap()
            .starts_with("typstry/")
    );
    for dropped in [header::COOKIE, header::AUTHORIZATION] {
        assert!(!headers.contains_key(&dropped), "{dropped}");
    }
    assert!(!headers.contains_key("x-forwarded-for"));
}

#[tokio::test]
async fn forwards_upload_pack_posts() {
    let f = fixture(GitConfig::default()).await;
    let req = Request::post(format!("/api/git/{}/o/ok.git/git-upload-pack", f.host))
        .header(
            header::CONTENT_TYPE,
            "application/x-git-upload-pack-request",
        )
        .header(header::COOKIE, "session=secret")
        .body(Body::from("0032want abc\n"))
        .unwrap();
    let res = f.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], RESULT);
    assert_eq!(
        to_bytes(res.into_body(), 1 << 20).await.unwrap(),
        "0032want abc\n"
    );

    let (method, _, headers, body) = f.seen.last();
    assert_eq!(method, Method::POST);
    assert_eq!(body, "0032want abc\n");
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "application/x-git-upload-pack-request"
    );
    assert!(!headers.contains_key(header::COOKIE));

    let big = Request::post(format!("/api/git/{}/o/ok.git/git-upload-pack", f.host))
        .body(Body::from(vec![0u8; (1 << 20) + 1]))
        .unwrap();
    assert_eq!(status(&f.app, big).await, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn only_upload_pack_is_relayed() {
    let f = fixture(GitConfig::default()).await;
    let h = &f.host;
    let get = |uri: String| Request::get(uri).body(Body::empty()).unwrap();
    let post = |uri: String| Request::post(uri).body(Body::empty()).unwrap();
    for req in [
        get(format!(
            "/api/git/{h}/o/ok.git/info/refs?service=git-receive-pack"
        )),
        get(format!("/api/git/{h}/o/ok.git/info/refs")),
        post(format!("/api/git/{h}/o/ok.git/git-receive-pack")),
        post(format!(
            "/api/git/{h}/o/ok.git/info/refs?service=git-upload-pack"
        )),
        get(format!("/api/git/{h}/o/ok.git/git-upload-pack")),
        get(format!("/api/git/{h}/o/ok.git/HEAD")),
    ] {
        let uri = req.uri().to_string();
        assert_eq!(status(&f.app, req).await, StatusCode::NOT_FOUND, "{uri}");
    }
    assert!(
        f.seen.0.lock().unwrap().is_empty(),
        "nothing reached the upstream"
    );
    assert_eq!(
        status(
            &f.app,
            get(format!(
                "/api/git/{h}/../x/info/refs?service=git-upload-pack"
            ))
        )
        .await,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn upstream_failures_map_to_statuses() {
    let f = fixture(GitConfig::default()).await;
    for (repo, expected) in [
        ("missing.git", StatusCode::NOT_FOUND),
        // A private repo looks like a missing one.
        ("private.git", StatusCode::NOT_FOUND),
        ("broken.git", StatusCode::BAD_GATEWAY),
        ("html.git", StatusCode::BAD_GATEWAY),
        ("moved.git", StatusCode::OK),
        ("loop.git", StatusCode::BAD_GATEWAY),
    ] {
        assert_eq!(
            status(&f.app, refs(&f.host, repo)).await,
            expected,
            "{repo}"
        );
    }
    // Nothing listens there.
    assert_eq!(
        status(&f.app, refs("127.0.0.1:1", "ok.git")).await,
        StatusCode::BAD_GATEWAY
    );
}

#[tokio::test]
async fn caps_the_response_size() {
    let f = fixture(GitConfig {
        max_bytes: 50,
        ..GitConfig::default()
    })
    .await;
    assert_eq!(
        status(&f.app, refs(&f.host, "big.git")).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    // Without a length up front the status is already sent; the body breaks.
    let res = f
        .app
        .clone()
        .oneshot(refs(&f.host, "chunked.git"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(to_bytes(res.into_body(), 1 << 20).await.is_err());
    assert_eq!(
        status(&f.app, refs(&f.host, "ok.git")).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn hosts_must_be_on_the_allowlist() {
    let f = fixture(GitConfig {
        hosts: vec!["example.com".into()],
        ..GitConfig::default()
    })
    .await;
    assert_eq!(
        status(&f.app, refs(&f.host, "ok.git")).await,
        StatusCode::FORBIDDEN
    );
    assert!(f.seen.0.lock().unwrap().is_empty());

    // A redirect to another host is held to the list too.
    let ip = f.host.split(':').next().unwrap().to_owned();
    let f = fixture(GitConfig {
        hosts: vec![ip],
        ..GitConfig::default()
    })
    .await;
    assert_eq!(
        status(&f.app, refs(&f.host, "ok.git")).await,
        StatusCode::OK
    );
    assert_eq!(
        status(&f.app, refs(&f.host, "away.git")).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn the_real_relay_refuses_local_addresses() {
    let f = fixture(GitConfig::default()).await;
    let dir = tempfile::tempdir().unwrap();
    let config = Config::default();
    let state = AppState::from_config(common::open_db(dir.path()).await, &config);
    let app = router(state, &dir.path().join("no-dist"));
    let port = f.host.split(':').nth(1).unwrap();
    for host in [
        f.host.clone(),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
        "169.254.169.254".into(),
        "10.0.0.1".into(),
    ] {
        assert_eq!(
            status(&app, refs(&host, "ok.git")).await,
            StatusCode::FORBIDDEN,
            "{host}"
        );
    }
    assert!(f.seen.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn disabled_means_no_relay_and_no_templates() {
    let templates = vec![Template {
        name: "T".into(),
        description: None,
        url: "https://github.com/o/r".into(),
        r#ref: None,
        path: None,
    }];
    let f = fixture(GitConfig {
        enabled: false,
        templates,
        ..GitConfig::default()
    })
    .await;
    assert_eq!(
        status(&f.app, refs(&f.host, "ok.git")).await,
        StatusCode::FORBIDDEN
    );
    let res = f
        .app
        .clone()
        .oneshot(Request::get("/api/templates").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        common::json(res).await,
        serde_json::json!({"gitImport": false, "templates": []})
    );
}

#[tokio::test]
async fn lists_the_configured_templates() {
    let f = fixture(GitConfig {
        templates: vec![
            Template {
                name: "Thesis".into(),
                description: Some("A thesis".into()),
                url: "https://github.com/o/r".into(),
                r#ref: Some("v1".into()),
                path: Some("a/b".into()),
            },
            Template {
                name: "Bare".into(),
                description: None,
                url: "https://gitlab.com/o/r".into(),
                r#ref: None,
                path: None,
            },
        ],
        ..GitConfig::default()
    })
    .await;
    let res = f
        .app
        .clone()
        .oneshot(Request::get("/api/templates").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        common::json(res).await,
        serde_json::json!({
            "gitImport": true,
            "templates": [
                {"name": "Thesis", "description": "A thesis", "url": "https://github.com/o/r", "ref": "v1", "path": "a/b"},
                {"name": "Bare", "url": "https://gitlab.com/o/r"},
            ],
        })
    );
}
