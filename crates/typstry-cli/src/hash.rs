//! The two kinds of `sha256:<hex>` the CLI juggles. They are spelled the
//! same, but one names encrypted bytes and the other plain ones, and
//! mixing them up would match a local file against the wrong blob.

use std::borrow::Borrow;
use std::fmt::{self, Write as _};

use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Lowercase hex, two digits per byte.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// `sha256:<hex>`, the same spelling the server uses for blob hashes.
fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    format!("sha256:{}", to_hex(&Sha256::digest(bytes)))
}

/// The hash of an asset's ciphertext: what the doc stores and the server
/// names the blob by.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlobHash(String);

impl BlobHash {
    pub fn of(sealed: &[u8]) -> Self {
        Self(sha256(sealed))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl From<&str> for BlobHash {
    fn from(hash: &str) -> Self {
        Self(hash.to_owned())
    }
}

// Lets maps keyed by blob hash be looked up with the hash a doc entry
// holds, which is a plain string.
impl Borrow<str> for BlobHash {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BlobHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The hash of a file's plaintext, as it is on disk.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Digest(String);

impl Digest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(sha256(bytes))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
