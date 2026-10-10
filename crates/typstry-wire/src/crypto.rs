//! The project secrets and everything encrypted with them, mirroring
//! `apps/web/src/crypto/project-key.ts`.
//!
//! An edit link carries a 32-byte edit secret. Two keys are derived from it
//! with HKDF-SHA256: the read key, which encrypts doc records, blobs and
//! presence, and an Ed25519 signing key. A view link carries only the read
//! key and the matching public key, so viewers can decrypt and verify but
//! not write doc records the other clients accept, whatever the server lets
//! through.
//!
//! Nothing is ever encrypted under the read key directly. Every message
//! draws a random 16-byte salt and is encrypted with AES-256-GCM under
//! `HKDF(read key, salt, purpose)`, so the usual limit of about 2^32 random
//! nonces per GCM key does not apply, and each purpose gets its own keys.
//! Doc records bind their plaintext header as associated data and are
//! signed; sealed blobs and presence bind their purpose through the HKDF
//! info and the associated data.

use aes_gcm::aead::{Aead, AeadInOut, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::elo::{
    IV_LEN, Iv, Record, SealedRecord, encode_delta_header, encode_record, encode_snapshot_header,
};

pub const BLOB_CONTEXT: &str = "typstry:v2:blob";
pub const PRESENCE_CONTEXT: &str = "typstry:v2:presence";
const RECORD_CONTEXT: &str = "typstry:v2:record";
const SIGNATURE_CONTEXT: &[u8] = b"typstry:v2:record-signature";
const READ_INFO: &[u8] = b"typstry:v2:read";
const SIGN_INFO: &[u8] = b"typstry:v2:sign";
const KEY_ID_INFO: &[u8] = b"typstry:v2:key-id";

pub const SALT_LEN: usize = 16;
pub type Salt = [u8; SALT_LEN];
const TAG_LEN: usize = 16;
const SIGNATURE_LEN: usize = 64;

/// Bytes [`ProjectKey::seal`] adds: the salt, the IV and the GCM tag.
pub const SEAL_OVERHEAD: usize = SALT_LEN + IV_LEN + TAG_LEN;

const SECRET_BYTES: usize = 32;
/// A view secret is the read key followed by the public key.
const VIEW_SECRET_BYTES: usize = 64;
const KEY_ID_BYTES: usize = 9;

/// The browser decodes secrets with `atob`, which ignores the unused low
/// bits of the last character, so this does too. Otherwise a secret that
/// works in the browser could be refused here.
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
    /// Someone who can read the project but holds no edit link wrote it.
    #[error("record is not signed with the project's edit key")]
    BadSignature,
    /// Wrong key or context, or tampered data; GCM cannot tell which.
    #[error("decryption failed")]
    Decrypt,
    #[error("a view-only key cannot sign records")]
    ReadOnly,
}

/// A record after decryption, with the header it was authenticated under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedRecord {
    pub record: Record,
    pub plaintext: Vec<u8>,
}

pub struct ProjectKey {
    read: Zeroizing<[u8; SECRET_BYTES]>,
    verifying: VerifyingKey,
    /// Only edit secrets carry it.
    signing: Option<SigningKey>,
    key_id: String,
}

// The secrets must never end up in logs.
impl std::fmt::Debug for ProjectKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectKey")
            .field("key_id", &self.key_id)
            .field("can_sign", &self.can_sign())
            .finish_non_exhaustive()
    }
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0; N];
    getrandom::fill(&mut out).expect("OS random source unavailable");
    out
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &[&[u8]]) -> Zeroizing<[u8; SECRET_BYTES]> {
    let mut out = Zeroizing::new([0; SECRET_BYTES]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand_multi_info(info, out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

fn signed_message(header: &[u8], body: &[u8]) -> Vec<u8> {
    [SIGNATURE_CONTEXT, header, body].concat()
}

impl ProjectKey {
    /// A fresh edit secret in its shareable form, like
    /// `generateEditSecret` in `apps/web/src/crypto/project-key.ts`.
    pub fn generate_raw() -> Zeroizing<String> {
        let bytes = Zeroizing::new(random::<SECRET_BYTES>());
        Zeroizing::new(BASE64URL.encode(bytes.as_ref()))
    }

    /// Parses the shareable form, base64url without padding the way it
    /// appears in a share link's fragment: 32 bytes for an edit secret, 64
    /// for a view secret.
    pub fn from_base64url(raw: &str) -> Result<Self, CryptoError> {
        let bytes = Zeroizing::new(
            BASE64URL
                .decode(raw)
                .map_err(|_| CryptoError::MalformedKey)?,
        );
        match bytes.len() {
            SECRET_BYTES => {
                let read = hkdf(&bytes, &[], &[READ_INFO]);
                let signing = SigningKey::from_bytes(&hkdf(&bytes, &[], &[SIGN_INFO]));
                let verifying = signing.verifying_key();
                Ok(Self::assemble(read, verifying, Some(signing)))
            }
            VIEW_SECRET_BYTES => {
                let (read, public) = bytes.split_at(SECRET_BYTES);
                let public: &[u8; 32] = public.try_into().expect("split at 32 of 64");
                let verifying =
                    VerifyingKey::from_bytes(public).map_err(|_| CryptoError::MalformedKey)?;
                let read = Zeroizing::new(read.try_into().expect("split at 32 of 64"));
                Ok(Self::assemble(read, verifying, None))
            }
            _ => Err(CryptoError::MalformedKey),
        }
    }

    fn assemble(
        read: Zeroizing<[u8; SECRET_BYTES]>,
        verifying: VerifyingKey,
        signing: Option<SigningKey>,
    ) -> Self {
        // Covers the public key too, so a view link whose halves come from
        // different projects shows up as a key mismatch.
        let id = hkdf(read.as_ref(), &[], &[KEY_ID_INFO, verifying.as_bytes()]);
        Self {
            key_id: BASE64URL.encode(&id[..KEY_ID_BYTES]),
            read,
            verifying,
            signing,
        }
    }

    /// The short fingerprint sent in clear with every record, so a wrong
    /// key can be told apart from corrupted data.
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// Whether this is an edit secret, which is what writing records takes.
    pub fn can_sign(&self) -> bool {
        self.signing.is_some()
    }

    /// The shareable view secret: the read key and the public key.
    pub fn view_secret(&self) -> Zeroizing<String> {
        let mut bytes = Zeroizing::new([0; VIEW_SECRET_BYTES]);
        bytes[..SECRET_BYTES].copy_from_slice(self.read.as_ref());
        bytes[SECRET_BYTES..].copy_from_slice(self.verifying.as_bytes());
        Zeroizing::new(BASE64URL.encode(bytes.as_ref()))
    }

    fn cipher(&self, salt: &Salt, context: &str) -> Aes256Gcm {
        let key = hkdf(self.read.as_ref(), salt, &[context.as_bytes()]);
        Aes256Gcm::new_from_slice(key.as_ref()).expect("HKDF yields a 32-byte key")
    }

    /// Seals `plaintext` as `salt || iv || ciphertext+tag`, binding
    /// `context` (one of the `*_CONTEXT` constants) so a blob cannot be
    /// passed off as presence or the other way around.
    pub fn seal(&self, plaintext: &[u8], context: &str) -> Vec<u8> {
        let salt: Salt = random();
        let iv: Iv = random();
        let mut sealed = Vec::with_capacity(plaintext.len() + SEAL_OVERHEAD);
        sealed.extend_from_slice(&salt);
        sealed.extend_from_slice(&iv);
        sealed.extend_from_slice(plaintext);
        let tag = self
            .cipher(&salt, context)
            .encrypt_inout_detached(
                &Nonce::from(iv),
                context.as_bytes(),
                (&mut sealed[SALT_LEN + IV_LEN..]).into(),
            )
            .expect("AES-GCM encryption does not fail for in-memory buffers");
        sealed.extend_from_slice(&tag);
        sealed
    }

    /// Inverse of [`Self::seal`]. Sealed data carries no key id, so a wrong
    /// key shows up as [`CryptoError::Decrypt`].
    pub fn open(&self, sealed: &[u8], context: &str) -> Result<Vec<u8>, CryptoError> {
        if sealed.len() < SEAL_OVERHEAD {
            return Err(CryptoError::Truncated);
        }
        let (salt, rest) = sealed
            .split_first_chunk::<SALT_LEN>()
            .expect("length checked");
        let (iv, ct) = rest.split_first_chunk::<IV_LEN>().expect("length checked");
        self.cipher(salt, context)
            .decrypt(
                &Nonce::from(*iv),
                Payload {
                    msg: ct,
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::Decrypt)
    }

    /// Encrypts the Loro updates for ops `[start, end)` of `peer` into a
    /// signed delta record.
    ///
    /// # Panics
    ///
    /// When the span is empty.
    pub fn encrypt_delta(
        &self,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_delta(peer, start, end, plaintext, &random(), &random())
    }

    /// Encrypts a Loro snapshot covering `vv` into a signed snapshot record.
    pub fn encrypt_snapshot(
        &self,
        vv: &[(u64, u64)],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_snapshot(vv, plaintext, &random(), &random())
    }

    /// Reusing a salt and IV breaks the encryption of both messages; this
    /// exists so tests can produce byte-stable records, and is compiled out
    /// of everything else.
    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn encrypt_delta_with(
        &self,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_delta(peer, start, end, plaintext, iv, salt)
    }

    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn encrypt_snapshot_with(
        &self,
        vv: &[(u64, u64)],
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_snapshot(vv, plaintext, iv, salt)
    }

    fn seal_delta(
        &self,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        let header = encode_delta_header(peer, start, end, &self.key_id, iv);
        self.seal_record(&header, iv, salt, plaintext)
    }

    fn seal_snapshot(
        &self,
        vv: &[(u64, u64)],
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        let header = encode_snapshot_header(vv, &self.key_id, iv);
        self.seal_record(&header, iv, salt, plaintext)
    }

    /// A record's ciphertext field is `salt || ciphertext+tag || signature`,
    /// the signature covering the header and everything before it.
    fn seal_record(
        &self,
        header: &[u8],
        iv: &Iv,
        salt: &Salt,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        let signing = self.signing.as_ref().ok_or(CryptoError::ReadOnly)?;
        // Laid out as the signed message, `SIGNATURE_CONTEXT || header ||
        // salt || ciphertext+tag`, with the plaintext encrypted where it
        // lies, so the record body is the tail of it plus the signature.
        let body_at = SIGNATURE_CONTEXT.len() + header.len();
        let ct_at = body_at + SALT_LEN;
        let mut message = Vec::with_capacity(ct_at + plaintext.len() + TAG_LEN + SIGNATURE_LEN);
        message.extend_from_slice(SIGNATURE_CONTEXT);
        message.extend_from_slice(header);
        message.extend_from_slice(salt);
        message.extend_from_slice(plaintext);
        let tag = self
            .cipher(salt, RECORD_CONTEXT)
            .encrypt_inout_detached(&Nonce::from(*iv), header, (&mut message[ct_at..]).into())
            .expect("AES-GCM encryption does not fail for in-memory buffers");
        message.extend_from_slice(&tag);
        let signature = signing.sign(&message);
        message.extend_from_slice(&signature.to_bytes());
        Ok(encode_record(header, &message[body_at..]))
    }

    /// Parses, verifies and decrypts one record of either kind.
    pub fn decrypt_record(&self, record: &[u8]) -> Result<DecryptedRecord, CryptoError> {
        let sealed = SealedRecord::parse(record).map_err(CryptoError::MalformedRecord)?;
        let plaintext = self.open_record(&sealed)?;
        Ok(DecryptedRecord {
            record: sealed.record,
            plaintext,
        })
    }

    /// Verifies and decrypts a record that is already parsed, for callers
    /// that need its header even when decryption fails.
    pub fn open_record(&self, sealed: &SealedRecord<'_>) -> Result<Vec<u8>, CryptoError> {
        if sealed.key_id != self.key_id {
            return Err(CryptoError::KeyMismatch(sealed.key_id.clone()));
        }
        if sealed.ct.len() < SALT_LEN + TAG_LEN + SIGNATURE_LEN {
            return Err(CryptoError::Truncated);
        }
        let (body, signature) = sealed.ct.split_at(sealed.ct.len() - SIGNATURE_LEN);
        let signature = Signature::from_slice(signature).map_err(|_| CryptoError::BadSignature)?;
        // Checked before decrypting: a record a viewer forged is refused
        // whatever it decrypts to.
        self.verifying
            .verify_strict(&signed_message(sealed.aad, body), &signature)
            .map_err(|_| CryptoError::BadSignature)?;
        let (salt, ct) = body
            .split_first_chunk::<SALT_LEN>()
            .expect("length checked");
        self.cipher(salt, RECORD_CONTEXT)
            .decrypt(
                &Nonce::from(sealed.iv),
                Payload {
                    msg: ct,
                    aad: sealed.aad,
                },
            )
            .map_err(|_| CryptoError::Decrypt)
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

    fn viewer() -> ProjectKey {
        ProjectKey::from_base64url(&key().view_secret()).unwrap()
    }

    #[test]
    fn parses_only_32_and_64_byte_base64url_secrets() {
        assert_eq!(key().key_id().len(), 12);
        for bad in [
            "",
            &RAW[..42],
            &format!("{RAW}A"),
            &format!("{RAW}="),
            &RAW.replace('A', "+"),
            &BASE64URL.encode([0; 16]),
            &BASE64URL.encode([0; 48]),
        ] {
            assert!(ProjectKey::from_base64url(bad).is_err(), "{bad:?}");
        }
        assert!(!format!("{:?}", key()).contains(RAW));
        assert!(!format!("{:?}", key()).contains(key().view_secret().as_str()));
    }

    #[test]
    fn view_secrets_derive_from_the_edit_secret() {
        let edit = key();
        let view = viewer();
        assert!(edit.can_sign());
        assert!(!view.can_sign());
        assert_eq!(view.key_id(), edit.key_id());
        assert_eq!(view.view_secret(), edit.view_secret());
        assert_eq!(view.view_secret().len(), 86);
        assert_ne!(other_key().key_id(), edit.key_id());
    }

    #[test]
    fn records_round_trip() {
        let key = key();
        let record = key.encrypt_delta(7, 0, 3, b"ops").unwrap();
        let out = viewer().decrypt_record(&record).unwrap();
        assert_eq!(out.plaintext, b"ops");
        assert_eq!(
            out.record,
            Record::Delta {
                peer: 7,
                start: 0,
                end: 3
            }
        );

        let record = key
            .encrypt_snapshot(&[(9, 1), (10, 2)], b"snapshot")
            .unwrap();
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
    fn viewers_cannot_write() {
        let view = viewer();
        assert!(matches!(
            view.encrypt_delta(7, 0, 3, b"ops"),
            Err(CryptoError::ReadOnly)
        ));
        assert!(matches!(
            view.encrypt_snapshot(&[(7, 3)], b"snapshot"),
            Err(CryptoError::ReadOnly)
        ));
    }

    /// What a viewer could do with the read key alone: encrypt a record
    /// correctly and sign it with a key of their own.
    #[test]
    fn records_signed_by_anyone_else_are_refused() {
        let key = key();
        let header = encode_delta_header(7, 0, 3, key.key_id(), &[1; IV_LEN]);
        let salt = [2; SALT_LEN];
        let ct = key
            .cipher(&salt, RECORD_CONTEXT)
            .encrypt(
                &Nonce::from([1; IV_LEN]),
                Payload {
                    msg: b"forged",
                    aad: &header,
                },
            )
            .unwrap();
        let mut body = [&salt[..], &ct].concat();
        let forger = SigningKey::from_bytes(&[3; 32]);
        body.extend_from_slice(&forger.sign(&signed_message(&header, &body)).to_bytes());
        let forged = encode_record(&header, &body);
        assert!(matches!(
            key.decrypt_record(&forged),
            Err(CryptoError::BadSignature)
        ));

        let unsigned = encode_record(&header, &body[..body.len() - SIGNATURE_LEN]);
        assert!(matches!(
            viewer().decrypt_record(&unsigned),
            Err(CryptoError::BadSignature | CryptoError::Truncated)
        ));
    }

    #[test]
    fn wrong_key_is_a_mismatch() {
        let record = key().encrypt_delta(7, 0, 3, b"ops").unwrap();
        let other = other_key();
        assert!(matches!(
            other.decrypt_record(&record),
            Err(CryptoError::KeyMismatch(id)) if id == key().key_id()
        ));
    }

    #[test]
    fn tampering_is_detected() {
        let key = key();
        let record = key.encrypt_delta(7, 0, 3, b"ops").unwrap();

        // The signature is last; flip a ciphertext byte before it.
        let mut ct = record.clone();
        let at = ct.len() - SIGNATURE_LEN - 1;
        ct[at] ^= 1;
        assert!(matches!(
            key.decrypt_record(&ct),
            Err(CryptoError::BadSignature)
        ));

        // The header is signed too: claiming other ops must fail.
        let mut header = record.clone();
        header[4] = 4;
        assert!(matches!(
            key.decrypt_record(&header),
            Err(CryptoError::BadSignature)
        ));

        assert!(matches!(
            key.decrypt_record(b"\x07"),
            Err(CryptoError::MalformedRecord(_))
        ));
    }

    #[test]
    fn every_message_gets_its_own_salt() {
        let key = key();
        let a = key.seal(b"blob", BLOB_CONTEXT);
        let b = key.seal(b"blob", BLOB_CONTEXT);
        assert_ne!(a[..SALT_LEN], b[..SALT_LEN]);
        assert_ne!(a, b);
    }

    #[test]
    fn seal_binds_the_context() {
        let key = key();
        let sealed = key.seal(b"blob", BLOB_CONTEXT);
        assert_eq!(sealed.len(), 4 + SEAL_OVERHEAD);
        assert_eq!(key.open(&sealed, BLOB_CONTEXT).unwrap(), b"blob");
        assert_eq!(viewer().open(&sealed, BLOB_CONTEXT).unwrap(), b"blob");
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
