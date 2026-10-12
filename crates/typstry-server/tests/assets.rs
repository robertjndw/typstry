use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use tempfile::TempDir;
use tower::ServiceExt;
use typstry_server::http::AppState;
use typstry_server::store::blobs::BlobStore;

mod common;

use common::json;

struct Harness {
    dir: TempDir,
    state: AppState,
}

struct Space {
    edit: String,
    view: String,
}

impl Harness {
    async fn new(max_size: Option<u64>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pool = common::open_db(dir.path()).await;
        let mut blobs = BlobStore::new(dir.path());
        if let Some(max) = max_size {
            blobs = blobs.with_max_size(max);
        }
        Self {
            state: AppState::new(pool, blobs),
            dir,
        }
    }

    fn app(&self) -> Router {
        common::app(self.state.clone(), self.dir.path())
    }

    async fn send(&self, req: Request<Body>) -> Response {
        self.app().oneshot(req).await.unwrap()
    }

    async fn space(&self) -> Space {
        let created = common::create_space(self.app()).await;
        Space {
            edit: created.edit,
            view: created.view,
        }
    }

    async fn upload(&self, token: &str, data: &[u8]) -> Response {
        self.send(
            Request::post(format!("/api/s/{token}/assets"))
                .body(Body::from(data.to_vec()))
                .unwrap(),
        )
        .await
    }

    async fn fetch(&self, token: &str, hash: &str) -> Response {
        self.send(
            Request::get(format!("/api/s/{token}/blobs/{hash}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    fn blob_files(&self) -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.dir.path().join("blobs"), &mut out);
        out
    }

    fn tmp_files(&self) -> usize {
        std::fs::read_dir(self.dir.path().join("tmp")).map_or(0, |d| d.count())
    }

    async fn count(&self, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }
}

/// Stands in for an encrypted asset; the server never looks inside.
const CIPHERTEXT: &[u8] = b"\x89PNG\r\n\x1a\nnot really a png";
const CIPHERTEXT_SHA256: &str =
    "sha256:2b8a69045db9b9857e3ad84188129f317d6cd779519c350478f4b88b3d94ed67";

#[tokio::test]
async fn upload_then_fetch_roundtrip() {
    let h = Harness::new(None).await;
    let p = h.space().await;

    let res = h.upload(&p.edit, CIPHERTEXT).await;
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = json(res).await;
    let hash = body["hash"].as_str().unwrap().to_owned();
    assert_eq!(hash, CIPHERTEXT_SHA256);
    assert_eq!(body["size"], CIPHERTEXT.len());
    assert_eq!(body.as_object().unwrap().len(), 2, "{body}");

    let hex = &hash[7..];
    let on_disk = h
        .dir
        .path()
        .join("blobs")
        .join(&hex[..2])
        .join(&hex[2..4])
        .join(hex);
    assert_eq!(std::fs::read(on_disk).unwrap(), CIPHERTEXT);
    assert_eq!(h.tmp_files(), 0);

    // Read tokens may fetch.
    for token in [&p.edit, &p.view] {
        let res = h.fetch(token, &hash).await;
        assert_eq!(res.status(), StatusCode::OK);
        let headers = res.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
        assert_eq!(
            headers[header::CONTENT_LENGTH],
            CIPHERTEXT.len().to_string().as_str()
        );
        assert_eq!(headers[header::ETAG], format!("\"{hash}\"").as_str());
        assert_eq!(
            headers[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            to_bytes(res.into_body(), 1 << 20).await.unwrap(),
            Bytes::from_static(CIPHERTEXT)
        );
    }
}

#[tokio::test]
async fn upload_content_type_is_ignored() {
    let h = Harness::new(None).await;
    let p = h.space().await;

    let res = h
        .send(
            Request::post(format!("/api/s/{}/assets?name=a.svg", p.edit))
                .header(header::CONTENT_TYPE, "image/svg+xml")
                .body(Body::from(CIPHERTEXT.to_vec()))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::CREATED);
    let hash = json(res).await["hash"].as_str().unwrap().to_owned();
    let res = h.fetch(&p.view, &hash).await;
    assert_eq!(
        res.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(
        res.headers()[header::CONTENT_SECURITY_POLICY],
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
    );
}

#[tokio::test]
async fn identical_content_is_stored_once() {
    let h = Harness::new(None).await;
    let a = h.space().await;
    let b = h.space().await;

    let first = json(h.upload(&a.edit, CIPHERTEXT).await).await;
    let again = json(h.upload(&a.edit, CIPHERTEXT).await).await;
    let other = json(h.upload(&b.edit, CIPHERTEXT).await).await;
    assert_eq!(first["hash"], again["hash"]);
    assert_eq!(first["hash"], other["hash"]);

    assert_eq!(h.blob_files().len(), 1);
    assert_eq!(h.tmp_files(), 0);
    assert_eq!(h.count("SELECT COUNT(*) FROM blobs").await, 1);
    assert_eq!(h.count("SELECT COUNT(*) FROM space_blobs").await, 2);
}

#[tokio::test]
async fn rejects_uploads_over_the_limit() {
    let h = Harness::new(Some(16)).await;
    let p = h.space().await;

    let res = h.upload(&p.edit, &[7u8; 17]).await;
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);

    // Without a Content-Length the limit is enforced while streaming.
    let chunks: Vec<Result<Bytes, std::io::Error>> =
        (0..4).map(|_| Ok(Bytes::from_static(&[1u8; 8]))).collect();
    let res = h
        .send(
            Request::post(format!("/api/s/{}/assets", p.edit))
                .body(Body::from_stream(futures_util::stream::iter(chunks)))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);

    assert!(h.blob_files().is_empty());
    assert_eq!(h.tmp_files(), 0);
    assert_eq!(h.count("SELECT COUNT(*) FROM blobs").await, 0);

    let res = h.upload(&p.edit, &[7u8; 16]).await;
    assert_eq!(res.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn upload_requires_write_access() {
    let h = Harness::new(None).await;
    let p = h.space().await;

    let res = h.upload(&p.view, CIPHERTEXT).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = h.upload("0000000000000000000000", CIPHERTEXT).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = h.upload("nope", CIPHERTEXT).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(h.blob_files().is_empty());
}

#[tokio::test]
async fn blobs_are_scoped_to_their_space() {
    let h = Harness::new(None).await;
    let a = h.space().await;
    let b = h.space().await;
    let hash = json(h.upload(&a.edit, CIPHERTEXT).await).await["hash"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_eq!(
        h.fetch(&b.edit, &hash).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.fetch(&b.view, &hash).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.fetch("0000000000000000000000", &hash).await.status(),
        StatusCode::NOT_FOUND
    );
    let missing = format!("sha256:{}", "0".repeat(64));
    assert_eq!(
        h.fetch(&a.edit, &missing).await.status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn honors_if_none_match() {
    let h = Harness::new(None).await;
    let p = h.space().await;
    let hash = json(h.upload(&p.edit, CIPHERTEXT).await).await["hash"]
        .as_str()
        .unwrap()
        .to_owned();

    let res = h
        .send(
            Request::get(format!("/api/s/{}/blobs/{hash}", p.view))
                .header(header::IF_NONE_MATCH, format!("\"{hash}\""))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(res.headers()[header::ETAG], format!("\"{hash}\"").as_str());
    assert!(to_bytes(res.into_body(), 1024).await.unwrap().is_empty());

    let res = h
        .send(
            Request::get(format!("/api/s/{}/blobs/{hash}", p.view))
                .header(header::IF_NONE_MATCH, "\"sha256:other\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejects_malformed_hashes() {
    let h = Harness::new(None).await;
    let p = h.space().await;
    for bad in [
        "sha256:..%2F..%2F..%2Ftest.db",
        "..%2Ftest.db",
        "sha256:ABCDEF",
        &"0".repeat(64),
        &format!("sha256:{}", "G".repeat(64)),
    ] {
        let status = h.fetch(&p.edit, bad).await.status();
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "{bad}: {status}"
        );
        assert_ne!(status, StatusCode::OK);
    }
    assert_eq!(
        h.fetch(&p.edit, "sha256:..%2F..%2Ftest.db").await.status(),
        StatusCode::BAD_REQUEST
    );
}
