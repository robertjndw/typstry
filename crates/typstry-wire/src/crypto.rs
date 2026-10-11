//! The link secrets and everything encrypted with them.
//!
//! A share link carries a [`LinkSecret`]. An edit secret is 32 random bytes;
//! from it HKDF-SHA256 derives the view key and an Ed25519 attestation key.
//! A view secret carries only the view key and the attestation public key,
//! so viewers can open the keyring and verify but never attest.
//!
//! Documents are not encrypted under the link secret. The server stores a
//! [`Keyring`] sealed under a key derived from the view key and signed by
//! the attestation key, which holds one random doc key per generation
//! (`DK_1..DK_gen`). A generation ends when someone is removed or the links
//! are reset, and the new keyring is handed to the remaining members through
//! MLS (see the `mls` module). Records, blobs and profiles are sealed under
//! the doc key of their generation, so history stays readable for everyone
//! who holds the keyring. There is no forward secrecy for document content,
//! on purpose: every link holder can reach all of it anyway.
//!
//! Nothing is ever encrypted under a key directly. Every message draws a
//! random 16-byte salt and is encrypted with AES-256-GCM under
//! `HKDF(key, salt, purpose)`, so the usual limit of about 2^32 random
//! nonces per GCM key does not apply, and each purpose gets its own keys.
//!
//! Who wrote a record is not a shared secret either. Each record is signed
//! with the author's device key (the MLS leaf signature key) and carries an
//! attestation, a signature of the attestation key over that device key and
//! the generation. Readers refuse records without a valid attestation, so
//! viewers stay read-only even if the server lets their writes through, and
//! authors are authenticated, not just claimed.
//!
//! Every format starts with a version byte (secrets with a kind byte), which
//! is authenticated along with the rest. A byte this build does not know
//! means a newer typstry wrote the data, which [`CryptoError::NewerVersion`]
//! reports instead of a generic decryption failure.

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

pub const BLOB_CONTEXT: &str = "typstry:v1:blob";
pub const PROFILE_CONTEXT: &str = "typstry:v1:profile";
pub const PRESENCE_CONTEXT: &str = "typstry:v1:presence";
pub const GROUP_INFO_CONTEXT: &str = "typstry:v1:group-info";
pub const KEYRING_CONTEXT: &str = "typstry:v1:keyring";
const RECORD_CONTEXT: &str = "typstry:v1:record";
const RECORD_SIGNATURE_CONTEXT: &[u8] = b"typstry:v1:record-signature";
const PRESENCE_SIGNATURE_CONTEXT: &[u8] = b"typstry:v1:presence-signature";
const KEYRING_SIGNATURE_CONTEXT: &[u8] = b"typstry:v1:keyring-signature";
const ATTEST_CONTEXT: &[u8] = b"typstry:v1:attestation";
const VIEW_INFO: &[u8] = b"typstry:v1:view";
const ATTEST_INFO: &[u8] = b"typstry:v1:attest";
const GROUP_INFO_KEY_INFO: &[u8] = b"typstry:v1:group-info-key";
const KEYRING_KEY_INFO: &[u8] = b"typstry:v1:keyring-key";
const KEY_ID_INFO: &[u8] = b"typstry:v1:key-id";

pub const SALT_LEN: usize = 16;
pub type Salt = [u8; SALT_LEN];
const TAG_LEN: usize = 16;
pub const KEY_LEN: usize = 32;
pub const SIGNATURE_LEN: usize = 64;

/// An Ed25519 public key, the way device keys and attestation keys travel.
pub type PublicKey = [u8; KEY_LEN];
/// The attestation key's signature over a device key and a generation.
pub type Attestation = [u8; SIGNATURE_LEN];

/// First byte of a sealed blob, profile, presence update, group info or
/// keyring.
pub const SEAL_VERSION: u8 = 1;
/// First byte of a doc record's ciphertext field.
pub const RECORD_VERSION: u8 = 1;
/// First byte of the keyring plaintext.
pub const KEYRING_VERSION: u8 = 1;
/// First byte of an edit secret, followed by 32 key bytes.
pub const SECRET_EDIT_V1: u8 = 1;
/// First byte of a view secret, followed by the view key and the
/// attestation public key.
pub const SECRET_VIEW_V1: u8 = 2;

/// Bytes [`SealKey::seal`] adds: the version, the salt, the IV and the GCM
/// tag.
pub const SEAL_OVERHEAD: usize = 1 + SALT_LEN + IV_LEN + TAG_LEN;
/// Bytes [`DocKeys::seal_blob`] adds: [`SEAL_OVERHEAD`] and the generation.
pub const BLOB_OVERHEAD: usize = SEAL_OVERHEAD + 4;

const VIEW_KEY_BYTES: usize = 2 * KEY_LEN;
const KEY_ID_BYTES: usize = 9;
const KEY_ID_TAG_BYTES: usize = KEY_ID_BYTES - 4;
/// Presence updates are `version || epoch || leaf || salt || iv || ct+tag
/// || signature`.
const PRESENCE_PREFIX: usize = 1 + 8 + 4;
const RECORD_TRAILER: usize = KEY_LEN + 2 * SIGNATURE_LEN;

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
    /// The data is sealed under a generation the keyring does not reach
    /// yet. Fetch the current keyring and try again.
    #[error("data is from key generation {0}, which this keyring does not have")]
    UnknownGeneration(u32),
    #[error("malformed record: {0}")]
    MalformedRecord(String),
    #[error("malformed keyring: {0}")]
    MalformedKeyring(String),
    #[error("sealed data is truncated")]
    Truncated,
    /// The author is not an editor of the project, or the attestation that
    /// says so does not hold up.
    #[error("record author is not an editor of this project")]
    NotEditor,
    /// A signature does not match its author's key, or the data was
    /// tampered with.
    #[error("signature does not verify")]
    BadSignature,
    /// Wrong key or context, or tampered data; GCM cannot tell which.
    #[error("decryption failed")]
    Decrypt,
    /// Presence from an epoch other than the current one. Drop it.
    #[error("sealed for epoch {0}, which is not the current one")]
    WrongEpoch(u64),
    #[error("a view-only key cannot sign or attest")]
    ReadOnly,
    /// The version or kind byte is one this build does not know.
    #[error("made by a newer version of typstry (format {0}); update typstry to read it")]
    NewerVersion(u8),
}

/// A record after decryption, with the header it was authenticated under
/// and the device key that wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedRecord {
    pub record: Record,
    pub plaintext: Vec<u8>,
    pub signer_pub: PublicKey,
}

pub(crate) fn random<const N: usize>() -> [u8; N] {
    let mut out = [0; N];
    getrandom::fill(&mut out).expect("OS random source unavailable");
    out
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &[&[u8]]) -> Zeroizing<[u8; KEY_LEN]> {
    let mut out = Zeroizing::new([0; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand_multi_info(info, out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

fn verify(public: &PublicKey, message: &[u8], signature: &[u8]) -> Result<(), CryptoError> {
    let public = VerifyingKey::from_bytes(public).map_err(|_| CryptoError::BadSignature)?;
    let signature = Signature::from_slice(signature).map_err(|_| CryptoError::BadSignature)?;
    public
        .verify_strict(message, &signature)
        .map_err(|_| CryptoError::BadSignature)
}

fn attestation_message(signer: &PublicKey, generation: u32) -> Vec<u8> {
    [ATTEST_CONTEXT, &generation.to_be_bytes(), signer].concat()
}

/// Whether `attestation` is `attest_pub`'s statement that `signer` is an
/// editor in `generation`.
pub fn verify_attestation(
    attest_pub: &PublicKey,
    signer: &PublicKey,
    generation: u32,
    attestation: &Attestation,
) -> bool {
    verify(
        attest_pub,
        &attestation_message(signer, generation),
        attestation,
    )
    .is_ok()
}

/// Encrypts `plaintext` in place after `prefix || salt || iv` and appends
/// the tag. The prefix (version, and for blobs the generation) is bound as
/// associated data together with the context, so it cannot be relabelled.
fn seal_raw(
    key: &[u8; KEY_LEN],
    prefix: &[u8],
    context: &str,
    plaintext: &[u8],
    salt: &Salt,
    iv: &Iv,
) -> Vec<u8> {
    let at = prefix.len() + SALT_LEN + IV_LEN;
    let mut sealed = Vec::with_capacity(at + plaintext.len() + TAG_LEN);
    sealed.extend_from_slice(prefix);
    sealed.extend_from_slice(salt);
    sealed.extend_from_slice(iv);
    sealed.extend_from_slice(plaintext);
    let tag = cipher(key, salt, context)
        .encrypt_inout_detached(
            &Nonce::from(*iv),
            &[prefix, context.as_bytes()].concat(),
            (&mut sealed[at..]).into(),
        )
        .expect("AES-GCM encryption does not fail for in-memory buffers");
    sealed.extend_from_slice(&tag);
    sealed
}

/// Inverse of [`seal_raw`]; the caller has checked the prefix already.
fn open_raw(
    key: &[u8; KEY_LEN],
    prefix_len: usize,
    sealed: &[u8],
    context: &str,
) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < prefix_len + SEAL_OVERHEAD - 1 {
        return Err(CryptoError::Truncated);
    }
    let (prefix, rest) = sealed.split_at(prefix_len);
    let (salt, rest) = rest
        .split_first_chunk::<SALT_LEN>()
        .expect("length checked");
    let (iv, ct) = rest.split_first_chunk::<IV_LEN>().expect("length checked");
    cipher(key, salt, context)
        .decrypt(
            &Nonce::from(*iv),
            Payload {
                msg: ct,
                aad: &[prefix, context.as_bytes()].concat(),
            },
        )
        .map_err(|_| CryptoError::Decrypt)
}

fn cipher(key: &[u8; KEY_LEN], salt: &Salt, context: &str) -> Aes256Gcm {
    let key = hkdf(key, salt, &[context.as_bytes()]);
    Aes256Gcm::new_from_slice(key.as_ref()).expect("HKDF yields a 32-byte key")
}

fn check_seal_version(sealed: &[u8]) -> Result<(), CryptoError> {
    match sealed.first() {
        None => Err(CryptoError::Truncated),
        Some(&SEAL_VERSION) => Ok(()),
        // Versions start at 1. Only a higher byte means a newer build wrote this.
        Some(&other) if other > SEAL_VERSION => Err(CryptoError::NewerVersion(other)),
        Some(_) => Err(CryptoError::Decrypt),
    }
}

/// A symmetric key that seals and opens `version || salt || iv ||
/// ciphertext+tag`, for the data keyed straight off a link: the group info
/// and the keyring.
pub struct SealKey(Zeroizing<[u8; KEY_LEN]>);

impl std::fmt::Debug for SealKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealKey").finish_non_exhaustive()
    }
}

impl SealKey {
    pub fn new(key: [u8; KEY_LEN]) -> Self {
        Self(Zeroizing::new(key))
    }

    /// Binds `context` (one of the `*_CONTEXT` constants) so a sealed value
    /// cannot be passed off as another kind.
    pub fn seal(&self, plaintext: &[u8], context: &str) -> Vec<u8> {
        seal_raw(
            &self.0,
            &[SEAL_VERSION],
            context,
            plaintext,
            &random(),
            &random(),
        )
    }

    /// [`Self::seal`] with a caller-chosen salt and IV, for byte-stable
    /// fixtures. Never reuse a pair outside tests, see
    /// [`DocKeys::encrypt_delta_with`].
    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn seal_with(&self, plaintext: &[u8], context: &str, iv: &Iv, salt: &Salt) -> Vec<u8> {
        seal_raw(&self.0, &[SEAL_VERSION], context, plaintext, salt, iv)
    }

    pub fn open(&self, sealed: &[u8], context: &str) -> Result<Vec<u8>, CryptoError> {
        check_seal_version(sealed)?;
        open_raw(&self.0, 1, sealed, context)
    }
}

/// What a share link holds: the view key and the attestation key, whose
/// private half only an edit secret has.
#[derive(Clone)]
pub struct LinkSecret {
    view_key: Zeroizing<[u8; KEY_LEN]>,
    attest_pub: PublicKey,
    /// The edit secret and the key derived from it. Only edit links have it.
    edit: Option<(Zeroizing<[u8; KEY_LEN]>, SigningKey)>,
}

// The secrets must never end up in logs.
impl std::fmt::Debug for LinkSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkSecret")
            .field("fingerprint", &self.fingerprint())
            .field("can_attest", &self.can_attest())
            .finish_non_exhaustive()
    }
}

impl LinkSecret {
    /// A fresh edit secret.
    pub fn generate_edit() -> Self {
        Self::from_edit_seed(Zeroizing::new(random()))
    }

    fn from_edit_seed(seed: Zeroizing<[u8; KEY_LEN]>) -> Self {
        let view_key = hkdf(seed.as_ref(), &[], &[VIEW_INFO]);
        let attest = SigningKey::from_bytes(&hkdf(seed.as_ref(), &[], &[ATTEST_INFO]));
        Self {
            view_key,
            attest_pub: attest.verifying_key().to_bytes(),
            edit: Some((seed, attest)),
        }
    }

    /// Parses the shareable form, base64url without padding the way it
    /// appears in a share link's fragment: a kind byte, then 32 key bytes
    /// for an edit secret or 64 for a view secret.
    pub fn from_base64url(raw: &str) -> Result<Self, CryptoError> {
        let bytes = Zeroizing::new(
            BASE64URL
                .decode(raw)
                .map_err(|_| CryptoError::MalformedKey)?,
        );
        let Some((&kind, key)) = bytes.split_first() else {
            return Err(CryptoError::MalformedKey);
        };
        match (kind, key.len()) {
            (SECRET_EDIT_V1, KEY_LEN) => Ok(Self::from_edit_seed(Zeroizing::new(
                key.try_into().expect("length checked"),
            ))),
            (SECRET_VIEW_V1, VIEW_KEY_BYTES) => {
                let (view_key, attest_pub) = key.split_at(KEY_LEN);
                let attest_pub: PublicKey = attest_pub.try_into().expect("split at 32 of 64");
                VerifyingKey::from_bytes(&attest_pub).map_err(|_| CryptoError::MalformedKey)?;
                Ok(Self {
                    view_key: Zeroizing::new(view_key.try_into().expect("split at 32 of 64")),
                    attest_pub,
                    edit: None,
                })
            }
            // No kind was ever 0, so this is a corrupt key, not a newer one.
            (0 | SECRET_EDIT_V1 | SECRET_VIEW_V1, _) => Err(CryptoError::MalformedKey),
            // Too short to carry a key, so a truncated link rather than a
            // newer one.
            _ if bytes.len() <= KEY_LEN || bytes.len() == VIEW_KEY_BYTES => {
                Err(CryptoError::MalformedKey)
            }
            _ => Err(CryptoError::NewerVersion(kind)),
        }
    }

    /// The shareable form of this secret, whichever kind it is.
    pub fn to_base64url(&self) -> Zeroizing<String> {
        match &self.edit {
            Some((seed, _)) => {
                let mut bytes = Zeroizing::new([0; 1 + KEY_LEN]);
                bytes[0] = SECRET_EDIT_V1;
                bytes[1..].copy_from_slice(seed.as_ref());
                Zeroizing::new(BASE64URL.encode(bytes.as_ref()))
            }
            None => self.view_secret(),
        }
    }

    /// The shareable view secret: the view key and the attestation public
    /// key.
    pub fn view_secret(&self) -> Zeroizing<String> {
        let mut bytes = Zeroizing::new([0; 1 + VIEW_KEY_BYTES]);
        bytes[0] = SECRET_VIEW_V1;
        bytes[1..=KEY_LEN].copy_from_slice(self.view_key.as_ref());
        bytes[1 + KEY_LEN..].copy_from_slice(&self.attest_pub);
        Zeroizing::new(BASE64URL.encode(bytes.as_ref()))
    }

    /// Whether this is an edit secret, which is what attesting takes.
    pub fn can_attest(&self) -> bool {
        self.edit.is_some()
    }

    /// The key that verifies attestations and the keyring's signature.
    pub fn attest_pub(&self) -> PublicKey {
        self.attest_pub
    }

    /// A short public tag of this secret, safe to log and compare.
    pub fn fingerprint(&self) -> String {
        let id = hkdf(
            self.view_key.as_ref(),
            &[],
            &[KEY_ID_INFO, &self.attest_pub],
        );
        BASE64URL.encode(&id[..KEY_ID_BYTES])
    }

    /// Seals the GroupInfo stored on the server, so only link holders can
    /// read it and join.
    pub fn gi_key(&self) -> SealKey {
        SealKey(hkdf(self.view_key.as_ref(), &[], &[GROUP_INFO_KEY_INFO]))
    }

    /// Seals the keyring stored on the server.
    pub fn keyring_key(&self) -> SealKey {
        SealKey(hkdf(self.view_key.as_ref(), &[], &[KEYRING_KEY_INFO]))
    }

    /// The statement that the device key `signer` may write in `generation`.
    /// Only an edit secret can make it.
    pub fn attest(&self, signer: &PublicKey, generation: u32) -> Result<Attestation, CryptoError> {
        let (_, attest) = self.edit.as_ref().ok_or(CryptoError::ReadOnly)?;
        Ok(attest
            .sign(&attestation_message(signer, generation))
            .to_bytes())
    }

    /// Whether `attestation` is this link's statement that `signer` is an
    /// editor in `generation`.
    pub fn verify_attestation(
        &self,
        signer: &PublicKey,
        generation: u32,
        attestation: &Attestation,
    ) -> bool {
        verify_attestation(&self.attest_pub, signer, generation, attestation)
    }

    fn sign(&self, message: &[u8]) -> Result<[u8; SIGNATURE_LEN], CryptoError> {
        let (_, attest) = self.edit.as_ref().ok_or(CryptoError::ReadOnly)?;
        Ok(attest.sign(message).to_bytes())
    }
}

/// The doc keys of every generation up to the current one, with the
/// attestation key that was current in each.
#[derive(Clone)]
pub struct Keyring {
    keys: Vec<Zeroizing<[u8; KEY_LEN]>>,
    attest_pubs: Vec<PublicKey>,
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keyring")
            .field("generation", &self.generation())
            .finish_non_exhaustive()
    }
}

impl Keyring {
    /// The keyring of a new project: generation 1 under `link`.
    pub fn new(link: &LinkSecret) -> Self {
        Self::first(link, Zeroizing::new(random()))
    }

    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn new_with(link: &LinkSecret, key: [u8; KEY_LEN]) -> Self {
        Self::first(link, Zeroizing::new(key))
    }

    fn first(link: &LinkSecret, key: Zeroizing<[u8; KEY_LEN]>) -> Self {
        Self {
            keys: vec![key],
            attest_pubs: vec![link.attest_pub],
        }
    }

    /// The keyring after a rotation to `link`: everything up to now, plus a
    /// fresh doc key for the next generation.
    pub fn next(&self, link: &LinkSecret) -> Self {
        let mut next = self.clone();
        next.keys.push(Zeroizing::new(random()));
        next.attest_pubs.push(link.attest_pub);
        next
    }

    pub fn generation(&self) -> u32 {
        self.keys.len() as u32
    }

    /// The attestation public key of each generation, oldest first.
    pub fn attest_pubs(&self) -> &[PublicKey] {
        &self.attest_pubs
    }

    fn key(&self, generation: u32) -> Option<&[u8; KEY_LEN]> {
        let at = usize::try_from(generation.checked_sub(1)?).ok()?;
        self.keys.get(at).map(|key| &**key)
    }

    /// The keyring unprotected, for a client's own local state. Anything that
    /// leaves the device goes through [`Self::seal_signed`].
    pub fn export(&self) -> Zeroizing<Vec<u8>> {
        self.to_plain()
    }

    /// Inverse of [`Self::export`].
    pub fn import(plain: &[u8]) -> Result<Self, CryptoError> {
        Self::from_plain(plain)
    }

    fn to_plain(&self) -> Zeroizing<Vec<u8>> {
        let mut out = Zeroizing::new(Vec::new());
        out.push(KEYRING_VERSION);
        out.extend_from_slice(&self.generation().to_be_bytes());
        for (key, attest_pub) in self.keys.iter().zip(&self.attest_pubs) {
            out.extend_from_slice(key.as_ref());
            out.extend_from_slice(attest_pub);
        }
        out
    }

    fn from_plain(plain: &[u8]) -> Result<Self, CryptoError> {
        let bad = |why: &str| CryptoError::MalformedKeyring(why.into());
        let (&version, rest) = plain.split_first().ok_or_else(|| bad("empty"))?;
        if version != KEYRING_VERSION {
            return Err(CryptoError::NewerVersion(version));
        }
        let (count, mut rest) = rest.split_first_chunk::<4>().ok_or_else(|| bad("short"))?;
        let count = u32::from_be_bytes(*count) as usize;
        // Checked against the bytes left before allocating from the count.
        if count == 0 || rest.len() / (2 * KEY_LEN) < count {
            return Err(bad("generation count does not fit"));
        }
        let mut keys = Vec::with_capacity(count);
        let mut attest_pubs = Vec::with_capacity(count);
        for _ in 0..count {
            let (key, tail) = rest.split_at(KEY_LEN);
            let (attest_pub, tail) = tail.split_at(KEY_LEN);
            keys.push(Zeroizing::new(key.try_into().expect("split at 32")));
            attest_pubs.push(attest_pub.try_into().expect("split at 32"));
            rest = tail;
        }
        if !rest.is_empty() {
            return Err(bad("trailing bytes"));
        }
        Ok(Self { keys, attest_pubs })
    }

    /// Seals the keyring under `link`'s keyring key and signs the result
    /// with its attestation key: `sealed || signature`. Signing is what
    /// keeps a viewer, who can derive the sealing key, from forging one.
    pub fn seal_signed(&self, link: &LinkSecret) -> Result<Vec<u8>, CryptoError> {
        self.finish_seal(
            link,
            link.keyring_key().seal(&self.to_plain(), KEYRING_CONTEXT),
        )
    }

    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn seal_signed_with(
        &self,
        link: &LinkSecret,
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        let sealed = link
            .keyring_key()
            .seal_with(&self.to_plain(), KEYRING_CONTEXT, iv, salt);
        self.finish_seal(link, sealed)
    }

    fn finish_seal(&self, link: &LinkSecret, mut sealed: Vec<u8>) -> Result<Vec<u8>, CryptoError> {
        let signature = link.sign(&[KEYRING_SIGNATURE_CONTEXT, &sealed].concat())?;
        sealed.extend_from_slice(&signature);
        Ok(sealed)
    }

    /// Checks the signature against `link`'s attestation key, opens the
    /// keyring and checks that it belongs to this link.
    pub fn open_verified(link: &LinkSecret, bytes: &[u8]) -> Result<Self, CryptoError> {
        check_seal_version(bytes)?;
        if bytes.len() < SEAL_OVERHEAD + SIGNATURE_LEN {
            return Err(CryptoError::Truncated);
        }
        let (sealed, signature) = bytes.split_at(bytes.len() - SIGNATURE_LEN);
        verify(
            &link.attest_pub,
            &[KEYRING_SIGNATURE_CONTEXT, sealed].concat(),
            signature,
        )?;
        let plain = Zeroizing::new(link.keyring_key().open(sealed, KEYRING_CONTEXT)?);
        let keyring = Self::from_plain(&plain)?;
        // The link's own key must be the newest one, or the keyring is for
        // another generation and the link would read the wrong history.
        if keyring.attest_pubs.last() != Some(&link.attest_pub) {
            return Err(CryptoError::KeyMismatch(link.fingerprint()));
        }
        Ok(keyring)
    }
}

/// Signs records and presence on behalf of one device and says what the
/// project's editors vouched for it. The MLS leaf key is the usual
/// implementation; the trait keeps this module free of MLS.
pub trait RecordSigner {
    /// The Ed25519 public key signatures verify under.
    fn public_key(&self) -> PublicKey;
    fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_LEN];
    /// This device's attestation for `generation`, if an editor made one.
    /// `None` means the device cannot write in that generation.
    fn attestation(&self, generation: u32) -> Option<Attestation>;
}

/// A bare device key and the attestation an editor made for it. What an MLS
/// member signs with, and what tests and tools use to write records outside
/// a group.
pub struct LocalSigner {
    key: SigningKey,
    attestation: Option<(u32, Attestation)>,
}

impl LocalSigner {
    /// A key with no attestation, which can sign presence but not records.
    pub fn new(seed: [u8; 32]) -> Self {
        Self::from_key(SigningKey::from_bytes(&seed), None)
    }

    pub(crate) fn from_key(key: SigningKey, attestation: Option<(u32, Attestation)>) -> Self {
        Self { key, attestation }
    }

    /// An editor's device: `link` attests the key for `generation`. Fails
    /// with `ReadOnly` for a view link.
    pub fn try_attested(
        seed: [u8; 32],
        link: &LinkSecret,
        generation: u32,
    ) -> Result<Self, CryptoError> {
        let mut signer = Self::new(seed);
        let attestation = link.attest(&signer.public_key(), generation)?;
        signer.attestation = Some((generation, attestation));
        Ok(signer)
    }

    /// [`Self::try_attested`] for an edit link the caller knows it holds.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub fn attested(seed: [u8; 32], link: &LinkSecret, generation: u32) -> Self {
        Self::try_attested(seed, link, generation).expect("an edit link attests")
    }
}

impl RecordSigner for LocalSigner {
    fn public_key(&self) -> PublicKey {
        self.key.verifying_key().to_bytes()
    }

    fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_LEN] {
        self.key.sign(message).to_bytes()
    }

    fn attestation(&self, generation: u32) -> Option<Attestation> {
        self.attestation
            .filter(|(attested, _)| *attested == generation)
            .map(|(_, attestation)| attestation)
    }
}

/// A keyring's keys put to work: records, blobs and profiles of every
/// generation it holds.
#[derive(Debug, Clone)]
pub struct DocKeys {
    keyring: Keyring,
    key_ids: Vec<String>,
}

impl DocKeys {
    pub fn new(keyring: Keyring) -> Self {
        let key_ids = keyring
            .keys
            .iter()
            .enumerate()
            .map(|(i, key)| {
                let tag = hkdf(key.as_ref(), &[], &[KEY_ID_INFO]);
                let mut id = [0; KEY_ID_BYTES];
                id[..4].copy_from_slice(&(i as u32 + 1).to_be_bytes());
                id[4..].copy_from_slice(&tag[..KEY_ID_TAG_BYTES]);
                BASE64URL.encode(id)
            })
            .collect();
        Self { keyring, key_ids }
    }

    pub fn keyring(&self) -> &Keyring {
        &self.keyring
    }

    /// The generation new data is written in.
    pub fn generation(&self) -> u32 {
        self.keyring.generation()
    }

    /// The short fingerprint sent in clear with every record of the current
    /// generation: the generation, then a tag of its key. It lets a reader
    /// tell a wrong key, a newer generation and corrupted data apart.
    pub fn key_id(&self) -> &str {
        self.key_ids.last().expect("a keyring has a generation")
    }

    fn current(&self) -> &[u8; KEY_LEN] {
        self.keyring
            .key(self.generation())
            .expect("a keyring has a generation")
    }

    /// Seals `plaintext` as `version || generation || salt || iv ||
    /// ciphertext+tag` under the current doc key, binding `context` (one of
    /// the `*_CONTEXT` constants).
    pub fn seal(&self, plaintext: &[u8], context: &str) -> Vec<u8> {
        self.seal_raw(plaintext, context, &random(), &random())
    }

    pub fn seal_blob(&self, plaintext: &[u8]) -> Vec<u8> {
        self.seal(plaintext, BLOB_CONTEXT)
    }

    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn seal_with(&self, plaintext: &[u8], context: &str, iv: &Iv, salt: &Salt) -> Vec<u8> {
        self.seal_raw(plaintext, context, salt, iv)
    }

    fn seal_raw(&self, plaintext: &[u8], context: &str, salt: &Salt, iv: &Iv) -> Vec<u8> {
        let mut prefix = [SEAL_VERSION, 0, 0, 0, 0];
        prefix[1..].copy_from_slice(&self.generation().to_be_bytes());
        seal_raw(self.current(), &prefix, context, plaintext, salt, iv)
    }

    /// Inverse of [`Self::seal`], for any generation the keyring holds.
    /// Sealed data carries no key id, so a wrong keyring shows up as
    /// [`CryptoError::Decrypt`].
    pub fn open(&self, sealed: &[u8], context: &str) -> Result<Vec<u8>, CryptoError> {
        check_seal_version(sealed)?;
        let Some((generation, _)) = sealed[1..].split_first_chunk::<4>() else {
            return Err(CryptoError::Truncated);
        };
        let generation = u32::from_be_bytes(*generation);
        let key = self
            .keyring
            .key(generation)
            .ok_or(CryptoError::UnknownGeneration(generation))?;
        open_raw(key, 5, sealed, context)
    }

    pub fn open_blob(&self, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
        self.open(sealed, BLOB_CONTEXT)
    }

    /// Encrypts the Loro updates for ops `[start, end)` of `peer` into a
    /// signed delta record.
    ///
    /// # Panics
    ///
    /// When the span is empty.
    pub fn encrypt_delta(
        &self,
        signer: &dyn RecordSigner,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_delta(signer, peer, start, end, plaintext, &random(), &random())
    }

    /// Encrypts a Loro snapshot covering `vv` into a signed snapshot record.
    pub fn encrypt_snapshot(
        &self,
        signer: &dyn RecordSigner,
        vv: &[(u64, u64)],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_snapshot(signer, vv, plaintext, &random(), &random())
    }

    /// Reusing a salt and IV breaks the encryption of both messages; this
    /// exists so tests can produce byte-stable records, and is compiled out
    /// of everything else.
    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn encrypt_delta_with(
        &self,
        signer: &dyn RecordSigner,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_delta(signer, peer, start, end, plaintext, iv, salt)
    }

    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn encrypt_snapshot_with(
        &self,
        signer: &dyn RecordSigner,
        vv: &[(u64, u64)],
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        self.seal_snapshot(signer, vv, plaintext, iv, salt)
    }

    #[allow(clippy::too_many_arguments)]
    fn seal_delta(
        &self,
        signer: &dyn RecordSigner,
        peer: u64,
        start: u64,
        end: u64,
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        let header = encode_delta_header(peer, start, end, self.key_id(), iv);
        self.seal_record(signer, &header, iv, salt, plaintext)
    }

    fn seal_snapshot(
        &self,
        signer: &dyn RecordSigner,
        vv: &[(u64, u64)],
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Result<Vec<u8>, CryptoError> {
        let header = encode_snapshot_header(vv, self.key_id(), iv);
        self.seal_record(signer, &header, iv, salt, plaintext)
    }

    /// A record's ciphertext field is `version || salt || ciphertext+tag ||
    /// signer_pub || attestation || signature`, the signature covering the
    /// header and everything before it. The header itself is fixed by
    /// loro-protocol and read by the server, so the version cannot go there.
    fn seal_record(
        &self,
        signer: &dyn RecordSigner,
        header: &[u8],
        iv: &Iv,
        salt: &Salt,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        let attestation = signer
            .attestation(self.generation())
            .ok_or(CryptoError::ReadOnly)?;
        // Laid out as the signed message, `RECORD_SIGNATURE_CONTEXT ||
        // header || version || salt || ciphertext+tag || signer_pub ||
        // attestation`, with the plaintext encrypted where it lies, so the
        // record body is the tail of it plus the signature.
        let body_at = RECORD_SIGNATURE_CONTEXT.len() + header.len();
        let ct_at = body_at + 1 + SALT_LEN;
        let mut message = Vec::with_capacity(ct_at + plaintext.len() + TAG_LEN + RECORD_TRAILER);
        message.extend_from_slice(RECORD_SIGNATURE_CONTEXT);
        message.extend_from_slice(header);
        message.push(RECORD_VERSION);
        message.extend_from_slice(salt);
        message.extend_from_slice(plaintext);
        let tag = cipher(self.current(), salt, RECORD_CONTEXT)
            .encrypt_inout_detached(
                &Nonce::from(*iv),
                &record_aad(RECORD_VERSION, header),
                (&mut message[ct_at..]).into(),
            )
            .expect("AES-GCM encryption does not fail for in-memory buffers");
        message.extend_from_slice(&tag);
        message.extend_from_slice(&signer.public_key());
        message.extend_from_slice(&attestation);
        let signature = signer.sign(&message);
        message.extend_from_slice(&signature);
        Ok(encode_record(header, &message[body_at..]))
    }

    /// Parses, verifies and decrypts one record of either kind.
    pub fn decrypt_record(&self, record: &[u8]) -> Result<DecryptedRecord, CryptoError> {
        let sealed = SealedRecord::parse(record).map_err(CryptoError::MalformedRecord)?;
        let (plaintext, signer_pub) = self.open_record(&sealed)?;
        Ok(DecryptedRecord {
            record: sealed.record,
            plaintext,
            signer_pub,
        })
    }

    /// Verifies and decrypts a record that is already parsed, for callers
    /// that need its header even when decryption fails. Returns the
    /// plaintext and the device key that signed it.
    ///
    /// The attestation is checked first, then the record signature, and only
    /// then is anything decrypted, so a record by someone who is not an
    /// editor is refused whatever it decrypts to.
    pub fn open_record(
        &self,
        sealed: &SealedRecord<'_>,
    ) -> Result<(Vec<u8>, PublicKey), CryptoError> {
        let generation = self.generation_of(&sealed.key_id)?;
        let Some(&version) = sealed.ct.first() else {
            return Err(CryptoError::Truncated);
        };
        // Before the signature: a newer version may well sign differently.
        if version > RECORD_VERSION {
            return Err(CryptoError::NewerVersion(version));
        }
        if version != RECORD_VERSION {
            return Err(CryptoError::MalformedRecord(format!(
                "unknown record version {version}"
            )));
        }
        if sealed.ct.len() < 1 + SALT_LEN + TAG_LEN + RECORD_TRAILER {
            return Err(CryptoError::Truncated);
        }
        let (body, signature) = sealed.ct.split_at(sealed.ct.len() - SIGNATURE_LEN);
        let (ciphertext, trailer) = body.split_at(body.len() - KEY_LEN - SIGNATURE_LEN);
        let (signer_pub, attestation) = trailer.split_at(KEY_LEN);
        let signer_pub: PublicKey = signer_pub.try_into().expect("split at 32");
        let attestation: Attestation = attestation.try_into().expect("split at 64");

        let attest_pub = &self.keyring.attest_pubs[generation as usize - 1];
        if !verify_attestation(attest_pub, &signer_pub, generation, &attestation) {
            return Err(CryptoError::NotEditor);
        }
        verify(
            &signer_pub,
            &[RECORD_SIGNATURE_CONTEXT, sealed.aad, body].concat(),
            signature,
        )?;
        let (salt, ct) = ciphertext[1..]
            .split_first_chunk::<SALT_LEN>()
            .expect("length checked");
        let key = self.keyring.key(generation).expect("generation checked");
        let plaintext = cipher(key, salt, RECORD_CONTEXT)
            .decrypt(
                &Nonce::from(sealed.iv),
                Payload {
                    msg: ct,
                    aad: &record_aad(version, sealed.aad),
                },
            )
            .map_err(|_| CryptoError::Decrypt)?;
        Ok((plaintext, signer_pub))
    }

    /// Resolves a header key id to a generation this keyring holds.
    fn generation_of(&self, key_id: &str) -> Result<u32, CryptoError> {
        let mismatch = || CryptoError::KeyMismatch(key_id.to_owned());
        let raw = BASE64URL.decode(key_id).map_err(|_| mismatch())?;
        let (generation, _) = raw
            .split_first_chunk::<4>()
            .filter(|_| raw.len() == KEY_ID_BYTES)
            .ok_or_else(mismatch)?;
        let generation = u32::from_be_bytes(*generation);
        if generation == 0 {
            return Err(mismatch());
        }
        if generation > self.generation() {
            return Err(CryptoError::UnknownGeneration(generation));
        }
        if self.key_ids[generation as usize - 1] != key_id {
            return Err(mismatch());
        }
        Ok(generation)
    }
}

/// The version goes into the associated data as well, so data cannot be
/// relabelled as another version without failing authentication.
fn record_aad(version: u8, header: &[u8]) -> Vec<u8> {
    [&[version], header].concat()
}

/// The per-epoch key of presence: ephemeral cursors and names, sealed under
/// an MLS exporter secret so a removed member loses it with the next epoch,
/// and signed with the sender's device key so nobody can speak as another
/// member.
pub struct PresenceKey {
    epoch: u64,
    key: Zeroizing<[u8; KEY_LEN]>,
}

impl std::fmt::Debug for PresenceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PresenceKey")
            .field("epoch", &self.epoch)
            .finish_non_exhaustive()
    }
}

impl PresenceKey {
    /// `secret` is the MLS exporter secret of `epoch`.
    pub fn new(epoch: u64, secret: [u8; KEY_LEN]) -> Self {
        Self {
            epoch,
            key: Zeroizing::new(secret),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Seals `plaintext` as `version || epoch || leaf || salt || iv ||
    /// ciphertext+tag || signature` for the member at `leaf`.
    pub fn seal(&self, signer: &dyn RecordSigner, leaf: u32, plaintext: &[u8]) -> Vec<u8> {
        self.seal_raw(signer, leaf, plaintext, &random(), &random())
    }

    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn seal_with(
        &self,
        signer: &dyn RecordSigner,
        leaf: u32,
        plaintext: &[u8],
        iv: &Iv,
        salt: &Salt,
    ) -> Vec<u8> {
        self.seal_raw(signer, leaf, plaintext, salt, iv)
    }

    fn seal_raw(
        &self,
        signer: &dyn RecordSigner,
        leaf: u32,
        plaintext: &[u8],
        salt: &Salt,
        iv: &Iv,
    ) -> Vec<u8> {
        let mut prefix = [SEAL_VERSION; PRESENCE_PREFIX];
        prefix[1..9].copy_from_slice(&self.epoch.to_be_bytes());
        prefix[9..].copy_from_slice(&leaf.to_be_bytes());
        let mut sealed = seal_raw(&self.key, &prefix, PRESENCE_CONTEXT, plaintext, salt, iv);
        let signature = signer.sign(&[PRESENCE_SIGNATURE_CONTEXT, &sealed].concat());
        sealed.extend_from_slice(&signature);
        sealed
    }

    /// Opens an update from the current epoch. `signer_of` maps a leaf to
    /// the device key it holds in this epoch, which the signature has to
    /// match. Returns the sending leaf and the plaintext. An update from any
    /// other epoch is [`CryptoError::WrongEpoch`], which callers drop.
    pub fn open(
        &self,
        sealed: &[u8],
        signer_of: impl Fn(u32) -> Option<PublicKey>,
    ) -> Result<(u32, Vec<u8>), CryptoError> {
        check_seal_version(sealed)?;
        if sealed.len() < PRESENCE_PREFIX + SEAL_OVERHEAD - 1 + SIGNATURE_LEN {
            return Err(CryptoError::Truncated);
        }
        let epoch = u64::from_be_bytes(sealed[1..9].try_into().expect("length checked"));
        if epoch != self.epoch {
            return Err(CryptoError::WrongEpoch(epoch));
        }
        let leaf = u32::from_be_bytes(sealed[9..13].try_into().expect("length checked"));
        let (body, signature) = sealed.split_at(sealed.len() - SIGNATURE_LEN);
        let signer = signer_of(leaf).ok_or(CryptoError::BadSignature)?;
        verify(
            &signer,
            &[PRESENCE_SIGNATURE_CONTEXT, body].concat(),
            signature,
        )?;
        let plaintext = open_raw(&self.key, PRESENCE_PREFIX, body, PRESENCE_CONTEXT)?;
        Ok((leaf, plaintext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The edit kind byte, then key bytes 0..32.
    const RAW: &str = "AQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";

    fn link() -> LinkSecret {
        LinkSecret::from_base64url(RAW).unwrap()
    }

    fn other_link() -> LinkSecret {
        let mut raw = [9; 1 + KEY_LEN];
        raw[0] = SECRET_EDIT_V1;
        LinkSecret::from_base64url(&BASE64URL.encode(raw)).unwrap()
    }

    fn viewer_link() -> LinkSecret {
        LinkSecret::from_base64url(&link().view_secret()).unwrap()
    }

    fn editor() -> LocalSigner {
        LocalSigner::attested([4; 32], &link(), 1)
    }

    fn keys() -> DocKeys {
        DocKeys::new(Keyring::new_with(&link(), [5; 32]))
    }

    /// A 32-byte string that is not an Ed25519 point.
    fn off_curve() -> [u8; 32] {
        (0..=255)
            .map(|b| [b; 32])
            .find(|bytes| VerifyingKey::from_bytes(bytes).is_err())
            .expect("some repeated byte is off the curve")
    }

    #[test]
    fn parses_only_known_kinds_of_base64url_secrets() {
        assert_eq!(link().fingerprint().len(), 12);
        assert_eq!(LinkSecret::generate_edit().to_base64url().len(), 44);
        assert!(
            LinkSecret::from_base64url(&LinkSecret::generate_edit().to_base64url())
                .is_ok_and(|k| k.can_attest())
        );
        let view = BASE64URL.decode(link().view_secret().as_bytes()).unwrap();
        for bad in [
            "",
            &RAW[..43],
            &format!("{RAW}A"),
            &format!("{RAW}="),
            &RAW.replace('A', "+"),
            &BASE64URL.encode([SECRET_EDIT_V1; 16]),
            &BASE64URL.encode([SECRET_EDIT_V1; 65]),
            &BASE64URL.encode([SECRET_VIEW_V1; 33]),
            &BASE64URL.encode(&view[1..]),
            &BASE64URL.encode([&[SECRET_VIEW_V1][..], &[1; 32], &off_curve()].concat()),
        ] {
            assert!(
                matches!(
                    LinkSecret::from_base64url(bad),
                    Err(CryptoError::MalformedKey)
                ),
                "{bad:?}"
            );
        }
        assert!(!format!("{:?}", link()).contains(RAW));
        assert!(!format!("{:?}", link()).contains(link().view_secret().as_str()));
    }

    #[test]
    fn view_secrets_derive_from_the_edit_secret() {
        let edit = link();
        let view = viewer_link();
        assert!(edit.can_attest());
        assert!(!view.can_attest());
        assert_eq!(view.fingerprint(), edit.fingerprint());
        assert_eq!(view.attest_pub(), edit.attest_pub());
        assert_eq!(view.view_secret(), edit.view_secret());
        assert_eq!(view.view_secret().len(), 87);
        assert_eq!(*edit.to_base64url(), RAW);
        assert_eq!(view.to_base64url(), view.view_secret());
        assert_ne!(other_link().fingerprint(), edit.fingerprint());
        // The view link opens what the edit link sealed.
        let sealed = edit.gi_key().seal(b"gi", GROUP_INFO_CONTEXT);
        assert_eq!(
            view.gi_key().open(&sealed, GROUP_INFO_CONTEXT).unwrap(),
            b"gi"
        );
        assert!(matches!(
            edit.keyring_key().open(&sealed, GROUP_INFO_CONTEXT),
            Err(CryptoError::Decrypt)
        ));
    }

    #[test]
    fn only_edit_links_attest() {
        let device = [3; 32];
        let attestation = link().attest(&device, 2).unwrap();
        assert!(viewer_link().verify_attestation(&device, 2, &attestation));
        assert!(!viewer_link().verify_attestation(&device, 3, &attestation));
        assert!(!viewer_link().verify_attestation(&[4; 32], 2, &attestation));
        assert!(!other_link().verify_attestation(&device, 2, &attestation));
        assert!(matches!(
            viewer_link().attest(&device, 2),
            Err(CryptoError::ReadOnly)
        ));
    }

    #[test]
    fn records_round_trip() {
        let keys = keys();
        let editor = editor();
        let record = keys.encrypt_delta(&editor, 7, 0, 3, b"ops").unwrap();
        let out = keys.decrypt_record(&record).unwrap();
        assert_eq!(out.plaintext, b"ops");
        assert_eq!(out.signer_pub, editor.public_key());
        assert_eq!(
            out.record,
            Record::Delta {
                peer: 7,
                start: 0,
                end: 3
            }
        );

        let record = keys
            .encrypt_snapshot(&editor, &[(9, 1), (10, 2)], b"snapshot")
            .unwrap();
        let out = keys.decrypt_record(&record).unwrap();
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
        let viewer = LocalSigner::new([6; 32]);
        assert!(matches!(
            keys().encrypt_delta(&viewer, 7, 0, 3, b"ops"),
            Err(CryptoError::ReadOnly)
        ));
        assert!(matches!(
            keys().encrypt_snapshot(&viewer, &[(7, 3)], b"snapshot"),
            Err(CryptoError::ReadOnly)
        ));
        // An attestation for another generation does not count either.
        let stale = LocalSigner::attested([6; 32], &link(), 2);
        assert!(matches!(
            keys().encrypt_delta(&stale, 7, 0, 3, b"ops"),
            Err(CryptoError::ReadOnly)
        ));
    }

    /// What a viewer could do with the keyring alone: encrypt a record
    /// correctly, sign it with a key of their own and attach whatever
    /// attestation they like.
    #[test]
    fn records_by_non_editors_are_refused() {
        let keys = keys();
        let forger = LocalSigner::new([7; 32]);
        let header = encode_delta_header(7, 0, 3, keys.key_id(), &[1; IV_LEN]);
        let salt = [2; SALT_LEN];
        let forge = |attestation: Attestation, signer: &dyn RecordSigner| {
            let ct = cipher(keys.current(), &salt, RECORD_CONTEXT)
                .encrypt(
                    &Nonce::from([1; IV_LEN]),
                    Payload {
                        msg: b"forged",
                        aad: &record_aad(RECORD_VERSION, &header),
                    },
                )
                .unwrap();
            let mut body = [&[RECORD_VERSION], &salt[..], &ct].concat();
            body.extend_from_slice(&signer.public_key());
            body.extend_from_slice(&attestation);
            let signature = signer.sign(&[RECORD_SIGNATURE_CONTEXT, &header, &body].concat());
            body.extend_from_slice(&signature);
            encode_record(&header, &body)
        };

        // No attestation at all.
        assert!(matches!(
            keys.decrypt_record(&forge([0; 64], &forger)),
            Err(CryptoError::NotEditor)
        ));
        // Another project's attestation key.
        let foreign = other_link().attest(&forger.public_key(), 1).unwrap();
        assert!(matches!(
            keys.decrypt_record(&forge(foreign, &forger)),
            Err(CryptoError::NotEditor)
        ));
        // An editor's attestation, replayed under the forger's own key.
        let replayed = editor().attestation(1).unwrap();
        assert!(matches!(
            keys.decrypt_record(&forge(replayed, &forger)),
            Err(CryptoError::NotEditor)
        ));
        // A real editor's attestation and key, but signed by someone else.
        let stolen = editor();
        let mut record = forge(stolen.attestation(1).unwrap(), &stolen);
        assert!(keys.decrypt_record(&record).is_ok());
        let last = record.len() - 1;
        record[last] ^= 1;
        assert!(matches!(
            keys.decrypt_record(&record),
            Err(CryptoError::BadSignature)
        ));
    }

    #[test]
    fn wrong_keyring_is_a_mismatch() {
        let record = keys().encrypt_delta(&editor(), 7, 0, 3, b"ops").unwrap();
        let other = DocKeys::new(Keyring::new_with(&link(), [6; 32]));
        assert!(matches!(
            other.decrypt_record(&record),
            Err(CryptoError::KeyMismatch(id)) if id == keys().key_id()
        ));
    }

    #[test]
    fn generations_accumulate_and_stay_readable() {
        let old = keys();
        let record = old.encrypt_delta(&editor(), 7, 0, 3, b"old").unwrap();

        let next_link = other_link();
        let next = DocKeys::new(old.keyring().next(&next_link));
        assert_eq!(next.generation(), 2);
        assert_ne!(next.key_id(), old.key_id());
        let signer = LocalSigner::attested([4; 32], &next_link, 2);
        let fresh = next.encrypt_delta(&signer, 7, 3, 6, b"new").unwrap();

        // The new keyring reads both generations.
        assert_eq!(next.decrypt_record(&record).unwrap().plaintext, b"old");
        assert_eq!(next.decrypt_record(&fresh).unwrap().plaintext, b"new");
        // The old one does not reach the new generation yet.
        assert!(matches!(
            old.decrypt_record(&fresh),
            Err(CryptoError::UnknownGeneration(2))
        ));
        // Writing in generation 2 needs an attestation for it.
        assert!(matches!(
            next.encrypt_delta(&editor(), 7, 3, 6, b"x"),
            Err(CryptoError::ReadOnly)
        ));

        let blob = old.seal_blob(b"blob");
        let new_blob = next.seal_blob(b"blob");
        assert_eq!(next.open_blob(&blob).unwrap(), b"blob");
        assert_eq!(next.open_blob(&new_blob).unwrap(), b"blob");
        assert!(matches!(
            old.open_blob(&new_blob),
            Err(CryptoError::UnknownGeneration(2))
        ));
    }

    #[test]
    fn tampering_is_detected() {
        let keys = keys();
        let record = keys.encrypt_delta(&editor(), 7, 0, 3, b"ops").unwrap();

        // The signature is last; flip a ciphertext byte before it.
        let mut ct = record.clone();
        let at = ct.len() - RECORD_TRAILER - 1;
        ct[at] ^= 1;
        assert!(matches!(
            keys.decrypt_record(&ct),
            Err(CryptoError::BadSignature)
        ));

        // The header is signed too: claiming other ops must fail.
        let mut header = record.clone();
        header[4] = 4;
        assert!(matches!(
            keys.decrypt_record(&header),
            Err(CryptoError::BadSignature)
        ));

        // So is the attestation.
        let mut attestation = record.clone();
        let at = attestation.len() - SIGNATURE_LEN - 1;
        attestation[at] ^= 1;
        assert!(matches!(
            keys.decrypt_record(&attestation),
            Err(CryptoError::NotEditor)
        ));

        assert!(matches!(
            keys.decrypt_record(b"\x07"),
            Err(CryptoError::MalformedRecord(_))
        ));
    }

    #[test]
    fn every_message_gets_its_own_salt() {
        let keys = keys();
        let a = keys.seal_blob(b"blob");
        let b = keys.seal_blob(b"blob");
        assert_ne!(a[5..5 + SALT_LEN], b[5..5 + SALT_LEN]);
        assert_ne!(a, b);
    }

    #[test]
    fn seal_binds_the_context() {
        let keys = keys();
        let sealed = keys.seal_blob(b"blob");
        assert_eq!(sealed.len(), 4 + BLOB_OVERHEAD);
        assert_eq!(keys.open_blob(&sealed).unwrap(), b"blob");
        assert!(matches!(
            keys.open(&sealed, PROFILE_CONTEXT),
            Err(CryptoError::Decrypt)
        ));
        let other = DocKeys::new(Keyring::new_with(&link(), [6; 32]));
        assert!(matches!(
            other.open_blob(&sealed),
            Err(CryptoError::Decrypt)
        ));
        assert!(matches!(
            keys.open_blob(&sealed[..5]),
            Err(CryptoError::Truncated)
        ));
        assert!(matches!(keys.open_blob(&[]), Err(CryptoError::Truncated)));
        // The generation is authenticated: relabelling it fails to open.
        let mut relabelled = sealed.clone();
        relabelled[4] = 1;
        assert!(matches!(
            DocKeys::new(keys.keyring().next(&other_link())).open_blob(&{
                relabelled[4] = 2;
                relabelled
            }),
            Err(CryptoError::Decrypt)
        ));

        let key = link().gi_key();
        let sealed = key.seal(b"gi", GROUP_INFO_CONTEXT);
        assert_eq!(sealed.len(), 2 + SEAL_OVERHEAD);
        assert!(matches!(
            key.open(&sealed, KEYRING_CONTEXT),
            Err(CryptoError::Decrypt)
        ));
    }

    #[test]
    fn unknown_versions_are_newer() {
        let keys = keys();
        let mut sealed = keys.seal_blob(b"blob");
        sealed[0] = SEAL_VERSION + 1;
        assert!(matches!(
            keys.open_blob(&sealed),
            Err(CryptoError::NewerVersion(v)) if v == SEAL_VERSION + 1
        ));
        // A newer format may lay out the rest differently, so don't look
        // at it.
        assert!(matches!(
            keys.open_blob(&[SEAL_VERSION + 1]),
            Err(CryptoError::NewerVersion(_))
        ));
        // A zero version byte is corruption, not a newer format.
        sealed[0] = 0;
        assert!(matches!(
            keys.open_blob(&sealed),
            Err(CryptoError::Decrypt)
        ));

        let record = keys.encrypt_delta(&editor(), 7, 0, 3, b"ops").unwrap();
        let parsed = SealedRecord::parse(&record).unwrap();
        let mut ct = parsed.ct.to_vec();
        ct[0] = RECORD_VERSION + 1;
        let newer = encode_record(parsed.aad, &ct);
        assert!(matches!(
            keys.decrypt_record(&newer),
            Err(CryptoError::NewerVersion(v)) if v == RECORD_VERSION + 1
        ));

        let mut secret = [7; 1 + KEY_LEN];
        secret[0] = 0x7f;
        assert!(matches!(
            LinkSecret::from_base64url(&BASE64URL.encode(secret)),
            Err(CryptoError::NewerVersion(0x7f))
        ));
        secret[0] = 0;
        assert!(matches!(
            LinkSecret::from_base64url(&BASE64URL.encode(secret)),
            Err(CryptoError::MalformedKey)
        ));
    }

    /// Data written as another version and relabelled as the current one
    /// must not authenticate, so the byte cannot be swapped to make a
    /// newer format parse as this one.
    #[test]
    fn version_bytes_are_authenticated() {
        let key = [5; KEY_LEN];
        let salt = [2; SALT_LEN];
        let iv = [1; IV_LEN];
        let ct = cipher(&key, &salt, BLOB_CONTEXT)
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: b"blob",
                    aad: &[
                        &[SEAL_VERSION + 1][..],
                        &1u32.to_be_bytes(),
                        BLOB_CONTEXT.as_bytes(),
                    ]
                    .concat(),
                },
            )
            .unwrap();
        let relabelled = [&[SEAL_VERSION][..], &1u32.to_be_bytes(), &salt, &iv, &ct].concat();
        assert!(matches!(
            keys().open_blob(&relabelled),
            Err(CryptoError::Decrypt)
        ));

        // A record's version is both signed and in the AEAD, so relabelling
        // fails even when an editor re-signs it.
        let keys = keys();
        let editor = editor();
        let header = encode_delta_header(7, 0, 3, keys.key_id(), &iv);
        let ct = cipher(keys.current(), &salt, RECORD_CONTEXT)
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: b"ops",
                    aad: &record_aad(RECORD_VERSION + 1, &header),
                },
            )
            .unwrap();
        let body = [&[RECORD_VERSION][..], &salt, &ct].concat();
        let body = [
            &body[..],
            &editor.public_key(),
            &editor.attestation(1).unwrap(),
        ]
        .concat();
        let signature = editor.sign(&[RECORD_SIGNATURE_CONTEXT, &header, &body].concat());
        let relabelled = encode_record(&header, &[&body[..], &signature].concat());
        assert!(matches!(
            keys.decrypt_record(&relabelled),
            Err(CryptoError::Decrypt)
        ));
    }

    #[test]
    fn keyrings_round_trip_signed() {
        let link = link();
        let keyring = Keyring::new_with(&link, [5; 32]).next(&other_link());
        // Sealed for the newest link, which is the one that opens it.
        let newest = other_link();
        let sealed = keyring.seal_signed(&newest).unwrap();
        let opened = Keyring::open_verified(&newest.clone(), &sealed).unwrap();
        assert_eq!(opened.generation(), 2);
        assert_eq!(opened.attest_pubs(), keyring.attest_pubs());
        assert_eq!(opened.key(1), keyring.key(1));
        assert_eq!(opened.key(2), keyring.key(2));

        // A viewer of the same link opens it; the old link does not.
        let view = LinkSecret::from_base64url(&newest.view_secret()).unwrap();
        assert!(Keyring::open_verified(&view, &sealed).is_ok());
        assert!(matches!(
            Keyring::open_verified(&link, &sealed),
            Err(CryptoError::BadSignature)
        ));
        // Viewers cannot sign one.
        assert!(matches!(
            keyring.seal_signed(&view),
            Err(CryptoError::ReadOnly)
        ));

        // What a viewer can do: seal a keyring with the keys they hold and
        // sign it with a key of their own.
        let forged = view
            .keyring_key()
            .seal(&keyring.to_plain(), KEYRING_CONTEXT);
        let signature = SigningKey::from_bytes(&[3; 32])
            .sign(&[KEYRING_SIGNATURE_CONTEXT, &forged].concat())
            .to_bytes();
        assert!(matches!(
            Keyring::open_verified(&view, &[&forged[..], &signature].concat()),
            Err(CryptoError::BadSignature)
        ));
        let mut flipped = sealed.clone();
        flipped[20] ^= 1;
        assert!(matches!(
            Keyring::open_verified(&view, &flipped),
            Err(CryptoError::BadSignature)
        ));
        assert!(matches!(
            Keyring::open_verified(&view, &sealed[..40]),
            Err(CryptoError::Truncated)
        ));
    }

    #[test]
    fn a_keyring_must_end_in_the_links_own_key() {
        // Generation 1 under `link`, but signed and sealed by the other
        // link, as a mixed-up server could serve.
        let keyring = Keyring::new_with(&link(), [5; 32]);
        let other = other_link();
        let sealed = other
            .keyring_key()
            .seal(&keyring.to_plain(), KEYRING_CONTEXT);
        let signature = other
            .sign(&[KEYRING_SIGNATURE_CONTEXT, &sealed].concat())
            .unwrap();
        assert!(matches!(
            Keyring::open_verified(&other, &[&sealed[..], &signature].concat()),
            Err(CryptoError::KeyMismatch(_))
        ));
    }

    #[test]
    fn hostile_keyring_counts_are_refused() {
        let mut plain = vec![KEYRING_VERSION];
        plain.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(matches!(
            Keyring::from_plain(&plain),
            Err(CryptoError::MalformedKeyring(_))
        ));
        assert!(matches!(
            Keyring::from_plain(&[KEYRING_VERSION + 1]),
            Err(CryptoError::NewerVersion(_))
        ));
    }

    #[test]
    fn presence_is_per_epoch_and_signed() {
        let editor = editor();
        let me = editor.public_key();
        let key = PresenceKey::new(3, [8; 32]);
        let sealed = key.seal(&editor, 5, b"cursor");
        assert_eq!(
            key.open(&sealed, |leaf| (leaf == 5).then_some(me)).unwrap(),
            (5, b"cursor".to_vec())
        );

        // Another epoch is dropped, whatever the key.
        let next = PresenceKey::new(4, [8; 32]);
        assert!(matches!(
            next.open(&sealed, |_| Some(me)),
            Err(CryptoError::WrongEpoch(3))
        ));
        // Same epoch, different exporter secret.
        let wrong = PresenceKey::new(3, [9; 32]);
        assert!(matches!(
            wrong.open(&sealed, |_| Some(me)),
            Err(CryptoError::Decrypt)
        ));
        // Claiming another member's leaf fails the signature check.
        assert!(matches!(
            key.open(&sealed, |_| Some([1; 32])),
            Err(CryptoError::BadSignature)
        ));
        assert!(matches!(
            key.open(&sealed, |_| None),
            Err(CryptoError::BadSignature)
        ));
        // The leaf is signed, so it cannot be relabelled.
        let mut relabelled = sealed.clone();
        relabelled[12] ^= 1;
        assert!(matches!(
            key.open(&relabelled, |_| Some(me)),
            Err(CryptoError::BadSignature)
        ));
        assert!(matches!(
            key.open(&sealed[..20], |_| Some(me)),
            Err(CryptoError::Truncated)
        ));
        assert!(!format!("{key:?}").contains("8, 8"));
    }
}
