//! HTTP calls to the server, mirroring `apps/web/src/sync/api.ts`. Only
//! tokens and ciphertext ever go over these.

use std::sync::Once;
use std::time::Duration;

use anyhow::{Context, bail};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::engine::SyncError;
use crate::hash::BlobHash;
use crate::link::percent_encode;

/// The server's upload cap. Sealed blobs carry `SEAL_OVERHEAD` on top of
/// the plaintext, see [`crate::worktree::MAX_ASSET_BYTES`].
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Write,
    Read,
}

impl Permission {
    pub fn can_write(self) -> bool {
        self == Self::Write
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub project_id: String,
    pub permission: Permission,
    /// Only sent for edit tokens.
    pub view_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub project_id: String,
    pub edit_token: String,
    pub view_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StoredBlob {
    pub hash: BlobHash,
}

/// rustls refuses to pick a crypto provider on its own. Only ring is
/// compiled in, so installing it is unambiguous; a second call is a no-op.
pub fn install_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// reqwest errors print their URL, and every URL but the first holds the
/// share token, which grants access to the project.
fn redact(err: reqwest::Error) -> reqwest::Error {
    err.without_url()
}

/// How long a response may go quiet: until its headers arrive, and then
/// between body chunks. Without it a server that stops answering hangs the
/// command forever.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// The slowest upload rate still worth waiting for, see `upload_blob`.
const MIN_UPLOAD_BYTES_PER_SEC: u64 = 32 * 1024;

#[derive(Debug, Clone)]
pub struct Api {
    http: reqwest::Client,
    /// reqwest starts the read timeout when the request is sent and only
    /// resets it once headers come back, so it would also cap the time
    /// spent sending a large body. Uploads get a client without one and a
    /// deadline scaled to the body instead.
    upload: reqwest::Client,
    origin: String,
}

fn client(read_timeout: Option<Duration>) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("typstry-cli/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15));
    if let Some(timeout) = read_timeout {
        builder = builder.read_timeout(timeout);
    }
    builder.build().context("creating the HTTP client")
}

/// Sends `req` with the URL, and so the share token, kept out of the
/// error.
async fn send(
    req: reqwest::RequestBuilder,
    what: impl FnOnce() -> String,
) -> anyhow::Result<reqwest::Response> {
    req.send().await.map_err(redact).with_context(what)
}

/// Whether a response is a bare status, which is how the typstry server
/// answers an unknown share token: no content type and an empty body.
/// Proxies and web servers put an HTML or JSON page in their 404s.
async fn is_bare(res: reqwest::Response) -> bool {
    if res.headers().contains_key(reqwest::header::CONTENT_TYPE) {
        return false;
    }
    res.bytes().await.is_ok_and(|body| body.is_empty())
}

impl Api {
    pub fn new(origin: &str) -> anyhow::Result<Self> {
        install_crypto_provider();
        Ok(Self {
            http: client(Some(READ_TIMEOUT))?,
            upload: client(None)?,
            origin: origin.trim_end_matches('/').to_owned(),
        })
    }

    /// `<origin>/api/<scope>/<token>`, plus `/<tail>` unless it is empty.
    /// The token is encoded here so no caller can forget to.
    fn token_url(&self, scope: &str, token: &str, tail: &str) -> String {
        let mut url = format!("{}/api/{scope}/{}", self.origin, percent_encode(token));
        if !tail.is_empty() {
            url.push('/');
            url.push_str(tail);
        }
        url
    }

    /// A URL in the project the share token grants access to.
    fn project_url(&self, token: &str, tail: &str) -> String {
        self.token_url("p", token, tail)
    }

    /// Registers an empty project; its content arrives later, encrypted.
    pub async fn create_project(&self) -> anyhow::Result<CreatedProject> {
        let req = self.http.post(format!("{}/api/projects", self.origin));
        let res = send(req, || format!("cannot reach {}", self.origin)).await?;
        if !res.status().is_success() {
            bail!("creating the project failed: HTTP {}", res.status());
        }
        Ok(res.json().await.map_err(redact)?)
    }

    pub async fn resolve_share(&self, token: &str) -> anyhow::Result<ShareInfo> {
        let req = self.http.get(self.token_url("share", token, ""));
        let res = send(req, || format!("cannot reach {}", self.origin)).await?;
        let status = res.status();
        if !status.is_success() {
            // Typed, so live sync stops instead of retrying a link that
            // is gone for good. Only the typstry server's own answer counts:
            // a 404 from a proxy, a maintenance page or a wrong base path is
            // usually temporary, and stopping sync for good over it would be
            // worse than retrying.
            if status == StatusCode::NOT_FOUND && is_bare(res).await {
                return Err(SyncError::UnknownLink.into());
            }
            bail!("resolving the link failed: HTTP {status}");
        }
        Ok(res.json().await.map_err(redact)?)
    }

    pub async fn get_blob(&self, token: &str, hash: &str) -> anyhow::Result<Vec<u8>> {
        let url = self.project_url(token, &format!("blobs/{}", percent_encode(hash)));
        let res = send(self.http.get(url), || format!("downloading {hash}")).await?;
        if !res.status().is_success() {
            bail!("downloading {hash} failed: HTTP {}", res.status());
        }
        let bytes = Vec::from(res.bytes().await.map_err(redact)?);
        // The hash comes from the signed doc and blobs are not signed
        // themselves, so this check is what stops a server (or a viewer
        // working with it) from swapping in other content sealed with the
        // read key.
        if BlobHash::of(&bytes).as_str() != hash {
            bail!("downloading {hash} failed: the server sent different content");
        }
        Ok(bytes)
    }

    pub async fn upload_blob(&self, token: &str, sealed: Vec<u8>) -> anyhow::Result<StoredBlob> {
        let expected = BlobHash::of(&sealed);
        // Generous on purpose: it only has to catch a connection that died
        // silently, not a slow one.
        let deadline =
            READ_TIMEOUT + Duration::from_secs(sealed.len() as u64 / MIN_UPLOAD_BYTES_PER_SEC);
        let req = self
            .upload
            .post(self.project_url(token, "assets"))
            .timeout(deadline)
            .header("content-type", "application/octet-stream")
            .body(sealed);
        let res = send(req, || "uploading an asset".to_owned()).await?;
        match res.status() {
            StatusCode::FORBIDDEN => bail!("this link is read-only"),
            StatusCode::PAYLOAD_TOO_LARGE => {
                bail!(
                    "the asset is larger than the server's {} MB limit",
                    MAX_UPLOAD_BYTES / 1024 / 1024
                )
            }
            s if !s.is_success() => bail!("uploading an asset failed: HTTP {s}"),
            _ => {
                let stored: StoredBlob = res.json().await.map_err(redact)?;
                // The signed doc names the blob by this hash and downloads
                // are only checked against it, so the server must not get
                // to choose which blob that is.
                if stored.hash != expected {
                    bail!(
                        "uploading an asset failed: the server named it {}, not {expected}",
                        stored.hash
                    );
                }
                Ok(stored)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn errors_never_show_the_token() {
        // Nothing listens here.
        let api = Api::new("http://127.0.0.1:9").unwrap();
        let token = "secret-share-token";
        let errors = [
            api.resolve_share(token).await.unwrap_err(),
            api.get_blob(token, "sha256:00").await.unwrap_err(),
            api.upload_blob(token, vec![1]).await.unwrap_err(),
        ];
        for err in errors {
            let shown = format!("{err:#} {err:?}");
            assert!(!shown.contains(token), "{shown}");
        }
    }

    /// Answers every request with `response`, for as long as the test runs.
    async fn fake_server(response: &'static [u8]) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0; 1024];
                let _ = socket.read(&mut request).await;
                let _ = socket.write_all(response).await;
            }
        });
        origin
    }

    #[tokio::test]
    async fn a_revoked_link_is_fatal() {
        let origin = fake_server(
            b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
        let err = Api::new(&origin)
            .unwrap()
            .resolve_share("tok")
            .await
            .unwrap_err();
        assert!(
            matches!(SyncError::fatal(&err), Some(SyncError::UnknownLink)),
            "{err:#}"
        );
    }

    #[tokio::test]
    async fn a_foreign_404_is_not_fatal() {
        let origin = fake_server(
            b"HTTP/1.1 404 Not Found\r\ncontent-type: text/html\r\ncontent-length: 13\r\n\
              connection: close\r\n\r\n<h1>404</h1>\n",
        )
        .await;
        let err = Api::new(&origin)
            .unwrap()
            .resolve_share("tok")
            .await
            .unwrap_err();
        assert!(SyncError::fatal(&err).is_none(), "{err:#}");
        assert!(format!("{err:#}").contains("HTTP 404"), "{err:#}");
    }

    #[tokio::test]
    async fn blobs_must_match_their_hash() {
        // Serves "abc" for any blob, whatever hash was asked for.
        let origin =
            fake_server(b"HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nabc")
                .await;
        let api = Api::new(&origin).unwrap();
        let abc = BlobHash::of(b"abc");
        assert_eq!(api.get_blob("tok", abc.as_str()).await.unwrap(), b"abc");
        let other = BlobHash::of(b"xyz");
        let err = api.get_blob("tok", other.as_str()).await.unwrap_err();
        assert!(format!("{err:#}").contains("different content"), "{err:#}");
    }
}
