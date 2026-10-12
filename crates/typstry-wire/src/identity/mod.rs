//! Who a person is, without a key that is shared between their devices.
//!
//! Every device holds its own [`DeviceKey`]. Which device keys make up one
//! person is a [`PersonGraph`]: a hash-linked DAG of device keys that
//! introduce and revoke each other, signed entry by entry. The person id is
//! the hash of the first entry, so there is no person key to steal, and
//! merging two copies of a graph is a set union that needs no ordering
//! authority.
//!
//! A device key never signs MLS or records directly. Leaf keys stay per
//! project, so the device key only signs a [`LeafBinding`] for each of them
//! and nothing public links a person across projects.
//!
//! Every format starts with a version byte. One this build does not know
//! means a newer typstry wrote the data, which [`GraphError::NewerVersion`]
//! reports.

mod adopt;
#[cfg(test)]
mod adversary;
mod binding;
mod entry;
mod graph;
mod recovery;
mod validity;

use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use zeroize::Zeroizing;

use crate::crypto::{CryptoError, KEY_LEN, PublicKey, SIGNATURE_LEN, hkdf, random};

pub use adopt::{AdoptError, adopt};
pub use binding::{LeafBinding, LeafIdentity};
pub use entry::{Entry, EntryKind, FLAG_RECOVERY, MAX_PROFILE_LEN};
pub use graph::{DeviceInfo, DeviceState, PersonGraph};
pub use recovery::{RecoverError, RecoverOptions, Recovered, RecoveryError, RecoveryKey, recover};

/// The hash of a person's genesis entry.
pub type PersonId = [u8; 32];
/// The SHA-256 of a signed entry.
pub type Hash = [u8; 32];

/// More entries than this and a graph is refused. Devices come and go
/// rarely, and the graph rides in every leaf of every project, so it has to
/// stay small.
pub const MAX_GRAPH_ENTRIES: usize = 48;
/// Upper bound on an encoded graph, for the same reason. Entries with many
/// parents are bigger than the usual 164 bytes, so this binds before the
/// count does only for unusually forked graphs.
pub const MAX_GRAPH_BYTES: usize = 8192;

const PERSON_ID_INFO: &[u8] = b"typstry:v1:person-id";
const DEVICE_ID_INFO: &[u8] = b"typstry:v1:device-id";
/// Bytes of the id hash a fingerprint shows.
const FINGERPRINT_BYTES: usize = 9;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum GraphError {
    #[error("malformed person graph: {0}")]
    Malformed(String),
    /// The version or kind byte is one this build does not know.
    #[error("made by a newer version of typstry (format {0}); update typstry to read it")]
    NewerVersion(u8),
    #[error("a person graph entry's signature does not verify")]
    BadSignature,
    #[error("a person graph entry refers to a parent that is not there")]
    MissingParent,
    #[error("a person graph needs exactly one genesis entry")]
    Genesis,
    #[error("the person graph is too large")]
    TooLarge,
    /// Graphs of different people never merge, or one could graft its
    /// devices onto another person.
    #[error("the graphs belong to different people")]
    ForeignGraph,
    /// Only a device that is valid in the graph can extend it.
    #[error("this device is not a valid device of the person")]
    NotValid,
    #[error("that device was revoked for good and cannot be added again")]
    DeviceRevoked,
    /// An entry whose author was not a valid device in the entry's own past.
    /// Only a misbehaving or foreign signer writes one, so a graph that holds
    /// it is refused as a whole rather than carried along.
    #[error("a person graph entry is signed by a device that could not sign it")]
    Unauthorized,
}

/// The key one device signs for a person with. Unlike the project keys it is
/// meant to live as long as the device does.
pub struct DeviceKey {
    key: SigningKey,
}

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKey")
            .field("public", &self.public())
            .finish_non_exhaustive()
    }
}

impl DeviceKey {
    pub fn generate() -> Self {
        Self {
            key: SigningKey::from_bytes(&random()),
        }
    }

    /// The 32-byte seed.
    pub fn export(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.key.to_bytes().to_vec())
    }

    /// Inverse of [`Self::export`].
    pub fn import(bytes: &[u8]) -> Result<Self, CryptoError> {
        let seed = Zeroizing::new(
            <[u8; KEY_LEN]>::try_from(bytes).map_err(|_| CryptoError::MalformedKey)?,
        );
        Ok(Self {
            key: SigningKey::from_bytes(&seed),
        })
    }

    pub fn public(&self) -> PublicKey {
        self.key.verifying_key().to_bytes()
    }

    pub(crate) fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_LEN] {
        self.key.sign(message).to_bytes()
    }

    /// The X25519 secret that goes with [`x25519_public`] of this key, by the
    /// conversion libsodium uses. A recovery key is never a leaf, so it has no
    /// HPKE key of its own to be sent anything to; this is how an owner key
    /// share reaches it without the graph carrying a second key.
    #[cfg(feature = "mls")]
    pub(crate) fn x25519_secret(&self) -> Zeroizing<[u8; KEY_LEN]> {
        Zeroizing::new(self.key.to_scalar_bytes())
    }
}

/// The X25519 public key of a device key, the birational map from Edwards to
/// Montgomery form. `None` for bytes that are no curve point.
#[cfg(feature = "mls")]
pub(crate) fn x25519_public(device: &PublicKey) -> Option<[u8; KEY_LEN]> {
    let key = VerifyingKey::from_bytes(device).ok()?;
    (!key.is_weak()).then(|| key.to_montgomery().to_bytes())
}

/// A short public tag of a person, for people to compare out of band. It is
/// derived from the id rather than shown raw so it cannot be mistaken for a
/// key.
pub fn person_fingerprint(person: &PersonId) -> String {
    let id = hkdf(person, &[], &[PERSON_ID_INFO]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&id[..FINGERPRINT_BYTES])
}

/// The same kind of tag for one device key. Every client shows this one, so
/// a device can be named by it on the command line and found in the browser.
/// Its own derivation label keeps it from ever equalling a person's tag.
pub fn device_fingerprint(device: &PublicKey) -> String {
    let id = hkdf(device, &[], &[DEVICE_ID_INFO]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&id[..FINGERPRINT_BYTES])
}

/// Strict verification, so a signature has one valid encoding and cannot be
/// malleated into a second hash for the same entry.
pub(crate) fn verify(
    public: &PublicKey,
    message: &[u8],
    signature: &[u8; SIGNATURE_LEN],
) -> Result<(), GraphError> {
    let public = VerifyingKey::from_bytes(public).map_err(|_| GraphError::BadSignature)?;
    public
        .verify_strict(message, &Signature::from_bytes(signature))
        .map_err(|_| GraphError::BadSignature)
}

pub(crate) fn malformed(what: &str, why: String) -> GraphError {
    GraphError::Malformed(format!("{what}: {why}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_key_roundtrips_and_hides_its_secret() {
        let key = DeviceKey::generate();
        let again = DeviceKey::import(&key.export()).unwrap();
        assert_eq!(key.public(), again.public());
        assert!(DeviceKey::import(&[0; 31]).is_err());
        let shown = format!("{key:?}");
        let seed = key.export();
        assert!(!shown.contains(&format!("{:?}", &seed[..4])));
        assert!(shown.contains("public"));
    }

    #[test]
    fn fingerprint_is_stable() {
        let a = person_fingerprint(&[7; 32]);
        assert_eq!(a, person_fingerprint(&[7; 32]));
        assert_ne!(a, person_fingerprint(&[8; 32]));
        assert_eq!(a.len(), 12);
        assert_eq!(a, "n7FP9vSfJXwE");
    }

    #[test]
    fn device_and_person_tags_differ_for_the_same_bytes() {
        let device = device_fingerprint(&[7; 32]);
        assert_eq!(device.len(), 12);
        assert_ne!(device, person_fingerprint(&[7; 32]));
    }
}
