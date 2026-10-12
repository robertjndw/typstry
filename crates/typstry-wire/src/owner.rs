//! The owner key of a project: how the server tells the owner's rotations
//! from anyone else's.
//!
//! A rotation swaps the project's tokens on the server, and the server
//! cannot read the group to see who sent it. Were any edit token enough, an
//! editor could submit a rotation whose envelope reaches nobody and lock
//! everyone else out. So a project has an owner key, an Ed25519 key derived
//! from a random secret that only the owner's devices hold. The server keeps
//! the public half it was given with `Init` and swaps tokens only for a
//! rotation signed with it.
//!
//! Every rotation names the next public key, and the committer hands the new
//! secret to the owner's remaining devices inside the group (see
//! `mls::owner_share`). A device that is removed keeps a secret that signs
//! nothing any more. A group reset never touches the key.
//!
//! Which secret is the current one is the server's to say, not the group's:
//! it hands out the key it holds with every GroupInfo and with each rotation
//! in the log, and a device signs only with a secret that derives that key.
//! Anything in the group can be rewritten by an editor's reset, while the
//! server only ever moves the key on for a rotation signed with it. A server
//! that lies about the key can only make the owner's devices refuse to
//! rotate, which it could do anyway by refusing their rotations. That holds
//! only because a lie costs no secret: a device keeps the ones it holds
//! whatever the server names (see [`OwnerSecrets`]), so the real one is
//! still there once the server says so again.
//!
//! The signature covers all that the server stores or swaps with the
//! rotation, so it cannot be moved to another commit, epoch, group, keyring,
//! envelope or set of tokens.
//!
//! The verifying half is all the server builds (feature `owner-proof`);
//! [`OwnerSecret`] signs and needs `crypto`.

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub use crate::ds::{OWNER_KEY_LEN, OWNER_PROOF_LEN};

/// The public owner key, as the server stores it.
pub type OwnerKey = [u8; OWNER_KEY_LEN];
/// The owner's signature over a [`RotationClaim`].
pub type OwnerProof = [u8; OWNER_PROOF_LEN];

const ROTATION_CONTEXT: &[u8] = b"typstry:v1:owner-rotation";

/// Everything a rotation submits, as the owner signs it and the server
/// checks it. The blobs are the bytes the server stores, sealed as they are.
#[derive(Debug, Clone, Copy)]
pub struct RotationClaim<'a> {
    pub group_id: &'a [u8],
    /// The epoch the commit extends.
    pub epoch: u64,
    pub commit: &'a [u8],
    pub group_info: &'a [u8],
    pub keyring: &'a [u8],
    pub envelope: &'a [u8],
    pub edit_token: &'a str,
    pub view_token: &'a str,
    pub next_owner_key: &'a OwnerKey,
}

fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn push_var(out: &mut Vec<u8>, bytes: &[u8]) {
    let len = u32::try_from(bytes.len()).expect("a submitted field is far below 4 GiB");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
}

impl RotationClaim<'_> {
    /// What is signed. The blobs go in as hashes, so the message stays small
    /// whatever the GroupInfo weighs; the short fields go in whole, with a
    /// length so no two claims can share a transcript.
    pub fn transcript(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(ROTATION_CONTEXT);
        push_var(&mut out, self.group_id);
        out.extend_from_slice(&self.epoch.to_be_bytes());
        for blob in [self.commit, self.group_info, self.keyring, self.envelope] {
            out.extend_from_slice(&hash(blob));
        }
        push_var(&mut out, self.edit_token.as_bytes());
        push_var(&mut out, self.view_token.as_bytes());
        out.extend_from_slice(self.next_owner_key);
        out
    }
}

/// Whether `key` can be an owner key: a point on the curve that is not of
/// small order, so no signature verifies under it for any message.
pub fn is_owner_key(key: &OwnerKey) -> bool {
    VerifyingKey::from_bytes(key).is_ok_and(|key| !key.is_weak())
}

/// Whether `proof` is the signature of `owner_key` over `claim`. Strict, so
/// a proof has one encoding.
pub fn verify_rotation(
    owner_key: &OwnerKey,
    claim: &RotationClaim<'_>,
    proof: &OwnerProof,
) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(owner_key) else {
        return false;
    };
    !key.is_weak()
        && key
            .verify_strict(&claim.transcript(), &Signature::from_bytes(proof))
            .is_ok()
}

#[cfg(feature = "crypto")]
pub use secret::{Origin, OwnerSecret, OwnerSecrets};

#[cfg(feature = "crypto")]
mod secret {
    use ed25519_dalek::{Signer, SigningKey};
    use zeroize::Zeroizing;

    use super::{OwnerKey, OwnerProof, RotationClaim};
    use crate::crypto::{CryptoError, KEY_LEN, hkdf, random};

    const SIGNING_INFO: &[u8] = b"typstry:v1:owner-signing-key";
    const EXPORT_VERSION: u8 = 1;
    const EXPORT_LEN: usize = 1 + KEY_LEN;

    /// The secret half of an owner key. Nothing in it says whether it is
    /// the current one: that is whether [`Self::public`] is the key the
    /// server holds (see the module docs).
    #[derive(Clone)]
    pub struct OwnerSecret {
        secret: Zeroizing<[u8; KEY_LEN]>,
        signing: SigningKey,
    }

    impl std::fmt::Debug for OwnerSecret {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("OwnerSecret")
                .field("public", &self.public())
                .finish_non_exhaustive()
        }
    }

    impl PartialEq for OwnerSecret {
        fn eq(&self, other: &Self) -> bool {
            self.public() == other.public()
        }
    }

    impl Eq for OwnerSecret {}

    impl OwnerSecret {
        pub fn generate() -> Self {
            Self::from_secret(Zeroizing::new(random()))
        }

        /// The key is derived rather than the secret used as a seed, so the
        /// bytes that travel to other devices are never a signing key that
        /// some other code could take for one of its own.
        pub(crate) fn from_secret(secret: Zeroizing<[u8; KEY_LEN]>) -> Self {
            let seed = hkdf(secret.as_ref(), &[], &[SIGNING_INFO]);
            Self {
                signing: SigningKey::from_bytes(&seed),
                secret,
            }
        }

        pub fn public(&self) -> OwnerKey {
            self.signing.verifying_key().to_bytes()
        }

        #[cfg(feature = "mls")]
        pub(crate) fn secret(&self) -> &[u8; KEY_LEN] {
            &self.secret
        }

        pub fn sign(&self, claim: &RotationClaim<'_>) -> OwnerProof {
            self.signing.sign(&claim.transcript()).to_bytes()
        }

        /// The secret as bytes, for a client to keep beside the group state:
        /// it may exist on no other device.
        pub fn export(&self) -> Zeroizing<Vec<u8>> {
            let mut out = Zeroizing::new(Vec::with_capacity(EXPORT_LEN));
            out.push(EXPORT_VERSION);
            out.extend_from_slice(self.secret.as_ref());
            out
        }

        /// Inverse of [`Self::export`].
        pub fn import(bytes: &[u8]) -> Result<Self, CryptoError> {
            if bytes.len() != EXPORT_LEN || bytes[0] != EXPORT_VERSION {
                return Err(CryptoError::MalformedKey);
            }
            let secret = Zeroizing::new(<[u8; KEY_LEN]>::try_from(&bytes[1..]).expect("32 bytes"));
            Ok(Self::from_secret(secret))
        }
    }

    /// How a device came by an owner key secret.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Origin {
        /// This device generated it: it created the project or made the
        /// rotation that moved the server on to it.
        Made,
        /// Opened from a share, or taken along from another copy.
        Received,
    }

    const SET_VERSION: u8 = 1;

    /// The owner key secrets a device holds, newest first, of which the one
    /// whose public key the server holds is used.
    ///
    /// Which key the server holds is only what the server says, so no word
    /// of it ever drops a secret: a server that names a stale or made-up
    /// key would otherwise get a device to throw away the current one, and
    /// once every device has, nobody can rotate again. A secret only ever
    /// leaves the set by being pushed out by newer ones of the same
    /// [`Origin`], at most [`Self::KEEP`] of each.
    ///
    /// That bound holds against a lying server because it cannot add
    /// anything here. Secrets come from this device's own rotations, which
    /// it starts, and from shares that open for this device's leaf in a
    /// leaf the tree shows as an owner device. Those are the owner's own
    /// devices sealing secrets they hold, so all a server can do is have an
    /// older genuine one re-added, and it would take more than `KEEP` of
    /// those this device no longer has to push out a received secret it
    /// learnt since. A secret this device made is never pushed out by
    /// received ones at all.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct OwnerSecrets {
        held: Vec<(OwnerSecret, Origin)>,
    }

    impl OwnerSecrets {
        /// How many of each origin are kept.
        pub const KEEP: usize = 8;

        /// A set of just `secret`, as opened from a share.
        pub fn received(secret: OwnerSecret) -> Self {
            Self {
                held: vec![(secret, Origin::Received)],
            }
        }

        pub fn is_empty(&self) -> bool {
            self.held.is_empty()
        }

        pub fn len(&self) -> usize {
            self.held.len()
        }

        /// Newest first.
        pub fn iter(&self) -> impl Iterator<Item = &OwnerSecret> {
            self.held.iter().map(|(secret, _)| secret)
        }

        /// The secret of `key`, if this set holds it.
        pub fn find(&self, key: &OwnerKey) -> Option<&OwnerSecret> {
            self.entry(key).map(|(secret, _)| secret)
        }

        fn entry(&self, key: &OwnerKey) -> Option<&(OwnerSecret, Origin)> {
            self.held.iter().find(|(secret, _)| secret.public() == *key)
        }

        /// Keeps `secret` as the newest. One held already stays where it is,
        /// so a stale secret coming back cannot push newer ones out; it only
        /// counts as made from then on if it is. False when nothing changed.
        pub fn add(&mut self, secret: OwnerSecret, origin: Origin) -> bool {
            if let Some((_, held)) = self.held.iter_mut().find(|(s, _)| *s == secret) {
                if origin == Origin::Made && *held == Origin::Received {
                    *held = Origin::Made;
                    // The upgrade can put one too many made secrets in the
                    // set, and `decode` refuses a set past both caps.
                    self.evict(Origin::Made);
                    return true;
                }
                return false;
            }
            self.held.insert(0, (secret, origin));
            self.evict(origin);
            true
        }

        /// Adds what `other` holds and this does not, as newer than all of
        /// this, keeping `other`'s order among them: for a store that
        /// gathers what devices hold. False when nothing changed.
        pub fn merge(&mut self, other: &Self) -> bool {
            let mut changed = false;
            for (secret, origin) in other.held.iter().rev() {
                changed |= self.add(secret.clone(), *origin);
            }
            changed
        }

        /// Adds what `other` holds and this does not, as older than all of
        /// this, as far as there is room: for copies kept elsewhere that are
        /// taken along with a state that knows better.
        pub fn extend_older(&mut self, other: &Self) {
            for (secret, origin) in &other.held {
                if self.held.iter().any(|(s, _)| s == secret) {
                    continue;
                }
                if self.held.iter().filter(|(_, o)| o == origin).count() < Self::KEEP {
                    self.held.push((secret.clone(), *origin));
                }
            }
        }

        /// The secret of `key` from `other`, if this set lacks it, as the
        /// newest: the one to use is not left out for want of room.
        pub(crate) fn take_from(&mut self, other: &Self, key: &OwnerKey) {
            if let Some((secret, origin)) = other.entry(key) {
                self.add(secret.clone(), *origin);
            }
        }

        fn evict(&mut self, origin: Origin) {
            let mut seen = 0;
            self.held.retain(|(_, o)| {
                if *o != origin {
                    return true;
                }
                seen += 1;
                seen <= Self::KEEP
            });
        }

        /// The set as bytes, for a client to keep: a version byte, a count,
        /// and per secret, newest first, its origin (1 made, 0 received)
        /// and the 32 secret bytes.
        pub fn encode(&self) -> Zeroizing<Vec<u8>> {
            let mut out = Zeroizing::new(Vec::with_capacity(2 + self.held.len() * EXPORT_LEN));
            out.push(SET_VERSION);
            out.push(u8::try_from(self.held.len()).expect("at most 2 * KEEP"));
            for (secret, origin) in &self.held {
                out.push(u8::from(*origin == Origin::Made));
                out.extend_from_slice(secret.secret.as_ref());
            }
            out
        }

        /// Inverse of [`Self::encode`].
        pub fn decode(bytes: &[u8]) -> Result<Self, CryptoError> {
            let bad = || CryptoError::MalformedKey;
            let [SET_VERSION, count, rest @ ..] = bytes else {
                return Err(bad());
            };
            let count = usize::from(*count);
            if count > 2 * Self::KEEP || rest.len() != count * EXPORT_LEN {
                return Err(bad());
            }
            let mut set = Self::default();
            // Oldest first, so `add` rebuilds the order and the caps hold
            // whatever the bytes say.
            for entry in rest.as_chunks::<EXPORT_LEN>().0.iter().rev() {
                let [origin, secret @ ..] = entry;
                let origin = match origin {
                    0 => Origin::Received,
                    1 => Origin::Made,
                    _ => return Err(bad()),
                };
                let secret: [u8; KEY_LEN] = *secret;
                set.add(OwnerSecret::from_secret(Zeroizing::new(secret)), origin);
            }
            Ok(set)
        }
    }

    impl FromIterator<(OwnerSecret, Origin)> for OwnerSecrets {
        /// Newest first, like [`OwnerSecrets::iter`].
        fn from_iter<I: IntoIterator<Item = (OwnerSecret, Origin)>>(iter: I) -> Self {
            let mut set = Self::default();
            let items: Vec<_> = iter.into_iter().collect();
            for (secret, origin) in items.into_iter().rev() {
                set.add(secret, origin);
            }
            set
        }
    }
}

#[cfg(all(test, feature = "crypto"))]
mod tests {
    use super::*;

    fn claim<'a>(next: &'a OwnerKey) -> RotationClaim<'a> {
        RotationClaim {
            group_id: b"group",
            epoch: 7,
            commit: b"commit",
            group_info: b"group info",
            keyring: b"keyring",
            envelope: b"envelope",
            edit_token: "edit",
            view_token: "view",
            next_owner_key: next,
        }
    }

    #[test]
    fn the_transcript_layout_is_pinned() {
        let next = [9; 32];
        let mut want = b"typstry:v1:owner-rotation".to_vec();
        want.extend([0, 0, 0, 5]);
        want.extend(b"group");
        want.extend(7u64.to_be_bytes());
        for blob in [&b"commit"[..], b"group info", b"keyring", b"envelope"] {
            want.extend(hash(blob));
        }
        want.extend([0, 0, 0, 4]);
        want.extend(b"edit");
        want.extend([0, 0, 0, 4]);
        want.extend(b"view");
        want.extend([9; 32]);
        assert_eq!(claim(&next).transcript(), want);
    }

    #[test]
    fn a_proof_holds_for_exactly_its_claim() {
        let owner = OwnerSecret::generate();
        let next = OwnerSecret::generate().public();
        let proof = owner.sign(&claim(&next));
        assert!(verify_rotation(&owner.public(), &claim(&next), &proof));

        let other_next = [8; 32];
        let changed = [
            RotationClaim {
                group_id: b"other",
                ..claim(&next)
            },
            RotationClaim {
                epoch: 8,
                ..claim(&next)
            },
            RotationClaim {
                commit: b"commit!",
                ..claim(&next)
            },
            RotationClaim {
                group_info: b"group info!",
                ..claim(&next)
            },
            RotationClaim {
                keyring: b"keyring!",
                ..claim(&next)
            },
            RotationClaim {
                envelope: b"envelope!",
                ..claim(&next)
            },
            RotationClaim {
                edit_token: "edit!",
                ..claim(&next)
            },
            RotationClaim {
                view_token: "view!",
                ..claim(&next)
            },
            claim(&other_next),
            // A field boundary moved.
            RotationClaim {
                edit_token: "editv",
                view_token: "iew",
                ..claim(&next)
            },
        ];
        for (i, changed) in changed.iter().enumerate() {
            assert!(!verify_rotation(&owner.public(), changed, &proof), "{i}");
        }

        // Another key, or a mangled proof.
        let stranger = OwnerSecret::generate();
        assert!(!verify_rotation(&stranger.public(), &claim(&next), &proof));
        let mut bad = proof;
        bad[0] ^= 1;
        assert!(!verify_rotation(&owner.public(), &claim(&next), &bad));
        assert!(!verify_rotation(&[0xff; 32], &claim(&next), &proof));
    }

    #[test]
    fn weak_keys_are_no_owner_keys() {
        // The identity point: every signature with R = identity and s = 0
        // verifies under it with the lax check.
        let mut identity = [0; 32];
        identity[0] = 1;
        assert!(!is_owner_key(&identity));
        let mut proof = [0; 64];
        proof[0] = 1;
        assert!(!verify_rotation(&identity, &claim(&[9; 32]), &proof));
        assert!(is_owner_key(&OwnerSecret::generate().public()));
    }

    #[test]
    fn a_secret_survives_export() {
        let owner = OwnerSecret::generate();
        let bytes = owner.export();
        assert_eq!(bytes.len(), 33);
        assert_eq!(bytes[0], 1);
        let again = OwnerSecret::import(&bytes).unwrap();
        assert_eq!(again, owner);
        assert_eq!(again.public(), owner.public());
        let proof = again.sign(&claim(&[9; 32]));
        assert!(verify_rotation(&owner.public(), &claim(&[9; 32]), &proof));

        assert!(OwnerSecret::import(&bytes[..32]).is_err());
        let mut newer = bytes.to_vec();
        newer[0] = 2;
        assert!(OwnerSecret::import(&newer).is_err());
        assert!(!format!("{owner:?}").contains(&format!("{:?}", &bytes[1..])));
    }

    #[test]
    fn a_set_keeps_what_it_made_and_survives_encoding() {
        let made: Vec<_> = (0..3).map(|_| OwnerSecret::generate()).collect();
        let mut set = OwnerSecrets::default();
        for secret in &made {
            assert!(set.add(secret.clone(), Origin::Made));
        }
        // Received secrets, however many, push out received ones only.
        let received: Vec<_> = (0..OwnerSecrets::KEEP + 3)
            .map(|_| OwnerSecret::generate())
            .collect();
        for secret in &received {
            assert!(set.add(secret.clone(), Origin::Received));
        }
        assert_eq!(set.len(), made.len() + OwnerSecrets::KEEP);
        for secret in &made {
            assert_eq!(set.find(&secret.public()), Some(secret));
        }
        assert!(set.find(&received[2].public()).is_none());
        assert!(set.find(&received[3].public()).is_some());
        // One held already stays where it is.
        assert!(!set.add(received[3].clone(), Origin::Received));
        assert_eq!(set.iter().next(), received.last());

        let again = OwnerSecrets::decode(&set.encode()).unwrap();
        assert_eq!(again, set);
        assert_eq!(
            again.iter().collect::<Vec<_>>(),
            set.iter().collect::<Vec<_>>()
        );

        // Made ones push out the oldest made one.
        for _ in 0..OwnerSecrets::KEEP {
            set.add(OwnerSecret::generate(), Origin::Made);
        }
        assert!(set.find(&made[0].public()).is_none());
        assert_eq!(set.len(), 2 * OwnerSecrets::KEEP);

        let bytes = set.encode();
        assert!(OwnerSecrets::decode(&bytes[..bytes.len() - 1]).is_err());
        let mut newer = bytes.to_vec();
        newer[0] = 2;
        assert!(OwnerSecrets::decode(&newer).is_err());
        let mut origin = bytes.to_vec();
        origin[2] = 7;
        assert!(OwnerSecrets::decode(&origin).is_err());
        assert!(OwnerSecrets::decode(&[1, 0]).unwrap().is_empty());
    }

    #[test]
    fn a_received_secret_made_here_keeps_the_set_decodable() {
        let mut set = OwnerSecrets::default();
        for _ in 0..OwnerSecrets::KEEP {
            set.add(OwnerSecret::generate(), Origin::Made);
        }
        let received: Vec<_> = (0..OwnerSecrets::KEEP)
            .map(|_| OwnerSecret::generate())
            .collect();
        for secret in &received {
            set.add(secret.clone(), Origin::Received);
        }
        // Another copy says this device made one it was only sent here.
        assert!(set.add(received[0].clone(), Origin::Made));
        set.add(OwnerSecret::generate(), Origin::Received);
        assert!(set.len() <= 2 * OwnerSecrets::KEEP);
        assert_eq!(OwnerSecrets::decode(&set.encode()).unwrap(), set);
    }

    #[test]
    fn merging_sets_adds_without_reordering() {
        let [a, b, c] = [(); 3].map(|_| OwnerSecret::generate());
        let mut store: OwnerSecrets = [(a.clone(), Origin::Made)].into_iter().collect();
        let held: OwnerSecrets = [
            (c.clone(), Origin::Received),
            (b.clone(), Origin::Made),
            (a.clone(), Origin::Received),
        ]
        .into_iter()
        .collect();
        assert!(store.merge(&held));
        assert_eq!(store.iter().collect::<Vec<_>>(), [&c, &b, &a]);
        assert!(!store.merge(&held));

        let mut state = OwnerSecrets::received(b.clone());
        state.extend_older(&store);
        assert_eq!(state.iter().collect::<Vec<_>>(), [&b, &c, &a]);
    }
}
