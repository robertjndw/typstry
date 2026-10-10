//! HTTP calls to the server, mirroring `apps/web/src/sync/api.ts`. Only
//! tokens and ciphertext ever go over these.

use std::sync::Once;
use std::time::Duration;

use anyhow::{Context, bail};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

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
    /// `sha256:<hex>` of the ciphertext.
    pub hash: String,
    /// Ciphertext size; the doc stores the plaintext size instead.
    pub size: u64,
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

#[derive(Debug, Clone)]
pub struct Api {
    http: reqwest::Client,
    origin: String,
}

impl Api {
    pub fn new(origin: &str) -> anyhow::Result<Self> {
        install_crypto_provider();
        let http = reqwest::Client::builder()
            .user_agent(concat!("typstry-cli/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .context("creating the HTTP client")?;
        Ok(Self {
            http,
            origin: origin.trim_end_matches('/').to_owned(),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Registers an empty project; its content arrives later, encrypted.
    pub async fn create_project(&self) -> anyhow::Result<CreatedProject> {
        let res = self
            .http
            .post(format!("{}/api/projects", self.origin))
            .send()
            .await
            .map_err(redact)
            .with_context(|| format!("cannot reach {}", self.origin))?;
        if !res.status().is_success() {
            bail!("creating the project failed: HTTP {}", res.status());
        }
        Ok(res.json().await.map_err(redact)?)
    }

    pub async fn resolve_share(&self, token: &str) -> anyhow::Result<ShareInfo> {
        let res = self
            .http
            .get(format!(
                "{}/api/share/{}",
                self.origin,
                percent_encode(token)
            ))
            .send()
            .await
            .map_err(redact)
            .with_context(|| format!("cannot reach {}", self.origin))?;
        match res.status() {
            StatusCode::NOT_FOUND => {
                bail!("the server does not know this link; it may have been revoked")
            }
            s if !s.is_success() => bail!("resolving the link failed: HTTP {s}"),
            _ => Ok(res.json().await.map_err(redact)?),
        }
    }

    pub async fn get_blob(&self, token: &str, hash: &str) -> anyhow::Result<Vec<u8>> {
        let res = self
            .http
            .get(format!(
                "{}/api/p/{}/blobs/{}",
                self.origin,
                percent_encode(token),
                percent_encode(hash)
            ))
            .send()
            .await
            .map_err(redact)
            .with_context(|| format!("downloading {hash}"))?;
        if !res.status().is_success() {
            bail!("downloading {hash} failed: HTTP {}", res.status());
        }
        Ok(res.bytes().await.map_err(redact)?.to_vec())
    }

    pub async fn upload_blob(&self, token: &str, sealed: Vec<u8>) -> anyhow::Result<StoredBlob> {
        let res = self
            .http
            .post(format!(
                "{}/api/p/{}/assets",
                self.origin,
                percent_encode(token)
            ))
            .header("content-type", "application/octet-stream")
            .body(sealed)
            .send()
            .await
            .map_err(redact)
            .context("uploading an asset")?;
        match res.status() {
            StatusCode::FORBIDDEN => bail!("this link is read-only"),
            StatusCode::PAYLOAD_TOO_LARGE => {
                bail!(
                    "the asset is larger than the server's {} MB limit",
                    MAX_UPLOAD_BYTES / 1024 / 1024
                )
            }
            s if !s.is_success() => bail!("uploading an asset failed: HTTP {s}"),
            _ => Ok(res.json().await.map_err(redact)?),
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
}
