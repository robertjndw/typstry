//! HTTP calls to the server, mirroring `apps/web/src/sync/api.ts`. Only
//! tokens and ciphertext ever go over these.

use std::sync::Once;
use std::time::Duration;

use anyhow::{Context, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::StatusCode;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use typstry_wire::owner::OwnerKey;
use typstry_wire::relay::RELAY_API_PATH;
use typstry_wire::{PROTOCOL_HEADER, PROTOCOL_VERSION};

use crate::engine::SyncError;
use crate::hash::BlobHash;
use crate::link::percent_encode;

/// The server's upload cap. Sealed blobs carry `SEAL_OVERHEAD` on top of
/// the plaintext, see [`crate::worktree::MAX_ASSET_BYTES`].
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Write,
    Read,
}

/// By hand, so a permission from a newer server or a newer typstry's
/// config.json asks for an upgrade instead of failing with serde's bare
/// "unknown variant".
impl<'de> Deserialize<'de> for Permission {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = String::deserialize(d)?;
        match value.as_str() {
            "write" => Ok(Self::Write),
            "read" => Ok(Self::Read),
            other => Err(serde::de::Error::custom(format!(
                "unknown permission {other:?}, probably from a newer typstry; upgrade typstry"
            ))),
        }
    }
}

impl Permission {
    pub fn can_write(self) -> bool {
        self == Self::Write
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub space_id: String,
    pub permission: Permission,
    /// Only sent for edit tokens.
    pub view_token: Option<String>,
    /// A rotation replaced the token. It still names the space, so the
    /// folder can catch up through the delivery service and find the new
    /// links.
    #[serde(default)]
    pub retired: bool,
}

/// What a newcomer needs to join the space's group.
#[derive(Debug, Clone)]
pub struct Bootstrap {
    pub incarnation: u64,
    pub group_info: Vec<u8>,
    pub keyring: Vec<u8>,
    /// The owner key the server holds.
    pub owner_key: OwnerKey,
}

impl Bootstrap {
    pub fn as_mls(&self) -> typstry_wire::mls::Bootstrap<'_> {
        typstry_wire::mls::Bootstrap {
            group_info: &self.group_info,
            keyring: &self.keyring,
            owner_key: &self.owner_key,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapBody {
    incarnation: u64,
    group_info: String,
    keyring: String,
    owner_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSpace {
    pub space_id: String,
    pub edit_token: String,
    pub view_token: String,
}

/// A pairing channel the server opened for this device.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayChannel {
    pub channel: u16,
    /// Proves this device allocated the channel; it takes the first seat.
    pub claim: String,
    pub expires_in: u64,
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

/// How often a 429 is retried before the command gives up on it.
const RATE_LIMIT_RETRIES: u32 = 3;

/// The first wait after a 429 without Retry-After; it doubles each time.
const RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(1);

/// A Retry-After can ask for minutes (a proxy's rate limit may refill
/// slowly). Failing with a clear message beats a command that sits
/// there silently that long.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);

const RATE_LIMITED: &str =
    "the server is getting too many requests from this address; try again in a moment";

/// What a Retry-After header asks for. Only the delta-seconds form, which
/// is what Traefik's rate limiter sends; a date falls back to the usual
/// backoff.
fn retry_after(res: &reqwest::Response) -> Option<Duration> {
    let value = res.headers().get(reqwest::header::RETRY_AFTER)?;
    let secs = value.to_str().ok()?.trim().parse::<u64>().ok()?;
    Some(Duration::from_secs(secs))
}

#[derive(Debug, Clone)]
pub struct Api {
    http: reqwest::Client,
    /// reqwest starts the read timeout when the request is sent and only
    /// resets it once headers come back, so it would also cap the time
    /// spent sending a large body. Uploads get a client without one and a
    /// deadline scaled to the body instead.
    upload: reqwest::Client,
    origin: String,
    rate_limit_backoff: Duration,
}

fn client(read_timeout: Option<Duration>) -> anyhow::Result<reqwest::Client> {
    let mut headers = HeaderMap::new();
    headers.insert(PROTOCOL_HEADER, HeaderValue::from(PROTOCOL_VERSION));
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("typstry-cli/", env!("CARGO_PKG_VERSION")))
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(15));
    if let Some(timeout) = read_timeout {
        builder = builder.read_timeout(timeout);
    }
    builder.build().context("creating the HTTP client")
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
            rate_limit_backoff: RATE_LIMIT_BACKOFF,
        })
    }

    /// Sends `req` with the URL, and so the share token, kept out of the
    /// error. A 426 is fatal for every call: the server no longer serves
    /// this typstry and retrying won't change that.
    async fn send(
        &self,
        req: reqwest::RequestBuilder,
        what: impl FnOnce() -> String,
    ) -> anyhow::Result<reqwest::Response> {
        let res = req.send().await.map_err(redact).with_context(what)?;
        if res.status() == StatusCode::UPGRADE_REQUIRED {
            return Err(SyncError::protocol_too_old(&self.origin).into());
        }
        Ok(res)
    }

    /// [`Self::send`] for calls the reverse proxy in front of the server
    /// may rate limit per address (the provided `compose.prod.yaml` does): a
    /// 429 is sent again a few times, after Retry-After or a doubling
    /// backoff, and then becomes an error that says so. A 429 means the
    /// request was turned away before it did anything, so sending it again
    /// is safe.
    async fn send_retrying(
        &self,
        req: reqwest::RequestBuilder,
        what: impl Fn() -> String,
    ) -> anyhow::Result<reqwest::Response> {
        let mut backoff = self.rate_limit_backoff;
        for _ in 0..RATE_LIMIT_RETRIES {
            // Only a streamed body cannot be cloned, and none of ours is.
            let Some(attempt) = req.try_clone() else {
                break;
            };
            let res = self.send(attempt, &what).await?;
            if res.status() != StatusCode::TOO_MANY_REQUESTS {
                return Ok(res);
            }
            let wait = retry_after(&res).unwrap_or(backoff).min(MAX_RETRY_WAIT);
            tracing::debug!(?wait, "rate limited, retrying");
            tokio::time::sleep(wait).await;
            backoff *= 2;
        }
        let res = self.send(req, what).await?;
        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            bail!("{RATE_LIMITED}");
        }
        Ok(res)
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

    /// A URL in the space the share token grants access to.
    fn space_url(&self, token: &str, tail: &str) -> String {
        self.token_url("s", token, tail)
    }

    /// Registers an empty space; its content arrives later, encrypted.
    pub async fn create_space(&self) -> anyhow::Result<CreatedSpace> {
        let req = self.http.post(format!("{}/api/spaces", self.origin));
        let res = self
            .send_retrying(req, || format!("cannot reach {}", self.origin))
            .await?;
        if !res.status().is_success() {
            bail!("creating the project failed: HTTP {}", res.status());
        }
        Ok(res.json().await.map_err(redact)?)
    }

    /// Opens a channel on the relay for pairing two devices.
    pub async fn allocate_relay(&self) -> anyhow::Result<RelayChannel> {
        let req = self.http.post(format!("{}{RELAY_API_PATH}", self.origin));
        let res = self
            .send_retrying(req, || format!("cannot reach {}", self.origin))
            .await?;
        match res.status() {
            s if s.is_success() => Ok(res.json().await.map_err(redact)?),
            StatusCode::SERVICE_UNAVAILABLE => {
                bail!("the server has no free pairing channel right now; try again in a minute")
            }
            StatusCode::NOT_FOUND => {
                bail!("this server does not offer pairing; it may be an older typstry server")
            }
            s => bail!("opening a pairing channel failed: HTTP {s}"),
        }
    }

    pub async fn resolve_share(&self, token: &str) -> anyhow::Result<ShareInfo> {
        let req = self.http.get(self.token_url("share", token, ""));
        let res = self
            .send(req, || format!("cannot reach {}", self.origin))
            .await?;
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
        // Not res.json(): its error hides the reason, like an unknown
        // permission, behind "error decoding response body".
        let body = res.bytes().await.map_err(redact)?;
        serde_json::from_slice(&body)
            .map_err(|err| anyhow::anyhow!("resolving the link failed: {err}"))
    }

    /// The sealed GroupInfo and keyring of the project. Live tokens only: a
    /// retired one gets a 404, since it must not reach the keys of the
    /// generation that replaced it.
    pub async fn mls_bootstrap(&self, token: &str) -> anyhow::Result<Bootstrap> {
        let req = self.http.get(self.space_url(token, "mls"));
        let res = self.send(req, || "fetching the group".to_owned()).await?;
        let status = res.status();
        if status == StatusCode::NOT_FOUND {
            bail!("the server has no group for this link; it may have been replaced");
        }
        if !status.is_success() {
            bail!("fetching the group failed: HTTP {status}");
        }
        let body: BootstrapBody = res.json().await.map_err(redact)?;
        let decode = |what: &str, text: &str| {
            STANDARD
                .decode(text)
                .with_context(|| format!("the server sent an unreadable {what}"))
        };
        Ok(Bootstrap {
            incarnation: body.incarnation,
            group_info: decode("group info", &body.group_info)?,
            keyring: decode("keyring", &body.keyring)?,
            owner_key: decode("owner key", &body.owner_key)?
                .try_into()
                .map_err(|_| anyhow::anyhow!("the server sent an unreadable owner key"))?,
        })
    }

    pub async fn get_blob(&self, token: &str, hash: &str) -> anyhow::Result<Vec<u8>> {
        let url = self.space_url(token, &format!("blobs/{}", percent_encode(hash)));
        let res = self
            .send(self.http.get(url), || format!("downloading {hash}"))
            .await?;
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
            .post(self.space_url(token, "assets"))
            .timeout(deadline)
            .header("content-type", "application/octet-stream")
            .body(sealed);
        let res = self
            .send_retrying(req, || "uploading an asset".to_owned())
            .await?;
        match res.status() {
            StatusCode::FORBIDDEN => bail!("this link is read-only"),
            StatusCode::PAYLOAD_TOO_LARGE => {
                bail!(
                    "the asset is larger than the server's {} MB limit",
                    MAX_UPLOAD_BYTES / 1024 / 1024
                )
            }
            // Not retried: the quota only grows if the server's operator
            // raises it.
            StatusCode::INSUFFICIENT_STORAGE => {
                bail!("this project's storage on the server is full")
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
pub(crate) mod tests {
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
    /// Returns its origin and the requests it got, lowercased.
    pub(crate) async fn fake_server(
        response: &'static [u8],
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        fake_server_answering(vec![response]).await
    }

    /// [`fake_server`] answering with each of `responses` in turn, and with
    /// the last one from then on.
    async fn fake_server_answering(
        responses: Vec<&'static [u8]>,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (seen, requests) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut responses = responses.into_iter().peekable();
            let mut response = responses.next().unwrap();
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0; 1024];
                let n = socket.read(&mut request).await.unwrap_or(0);
                let _ = seen.send(String::from_utf8_lossy(&request[..n]).to_lowercase());
                let _ = socket.write_all(response).await;
                if let Some(next) = responses.next() {
                    response = next;
                }
            }
        });
        (origin, requests)
    }

    pub(crate) const UPGRADE_REQUIRED: &[u8] =
        b"HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

    #[tokio::test]
    async fn a_revoked_link_is_fatal() {
        let (origin, _) = fake_server(
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
    async fn an_outdated_typstry_is_told_to_upgrade() {
        let (origin, mut requests) = fake_server(UPGRADE_REQUIRED).await;
        let err = Api::new(&origin)
            .unwrap()
            .resolve_share("tok")
            .await
            .unwrap_err();
        let request = requests.recv().await.unwrap();
        assert!(
            request.contains(&format!("{PROTOCOL_HEADER}: {PROTOCOL_VERSION}\r\n")),
            "{request}"
        );
        assert!(
            matches!(
                SyncError::fatal(&err),
                Some(SyncError::ProtocolTooOld { .. })
            ),
            "{err:#}"
        );
        let host = origin.trim_start_matches("http://");
        assert_eq!(
            format!("{err:#}"),
            format!("this typstry is too old for the server at {host}; upgrade typstry")
        );
    }

    #[tokio::test]
    async fn a_foreign_404_is_not_fatal() {
        let (origin, _) = fake_server(
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

    #[test]
    fn an_unknown_permission_asks_for_an_upgrade() {
        let parse = |p: &str| serde_json::from_str::<Permission>(&format!("{p:?}"));
        assert_eq!(parse("write").unwrap(), Permission::Write);
        assert_eq!(parse("read").unwrap(), Permission::Read);
        let err = parse("comment").unwrap_err();
        assert!(err.to_string().contains("upgrade typstry"), "{err}");
        assert_eq!(
            serde_json::to_string(&Permission::Write).unwrap(),
            r#""write""#
        );
    }

    #[tokio::test]
    async fn an_unknown_permission_from_the_server_asks_for_an_upgrade() {
        let (origin, _) = fake_server(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 36\r\n\
              connection: close\r\n\r\n{\"spaceId\":\"p\",\"permission\":\"admin\"}",
        )
        .await;
        let err = Api::new(&origin)
            .unwrap()
            .resolve_share("tok")
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("upgrade typstry"), "{err:#}");
    }

    #[tokio::test]
    async fn blobs_must_match_their_hash() {
        // Serves "abc" for any blob, whatever hash was asked for.
        let (origin, _) =
            fake_server(b"HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nabc")
                .await;
        let api = Api::new(&origin).unwrap();
        let abc = BlobHash::of(b"abc");
        assert_eq!(api.get_blob("tok", abc.as_str()).await.unwrap(), b"abc");
        let other = BlobHash::of(b"xyz");
        let err = api.get_blob("tok", other.as_str()).await.unwrap_err();
        assert!(format!("{err:#}").contains("different content"), "{err:#}");
    }

    const RATE_LIMITED_NOW: &[u8] = b"HTTP/1.1 429 Too Many Requests\r\nretry-after: 0\r\n\
          content-length: 0\r\nconnection: close\r\n\r\n";

    const SPACE_CREATED: &[u8] = b"HTTP/1.1 201 Created\r\ncontent-type: application/json\r\n\
          content-length: 47\r\nconnection: close\r\n\r\n\
          {\"spaceId\":\"p\",\"editToken\":\"e\",\"viewToken\":\"v\"}";

    fn count(requests: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> usize {
        std::iter::from_fn(|| requests.try_recv().ok()).count()
    }

    #[tokio::test]
    async fn a_429_is_retried_after_retry_after() {
        // The backoff alone would take seconds; Retry-After: 0 takes none.
        let (origin, mut requests) =
            fake_server_answering(vec![RATE_LIMITED_NOW, RATE_LIMITED_NOW, SPACE_CREATED]).await;
        let started = std::time::Instant::now();
        let created = Api::new(&origin).unwrap().create_space().await.unwrap();
        assert_eq!(created.edit_token, "e");
        assert_eq!(count(&mut requests), 3);
        assert!(started.elapsed() < RATE_LIMIT_BACKOFF);
    }

    #[tokio::test]
    async fn a_429_without_retry_after_backs_off() {
        let (origin, mut requests) = fake_server_answering(vec![
            b"HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            SPACE_CREATED,
        ])
        .await;
        let mut api = Api::new(&origin).unwrap();
        api.rate_limit_backoff = Duration::from_millis(50);
        let started = std::time::Instant::now();
        api.create_space().await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert_eq!(count(&mut requests), 2);
    }

    #[tokio::test]
    async fn a_lasting_429_gives_up_with_a_clear_message() {
        let (origin, mut requests) = fake_server(RATE_LIMITED_NOW).await;
        let api = Api::new(&origin).unwrap();
        for err in [
            api.create_space().await.unwrap_err(),
            api.allocate_relay().await.unwrap_err(),
            api.upload_blob("tok", vec![1]).await.unwrap_err(),
        ] {
            assert_eq!(format!("{err:#}"), RATE_LIMITED);
        }
        assert_eq!(count(&mut requests), 3 * (RATE_LIMIT_RETRIES as usize + 1));
    }

    #[tokio::test]
    async fn a_full_project_is_not_retried() {
        let (origin, mut requests) = fake_server(
            b"HTTP/1.1 507 Insufficient Storage\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
        let err = Api::new(&origin)
            .unwrap()
            .upload_blob("tok", vec![1])
            .await
            .unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "this project's storage on the server is full"
        );
        assert_eq!(count(&mut requests), 1);
    }

    #[tokio::test]
    async fn an_oversized_upload_names_the_limit() {
        let (origin, _) = fake_server(
            b"HTTP/1.1 413 Payload Too Large\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
        let err = Api::new(&origin)
            .unwrap()
            .upload_blob("tok", vec![1])
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("25 MB limit"), "{err:#}");
    }
}
