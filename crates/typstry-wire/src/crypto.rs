//! The project key and everything encrypted with it, mirroring
//! `apps/web/src/crypto/project-key.ts` and the record encryption of
//! `apps/web/src/sync/encrypted-doc-adaptor.ts`.
//!
//! One AES-256-GCM key per project encrypts doc records, blobs and
//! presence. Doc records bind their plaintext header as associated data;
//! blobs and presence bind a context string instead.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use sha2::{Digest, Sha256};

use crate::elo::{
    IV_LEN, Iv, Record, SealedRecord, encode_delta_header, encode_record, encode_snapshot_header,
};

pub const BLOB_CONTEXT: &str = "typstry:blob:v1";
pub const PRESENCE_CONTEXT: &str = "typstry:presence:v1";

/// Bytes [`ProjectKey::seal`] adds: the IV and the GCM tag.
pub const SEAL_OVERHEAD: usize = IV_LEN + 16;

const RAW_KEY_BYTES: usize = 32;

/// The browser decodes keys with `atob`, which ignores the unused low bits
/// of the last character, so this does too. Otherwise a key that works in
/// the browser could be refused here.
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("malformed project key")]
    MalformedKey,
    /// The data is intact but sealed under another project's key, which
    /// usually means a link or config carries the wrong key.
    #[error("data is encrypted with key {0}, which this key is not")]
    KeyMismatch(String),
    #[error("malformed record: {0}")]
    MalformedRecord(String),
    #[error("sealed data is truncated")]
    Truncated,
    /// Wrong key or context, or tampered data; GCM cannot tell which.
    #[error("decryption failed")]
    Decrypt,
}

/// A record after decryption, with the header it was authenticated under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedRecord {
    pub record: Record,
    pub plaintext: Vec<u8>,
}

pub struct ProjectKey {
    cipher: Aes256Gcm,
    key_id: String,
}

// The key itself must never end up in logs.
impl std::fmt::Debug for ProjectKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectKey")
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

fn random_iv() -> Iv {
    let mut iv = [0; IV_LEN];
    getrandom::fill(&mut iv).expect("OS random source unavailable");
    iv
}

impl ProjectKey {
    /// A fresh key in its shareable form, like `generateRawProjectKey` in
    /// `apps/web/src/crypto/project-key.ts`.
    pub fn generate_raw() -> String {
        let mut bytes = [0u8; RAW_KEY_BYTES];
        getrandom::fill(&mut bytes).expect("OS random source unavailable");
        BASE64URL.encode(bytes)
    }

    /// Parses the shareable form: exactly 32 bytes as base64url without
    /// padding, the way it appears in a share link's fragment.
    pub fn from_base64url(raw: &str) -> Result<Self, CryptoError> {
        let bytes = BASE64URL
            .decode(raw)
            .map_err(|_| CryptoError::MalformedKey)?;
        if bytes.len() != RAW_KEY_BYTES {
            return Err(CryptoError::MalformedKey);
        }
        let digest = Sha256::digest(&bytes);
        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(&bytes).map_err(|_| CryptoError::MalformedKey)?,
            key_id: BASE64URL.encode(&digest[..9]),
        })
    }

    /// The short fingerprint sent in clear with every record, so a wrong
    /// key can be told apart from corrupted data.
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    fn encrypt(&self, iv: &Iv, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        self.cipher
            .encrypt(
                &Nonce::from(*iv),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("AES-GCM encryption does not fail for in-memory buffers")
    }

    fn decrypt(&self, iv: &Iv, ct: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
        self.cipher
            .decrypt(&Nonce::from(*iv), Payload { msg: ct, aad })
            .map_err(|_| CryptoError::Decrypt)
    }

    /// Seals `plaintext` as `iv || ciphertext+tag`, binding `context` (one
    /// of the `*_CONTEXT` constants) so a blob cannot be passed off as
    /// presence or the other way around.
    pub fn seal(&self, plaintext: &[u8], context: &str) -> Vec<u8> {
        let iv = random_iv();
        let mut out = Vec::with_capacity(SEAL_OVERHEAD + plaintext.len());
        out.extend_from_slice(&iv);
        out.extend(self.encrypt(&iv, plaintext, context.as_bytes()));
        out
    }

    /// Inverse of [`Self::seal`]. Sealed data carries no key id, so a wrong
    /// key shows up as [`CryptoError::Decrypt`].
    pub fn open(&self, sealed: &[u8], context: &str) -> Result<Vec<u8>, CryptoError> {
        let Some((iv, ct)) = sealed.split_first_chunk::<IV_LEN>() else {
            return Err(CryptoError::Truncated);
        };
        self.decrypt(iv, ct, context.as_bytes())
    }

    /// Encrypts the Loro updates for ops `[start, end)` of `peer` into a
    /// delta record.
    ///
    /// # Panics
    ///
    /// When the span is empty.
    pub fn encrypt_delta(&self, peer: u64, start: u64, end: u64, plaintext: &[u8]) -> Vec<u8> {
        self.encrypt_delta_with_iv(peer, start, end, plaintext, &random_iv())
    }

    /// Encrypts a Loro snapshot covering `vv` into a snapshot record.
    pub fn encrypt_snapshot(&self, vv: &[(u64, u64)], plaintext: &[u8]) -> Vec<u8> {
        self.encrypt_snapshot_with_iv(vv, plaintext, &random_iv())
    }

    /// Reusing an IV under the same key breaks GCM entirely; this exists so
    /// tests can produce byte-stable records.
    #[doc(hidden)]
    pub fn encrypt_delta_with_iv(
        &self,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
        iv: &Iv,
    ) -> Vec<u8> {
        let header = encode_delta_header(peer, start, end, &self.key_id, iv);
        encode_record(&header, &self.encrypt(iv, plaintext, &header))
    }

    #[doc(hidden)]
    pub fn encrypt_snapshot_with_iv(
        &self,
        vv: &[(u64, u64)],
        plaintext: &[u8],
        iv: &Iv,
    ) -> Vec<u8> {
        let header = encode_snapshot_header(vv, &self.key_id, iv);
        encode_record(&header, &self.encrypt(iv, plaintext, &header))
    }

    /// Parses and decrypts one record of either kind, authenticating its
    /// header.
    pub fn decrypt_record(&self, record: &[u8]) -> Result<DecryptedRecord, CryptoError> {
        let sealed = SealedRecord::parse(record).map_err(CryptoError::MalformedRecord)?;
        let plaintext = self.open_record(&sealed)?;
        Ok(DecryptedRecord {
            record: sealed.record,
            plaintext,
        })
    }

    /// Decrypts a record that is already parsed, for callers that need its
    /// header even when decryption fails.
    pub fn open_record(&self, sealed: &SealedRecord<'_>) -> Result<Vec<u8>, CryptoError> {
        if sealed.key_id != self.key_id {
            return Err(CryptoError::KeyMismatch(sealed.key_id.clone()));
        }
        self.decrypt(&sealed.iv, sealed.ct, sealed.aad)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    fn key() -> ProjectKey {
        ProjectKey::from_base64url(RAW).unwrap()
    }

    fn other_key() -> ProjectKey {
        ProjectKey::from_base64url(&BASE64URL.encode([9; 32])).unwrap()
    }

    #[test]
    fn parses_only_32_byte_base64url_keys() {
        assert_eq!(key().key_id().len(), 12);
        for bad in [
            "",
            &RAW[..42],
            &format!("{RAW}A"),
            &format!("{RAW}="),
            &RAW.replace('A', "+"),
            &BASE64URL.encode([0; 16]),
        ] {
            assert!(ProjectKey::from_base64url(bad).is_err(), "{bad:?}");
        }
        assert!(!format!("{:?}", key()).contains(RAW));
    }

    #[test]
    fn records_round_trip() {
        let key = key();
        let record = key.encrypt_delta(7, 0, 3, b"ops");
        let out = key.decrypt_record(&record).unwrap();
        assert_eq!(out.plaintext, b"ops");
        assert_eq!(
            out.record,
            Record::Delta {
                peer: 7,
                start: 0,
                end: 3
            }
        );

        let record = key.encrypt_snapshot(&[(9, 1), (10, 2)], b"snapshot");
        let out = key.decrypt_record(&record).unwrap();
        assert_eq!(out.plaintext, b"snapshot");
        assert_eq!(
            out.record,
            Record::Snapshot {
                vv: [(9, 1), (10, 2)].into()
            }
        );
    }

    #[test]
    fn wrong_key_is_a_mismatch() {
        let record = key().encrypt_delta(7, 0, 3, b"ops");
        let other = other_key();
        assert!(matches!(
            other.decrypt_record(&record),
            Err(CryptoError::KeyMismatch(id)) if id == key().key_id()
        ));
    }

    #[test]
    fn tampering_is_detected() {
        let key = key();
        let record = key.encrypt_delta(7, 0, 3, b"ops");

        let mut ct = record.clone();
        *ct.last_mut().unwrap() ^= 1;
        assert!(matches!(key.decrypt_record(&ct), Err(CryptoError::Decrypt)));

        // The header is authenticated too: claiming other ops must fail.
        let mut header = record.clone();
        header[4] = 4;
        assert!(matches!(
            key.decrypt_record(&header),
            Err(CryptoError::Decrypt)
        ));

        assert!(matches!(
            key.decrypt_record(b"\x07"),
            Err(CryptoError::MalformedRecord(_))
        ));
    }

    #[test]
    fn seal_binds_the_context() {
        let key = key();
        let sealed = key.seal(b"blob", BLOB_CONTEXT);
        assert_eq!(sealed.len(), 4 + SEAL_OVERHEAD);
        assert_eq!(key.open(&sealed, BLOB_CONTEXT).unwrap(), b"blob");
        assert!(matches!(
            key.open(&sealed, PRESENCE_CONTEXT),
            Err(CryptoError::Decrypt)
        ));
        assert!(matches!(
            other_key().open(&sealed, BLOB_CONTEXT),
            Err(CryptoError::Decrypt)
        ));
        assert!(matches!(
            key.open(&sealed[..5], BLOB_CONTEXT),
            Err(CryptoError::Truncated)
        ));
    }
}
