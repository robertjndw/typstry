//! Encrypted assets: uploads, downloads and the plaintext cache.

use std::collections::{BTreeSet, HashMap};

use anyhow::{Context, bail};
use futures_util::StreamExt;
use typstry_doc::materialize::FileContent;
use typstry_wire::crypto::CryptoError;

use crate::hash::{BlobHash, Digest};
use crate::worktree::{LocalFile, MAX_ASSET_BYTES, mime_for};

use super::Session;

/// Asset downloads that run at once, see [`Session::prefetch_assets`].
const PARALLEL_DOWNLOADS: usize = 8;

impl Session {
    /// Downloads the assets among `hashes` that are not cached yet, several
    /// at a time, so that [`Self::asset_bytes`] finds them all in the
    /// cache. Each is decrypted and cached as soon as it arrives, which
    /// keeps at most a few of them in memory.
    pub async fn prefetch_assets(&mut self, hashes: &[&str]) -> anyhow::Result<()> {
        let missing: BTreeSet<&str> = hashes
            .iter()
            .copied()
            .filter(|hash| {
                self.core
                    .state
                    .blob_path(hash)
                    .is_none_or(|path| !path.is_file())
            })
            .collect();
        if missing.len() < 2 {
            // One download gains nothing from running beside others.
            return Ok(());
        }
        // Each download owns what it needs: futures borrowing from here
        // would make the caller's future not Send.
        let downloads: Vec<_> = missing
            .into_iter()
            .map(|hash| {
                let api = self.core.api.clone();
                let token = self.core.config.token.clone();
                let hash = hash.to_owned();
                async move {
                    let sealed = api.get_blob(&token, &hash).await;
                    (hash, sealed)
                }
            })
            .collect();
        let mut downloads =
            futures_util::stream::iter(downloads).buffer_unordered(PARALLEL_DOWNLOADS);
        while let Some((hash, sealed)) = downloads.next().await {
            self.store_asset_fetching_keys(&hash, &sealed?).await?;
        }
        Ok(())
    }

    /// [`Self::store_asset`], fetching the keyring once if the blob is
    /// from a key generation newer than ours.
    async fn store_asset_fetching_keys(
        &mut self,
        hash: &str,
        sealed: &[u8],
    ) -> anyhow::Result<Vec<u8>> {
        match self.store_asset(hash, sealed) {
            Err(err)
                if matches!(
                    err.downcast_ref::<CryptoError>(),
                    Some(CryptoError::UnknownGeneration(_))
                ) && self.refresh_keyring().await? =>
            {
                self.store_asset(hash, sealed)
            }
            other => other,
        }
    }

    /// Decrypts a downloaded asset into the cache.
    fn store_asset(&mut self, hash: &str, sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
        let bytes = self
            .doc_keys()?
            .open_blob(sealed)
            .map_err(|err| match err {
                CryptoError::UnknownGeneration(_) => anyhow::Error::new(err),
                CryptoError::NewerVersion(_) => anyhow::anyhow!("asset {hash} was {err}"),
                err => anyhow::Error::new(err).context(format!(
                    "asset {hash} does not decrypt with this project's key"
                )),
            })?;
        self.core.state.write_blob(hash, &bytes)?;
        self.base
            .assets
            .insert(BlobHash::from(hash), Digest::of(&bytes));
        Ok(bytes)
    }

    /// The bytes a doc entry stands for on disk, only from what this
    /// folder has cached. For commands told not to use the network.
    pub fn cached_content_bytes(&self, content: &FileContent) -> anyhow::Result<Vec<u8>> {
        match content {
            FileContent::Text(text) => Ok(text.as_bytes().to_vec()),
            FileContent::Asset { hash, .. } => self.core.state.read_blob(hash).with_context(|| {
                format!("asset {hash} of this version is not cached; run without --offline")
            }),
        }
    }

    /// The plaintext of the asset with ciphertext `hash`, from the cache or
    /// the server. Records its digest in the base's asset map.
    pub async fn asset_bytes(&mut self, hash: &str) -> anyhow::Result<Vec<u8>> {
        if let Some(bytes) = self.core.state.read_blob(hash) {
            // Assets run to megabytes; hash them only when the digest is
            // not known yet.
            if !self.base.assets.contains_key(hash) {
                self.base
                    .assets
                    .insert(BlobHash::from(hash), Digest::of(&bytes));
            }
            return Ok(bytes);
        }
        let sealed = self
            .core
            .api
            .get_blob(&self.core.config.token, hash)
            .await?;
        self.store_asset_fetching_keys(hash, &sealed).await
    }

    /// The bytes a doc entry stands for on disk.
    pub async fn content_bytes(&mut self, content: &FileContent) -> anyhow::Result<Vec<u8>> {
        match content {
            FileContent::Text(text) => Ok(text.as_bytes().to_vec()),
            FileContent::Asset { hash, .. } => self.asset_bytes(hash).await,
        }
    }

    /// The digest of the plaintext a doc entry stands for, unless it is an
    /// asset whose bytes this folder never had.
    pub fn known_digest(&self, content: &FileContent) -> Option<Digest> {
        match content {
            FileContent::Text(text) => Some(Digest::of(text.as_bytes())),
            FileContent::Asset { hash, .. } => self.base.assets.get(hash.as_str()).cloned(),
        }
    }

    /// [`Self::known_digest`], fetching the asset when needed.
    pub(super) async fn content_digest(&mut self, content: &FileContent) -> anyhow::Result<Digest> {
        if let Some(digest) = self.known_digest(content) {
            return Ok(digest);
        }
        if let FileContent::Asset { hash, .. } = content {
            self.asset_bytes(hash).await?;
        }
        self.known_digest(content)
            .context("an asset has no digest after fetching it")
    }

    pub(super) async fn same_content(
        &mut self,
        a: &FileContent,
        b: &FileContent,
    ) -> anyhow::Result<bool> {
        match (a, b) {
            _ if a == b => return Ok(true),
            // Texts are their own content; digests would only say again
            // that they differ.
            (FileContent::Text(_), FileContent::Text(_)) => return Ok(false),
            _ => {}
        }
        Ok(self.content_digest(a).await? == self.content_digest(b).await?)
    }

    /// Encrypts and uploads a local file, or reuses a blob we already know
    /// with the same plaintext. `by_digest` maps plaintext digests back to
    /// the hashes in the base's asset map and gains the uploaded blob.
    pub(super) async fn upload_asset(
        &mut self,
        path: &str,
        file: &LocalFile,
        by_digest: &mut HashMap<Digest, BlobHash>,
    ) -> anyhow::Result<FileContent> {
        let known = by_digest.get(&file.digest).cloned();
        let hash = match known {
            Some(hash) => hash,
            None => {
                let bytes = self
                    .worktree
                    .read_bytes(path)?
                    .with_context(|| format!("{path} disappeared while syncing"))?;
                if Digest::of(&bytes) != file.digest {
                    bail!("{path} changed while syncing; run the command again");
                }
                if bytes.len() > MAX_ASSET_BYTES {
                    bail!("{path} is too large to upload");
                }
                let sealed = self.doc_keys()?.seal_blob(&bytes);
                let stored = self
                    .core
                    .api
                    .upload_blob(&self.core.config.token, sealed)
                    .await?;
                self.core.state.write_blob(stored.hash.as_str(), &bytes)?;
                self.base
                    .assets
                    .insert(stored.hash.clone(), file.digest.clone());
                by_digest.insert(file.digest.clone(), stored.hash.clone());
                stored.hash
            }
        };
        Ok(FileContent::Asset {
            hash: hash.into_string(),
            size: file.size,
            mime: mime_for(path).to_owned(),
        })
    }
}
