//! The pointer to a person's personal space a leaf carries in extension
//! `0xff04`.
//!
//! A person's project directory lives in a space of their own (see the web
//! client's `directory` module), found by a token and an edit secret that
//! only their devices hold. A recovery key is a way back with nothing but a
//! link to one project, so that link has to lead to the rest: each device
//! puts the personal space's token and secret into its leaf, HPKE-sealed to
//! each of the person's valid recovery keys, the way [`super::owner_share`]
//! seals the owner key. The recovery key opens it, joins the personal space
//! and from the directory there reaches every other project.
//!
//! Sealed the same way as owner shares, to the X25519 key a recovery key
//! converts to and bound to the group and the leaf that carries it, so an
//! entry copied into another leaf or group does not open. Nothing here is
//! signed beyond the leaf itself: what a share opens to is only ever a
//! pointer the recovering device then checks against the server, and the
//! readers only take it from leaves of the recovery key's own person.
//!
//! Only recovery keys can open it. The leaf cannot say which binding it
//! holds without that, so it carries a short tag of the token in the clear;
//! a device compares it with its own binding to see whether the entries
//! are stale. The tag is a hash of a 128-bit random token, so it reveals
//! nothing the server does not already see of the space.
//!
//! Layout: version 1, the 16 byte binding tag, then the recovery entries as
//! a uleb128 count and per entry the recipient, the HPKE KEM output and the
//! ciphertext, the last two length-prefixed. The sealed plaintext is
//! version 1, the token and the secret, both length-prefixed.

use std::fmt;

use loro_protocol::{BytesReader, BytesWriter};
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::HpkeCiphertext;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::owner_share::{MAX_SHARES, ShareEntry, ShareScope, info, read_list};
use super::storage::hpke_config;
use crate::codec::read_array;
use crate::crypto::PublicKey;
use crate::identity::{DeviceKey, x25519_public};
use crate::token;

const SHARES_VERSION: u8 = 1;
const SPACE_VERSION: u8 = 1;
const RECOVERY_CONTEXT: &[u8] = b"typstry:v1:person-space-recovery";
const TAG_CONTEXT: &[u8] = b"typstry:v1:person-space-tag";

pub const TAG_LEN: usize = 16;

/// An edit secret is 33 bytes, 44 characters of base64url. The room is for
/// a longer one a later version may use, and only keeps junk out.
const MAX_SECRET_LEN: usize = 128;

pub type BindingTag = [u8; TAG_LEN];

/// Where a person's personal space is and what opens it.
#[derive(Clone, PartialEq, Eq)]
pub struct PersonSpace {
    token: String,
    secret: Zeroizing<String>,
}

// Not derived: the secret must not reach a log.
impl fmt::Debug for PersonSpace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PersonSpace")
            .field("token", &self.token)
            .finish_non_exhaustive()
    }
}

impl PersonSpace {
    /// `token` is the space's edit token and `secret` its edit secret as
    /// base64url, the shapes a link has.
    pub fn new(token: &str, secret: &str) -> Result<Self, String> {
        if !token::looks_valid(token) {
            return Err("the space token is malformed".into());
        }
        let url_safe = |b: u8| b.is_ascii_alphanumeric() || b == b'-' || b == b'_';
        if secret.is_empty() || secret.len() > MAX_SECRET_LEN || !secret.bytes().all(url_safe) {
            return Err("the space secret is malformed".into());
        }
        Ok(Self {
            token: token.to_owned(),
            secret: Zeroizing::new(secret.to_owned()),
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }

    /// What a leaf shows of the binding without revealing it.
    pub fn tag(&self) -> BindingTag {
        let digest = Sha256::digest([TAG_CONTEXT, self.token.as_bytes()].concat());
        digest[..TAG_LEN].try_into().expect("a digest is longer")
    }

    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let mut w = BytesWriter::new();
        w.push_byte(SPACE_VERSION);
        w.push_var_bytes(self.token.as_bytes());
        w.push_var_bytes(self.secret.as_bytes());
        Zeroizing::new(w.finalize())
    }

    fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = BytesReader::new(bytes);
        match r.read_byte()? {
            SPACE_VERSION => {}
            v => return Err(format!("personal space version {v} is not supported")),
        }
        let token = std::str::from_utf8(r.read_var_bytes()?).map_err(|e| e.to_string())?;
        let secret = std::str::from_utf8(r.read_var_bytes()?).map_err(|e| e.to_string())?;
        if r.remaining() != 0 {
            return Err(format!("{} trailing bytes", r.remaining()));
        }
        Self::new(token, secret)
    }
}

/// The recovery keys a leaf seals the binding to: the ones that convert to
/// an X25519 key, capped like the list on the wire. Callers compare against
/// this rather than the raw set, or a key that cannot be sealed to would
/// make the leaf look stale forever.
pub(super) fn sealable(recovery: &[PublicKey]) -> Vec<PublicKey> {
    recovery
        .iter()
        .filter(|key| x25519_public(key).is_some())
        .take(MAX_SHARES)
        .copied()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonShares {
    /// [`PersonSpace::tag`] of the binding the entries open to.
    pub binding_tag: BindingTag,
    pub recovery: Vec<ShareEntry>,
}

impl PersonShares {
    /// Seals `space` to each recovery key. One whose key cannot be sealed to
    /// is left out, as it can only ever be that key's loss.
    pub fn seal(
        crypto: &impl OpenMlsCrypto,
        scope: &ShareScope<'_>,
        space: &PersonSpace,
        recovery: &[PublicKey],
    ) -> Self {
        let binding_tag = space.tag();
        let plain = space.encode();
        let recovery = sealable(recovery)
            .iter()
            .filter_map(|key| {
                let info = info(RECOVERY_CONTEXT, scope, &binding_tag, key);
                let sealed = crypto
                    .hpke_seal(hpke_config(), &x25519_public(key)?, &info, key, &plain)
                    .ok()?;
                Some(ShareEntry {
                    recipient: *key,
                    kem_output: sealed.kem_output.as_slice().to_vec(),
                    ciphertext: sealed.ciphertext.as_slice().to_vec(),
                })
            })
            .collect();
        Self {
            binding_tag,
            recovery,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(SHARES_VERSION);
        w.push_bytes(&self.binding_tag);
        w.push_uleb128(self.recovery.len() as u64);
        for entry in &self.recovery {
            w.push_bytes(&entry.recipient);
            w.push_var_bytes(&entry.kem_output);
            w.push_var_bytes(&entry.ciphertext);
        }
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = BytesReader::new(bytes);
        match r.read_byte()? {
            SHARES_VERSION => {}
            v => return Err(format!("person shares version {v} is not supported")),
        }
        let binding_tag = read_array(&mut r)?;
        let recovery = read_list(&mut r)?;
        if r.remaining() != 0 {
            return Err(format!("{} trailing bytes", r.remaining()));
        }
        Ok(Self {
            binding_tag,
            recovery,
        })
    }

    /// Whether these entries are what a leaf of a device with `space` should
    /// carry given the person's valid `recovery` keys: for this binding and
    /// for exactly those keys.
    pub fn is_current(&self, space: &PersonSpace, recovery: &[PublicKey]) -> bool {
        let wanted = sealable(recovery);
        self.binding_tag == space.tag()
            && self.recovery.len() == wanted.len()
            && wanted.iter().all(|key| self.covers_recovery(key))
    }

    pub fn covers_recovery(&self, key: &PublicKey) -> bool {
        self.recovery.iter().any(|e| e.recipient == *key)
    }

    /// The binding in the entry for `recovery`, if there is one that opens
    /// to the space its tag names.
    pub fn open_recovery(
        &self,
        crypto: &impl OpenMlsCrypto,
        scope: &ShareScope<'_>,
        recovery: &DeviceKey,
    ) -> Option<PersonSpace> {
        let public = recovery.public();
        let entry = self.recovery.iter().find(|e| e.recipient == public)?;
        let sealed = HpkeCiphertext {
            kem_output: entry.kem_output.clone().into(),
            ciphertext: entry.ciphertext.clone().into(),
        };
        let info = info(RECOVERY_CONTEXT, scope, &self.binding_tag, &public);
        let private = recovery.x25519_secret();
        let plain = Zeroizing::new(
            crypto
                .hpke_open(hpke_config(), &sealed, private.as_ref(), &info, &public)
                .ok()?,
        );
        let space = PersonSpace::decode(&plain).ok()?;
        (space.tag() == self.binding_tag).then_some(space)
    }
}

#[cfg(test)]
mod tests {
    use openmls_rust_crypto::RustCrypto;

    use super::*;

    fn space() -> PersonSpace {
        PersonSpace::new(
            &token::generate(),
            "AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g",
        )
        .unwrap()
    }

    #[test]
    fn shares_open_for_their_recovery_key_only() {
        let crypto = RustCrypto::default();
        let (recovery, other) = (DeviceKey::generate(), DeviceKey::generate());
        let sender = [7; 32];
        let scope = ShareScope {
            group_id: b"group",
            sender: &sender,
        };
        let space = space();
        let shares = PersonShares::seal(&crypto, &scope, &space, &[recovery.public()]);
        let shares = PersonShares::decode(&shares.encode()).unwrap();
        assert!(shares.covers_recovery(&recovery.public()));
        assert!(shares.is_current(&space, &[recovery.public()]));
        assert_eq!(
            shares.open_recovery(&crypto, &scope, &recovery),
            Some(space.clone())
        );

        assert!(shares.open_recovery(&crypto, &scope, &other).is_none());
        let other_sender = [8; 32];
        for wrong in [
            ShareScope {
                group_id: b"other",
                sender: &sender,
            },
            ShareScope {
                group_id: b"group",
                sender: &other_sender,
            },
        ] {
            assert!(shares.open_recovery(&crypto, &wrong, &recovery).is_none());
        }
        // The entry moved under another recipient does not open for it.
        let mut moved = shares.clone();
        moved.recovery[0].recipient = other.public();
        assert!(moved.open_recovery(&crypto, &scope, &other).is_none());
        // A tag that does not name the sealed space breaks the context.
        let mut retagged = shares;
        retagged.binding_tag = self::space().tag();
        assert!(retagged.open_recovery(&crypto, &scope, &recovery).is_none());
    }

    #[test]
    fn staleness_follows_the_binding_and_the_recovery_keys() {
        let crypto = RustCrypto::default();
        let (a, b) = (DeviceKey::generate(), DeviceKey::generate());
        let sender = [7; 32];
        let scope = ShareScope {
            group_id: b"group",
            sender: &sender,
        };
        let space = space();
        let shares = PersonShares::seal(&crypto, &scope, &space, &[a.public()]);
        assert!(shares.is_current(&space, &[a.public()]));
        assert!(!shares.is_current(&self::space(), &[a.public()]));
        assert!(!shares.is_current(&space, &[a.public(), b.public()]));
        assert!(!shares.is_current(&space, &[]));
        // A key that is no curve point cannot be sealed to and must not
        // count as missing.
        let junk = [0; 32];
        assert!(shares.is_current(&space, &[a.public(), junk]));
    }

    #[test]
    fn the_secret_stays_out_of_debug() {
        let space = space();
        assert!(!format!("{space:?}").contains(space.secret()));
    }

    #[test]
    fn the_codec_refuses_junk() {
        let shares = PersonShares {
            binding_tag: [1; TAG_LEN],
            recovery: vec![ShareEntry {
                recipient: [2; 32],
                kem_output: vec![3; 32],
                ciphertext: vec![4; 48],
            }],
        };
        let bytes = shares.encode();
        assert_eq!(PersonShares::decode(&bytes).unwrap(), shares);
        for len in 0..bytes.len() {
            assert!(PersonShares::decode(&bytes[..len]).is_err(), "{len}");
        }
        assert!(PersonShares::decode(&[bytes.clone(), vec![0]].concat()).is_err());
        let mut newer = bytes;
        newer[0] = SHARES_VERSION + 1;
        assert!(PersonShares::decode(&newer).is_err());

        // A count far beyond the data, and one past the cap that would fit.
        let mut huge = vec![SHARES_VERSION];
        huge.extend([1; TAG_LEN]);
        huge.extend([0xff, 0xff, 0xff, 0x7f]);
        assert!(PersonShares::decode(&huge).is_err());
        let many = PersonShares {
            recovery: vec![shares.recovery[0].clone(); MAX_SHARES + 1],
            ..shares
        };
        assert!(PersonShares::decode(&many.encode()).is_err());
        let most = PersonShares {
            recovery: vec![many.recovery[0].clone(); MAX_SHARES],
            ..many
        };
        assert!(PersonShares::decode(&most.encode()).is_ok());
    }

    #[test]
    fn a_space_refuses_junk() {
        let good = space();
        let bytes = good.encode();
        assert_eq!(PersonSpace::decode(&bytes).unwrap(), good);
        for len in 0..bytes.len() {
            assert!(PersonSpace::decode(&bytes[..len]).is_err(), "{len}");
        }
        assert!(PersonSpace::decode(&[bytes.to_vec(), vec![0]].concat()).is_err());
        assert!(PersonSpace::new("short", "AAAA").is_err());
        assert!(PersonSpace::new(good.token(), "").is_err());
        assert!(PersonSpace::new(good.token(), "not base64!").is_err());
        assert!(PersonSpace::new(good.token(), &"A".repeat(MAX_SECRET_LEN + 1)).is_err());
    }
}
