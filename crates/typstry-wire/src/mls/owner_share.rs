//! The owner key shares a leaf carries in extension `0xff03`.
//!
//! The secret of the space's owner key (see [`crate::owner`]) lives only on
//! the owner's devices. When one of them holds the current secret and sees
//! another owner device in the tree without it, it puts an entry for that
//! device into its own leaf: the secret, HPKE-sealed to the other leaf's
//! key. The entries ride in the tree rather than in the commit log, so they
//! outlive log pruning, and a device that was away, rejoins or resyncs with
//! the same leaf key finds its entry whenever it comes back. A rotation
//! hands on the next secret the same way, in the committer's new leaf.
//!
//! A recovery key is never a leaf, yet it is the person's way back when
//! every device is lost or in the wrong hands. So the secret is also sealed
//! to each of the owner's valid recovery keys, to the X25519 key the
//! recovery key converts to, and the device that recovers with it can sign
//! the rotation that throws the lost devices out.
//!
//! Members take a secret only from a leaf the tree shows as an owner, only
//! for the owner key the server holds, and only if it derives that key. The
//! tree alone cannot say which key is current, as an editor's reset can
//! rebuild it; the server can, as it moves the key on only for a rotation
//! signed with it. The policy never reads this extension, as it does not
//! read the profile: nothing in it changes who may commit.
//!
//! Layout: version 1, the public owner key, then the leaf entries and the
//! recovery entries. Each list is a uleb128 count and per entry the
//! recipient (a leaf's signature key, or a recovery device key), the HPKE KEM
//! output and the ciphertext, the last two length-prefixed.

use loro_protocol::{BytesReader, BytesWriter};
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::HpkeCiphertext;
use zeroize::Zeroizing;

use super::rotation::Recipient;
use super::storage::hpke_config;
use crate::codec::{plausible_count, read_array};
use crate::crypto::{KEY_LEN, PublicKey};
use crate::identity::{DeviceKey, x25519_public};
use crate::owner::{OwnerKey, OwnerSecret};

const SHARES_VERSION: u8 = 1;
const LEAF_CONTEXT: &[u8] = b"typstry:v1:owner-share";
const RECOVERY_CONTEXT: &[u8] = b"typstry:v1:owner-share-recovery";

/// Entries per list. A person has a handful of devices, so this only keeps
/// junk out.
pub const MAX_SHARES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareEntry {
    pub recipient: PublicKey,
    pub kem_output: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerShares {
    /// The public key of the shared secret.
    pub owner_key: OwnerKey,
    pub leaves: Vec<ShareEntry>,
    pub recovery: Vec<ShareEntry>,
}

/// What a share is bound to besides its recipient: the group, and the leaf
/// that carries it, so an entry copied into another leaf or space does
/// not open.
#[derive(Debug, Clone, Copy)]
pub struct ShareScope<'a> {
    pub group_id: &'a [u8],
    pub sender: &'a PublicKey,
}

/// `bound` is what the sealed value is pinned to: the owner key here, the
/// binding tag for [`super::person_share`].
pub(super) fn info(
    context: &[u8],
    scope: &ShareScope<'_>,
    bound: &[u8],
    recipient: &PublicKey,
) -> Vec<u8> {
    [
        context,
        &(scope.group_id.len() as u32).to_be_bytes(),
        scope.group_id,
        bound,
        scope.sender,
        recipient,
    ]
    .concat()
}

impl OwnerShares {
    /// Seals `secret` to each leaf and each recovery key. One whose key
    /// cannot be sealed to is left out, as it can only ever be that
    /// recipient's loss.
    pub fn seal(
        crypto: &impl OpenMlsCrypto,
        scope: &ShareScope<'_>,
        secret: &OwnerSecret,
        leaves: &[Recipient],
        recovery: &[PublicKey],
    ) -> Self {
        let owner_key = secret.public();
        let seal = |context: &[u8], recipient: &PublicKey, hpke_pub: &[u8]| {
            let info = info(context, scope, &owner_key, recipient);
            let sealed = crypto
                .hpke_seal(hpke_config(), hpke_pub, &info, recipient, secret.secret())
                .ok()?;
            Some(ShareEntry {
                recipient: *recipient,
                kem_output: sealed.kem_output.as_slice().to_vec(),
                ciphertext: sealed.ciphertext.as_slice().to_vec(),
            })
        };
        let leaves = leaves
            .iter()
            .filter_map(|r| seal(LEAF_CONTEXT, &r.signer, &r.hpke_pub))
            .take(MAX_SHARES)
            .collect();
        let recovery = recovery
            .iter()
            .filter_map(|key| seal(RECOVERY_CONTEXT, key, &x25519_public(key)?))
            .take(MAX_SHARES)
            .collect();
        Self {
            owner_key,
            leaves,
            recovery,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(SHARES_VERSION);
        w.push_bytes(&self.owner_key);
        for list in [&self.leaves, &self.recovery] {
            w.push_uleb128(list.len() as u64);
            for entry in list {
                w.push_bytes(&entry.recipient);
                w.push_var_bytes(&entry.kem_output);
                w.push_var_bytes(&entry.ciphertext);
            }
        }
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = BytesReader::new(bytes);
        match r.read_byte()? {
            SHARES_VERSION => {}
            v => return Err(format!("owner shares version {v} is not supported")),
        }
        let owner_key = read_array(&mut r)?;
        let leaves = read_list(&mut r)?;
        let recovery = read_list(&mut r)?;
        if r.remaining() != 0 {
            return Err(format!("{} trailing bytes", r.remaining()));
        }
        Ok(Self {
            owner_key,
            leaves,
            recovery,
        })
    }

    /// Whether a leaf with signature key `signer` has an entry.
    pub fn covers_leaf(&self, signer: &PublicKey) -> bool {
        self.leaves.iter().any(|e| e.recipient == *signer)
    }

    pub fn covers_recovery(&self, key: &PublicKey) -> bool {
        self.recovery.iter().any(|e| e.recipient == *key)
    }

    /// The secret in the entry for the leaf holding `signer` and
    /// `hpke_private`, if there is one that opens to the named key.
    pub fn open_leaf(
        &self,
        crypto: &impl OpenMlsCrypto,
        scope: &ShareScope<'_>,
        signer: &PublicKey,
        hpke_private: &[u8],
    ) -> Option<OwnerSecret> {
        self.open(
            crypto,
            LEAF_CONTEXT,
            &self.leaves,
            scope,
            signer,
            hpke_private,
        )
    }

    /// The secret in the entry for `recovery`.
    pub fn open_recovery(
        &self,
        crypto: &impl OpenMlsCrypto,
        scope: &ShareScope<'_>,
        recovery: &DeviceKey,
    ) -> Option<OwnerSecret> {
        let private = recovery.x25519_secret();
        self.open(
            crypto,
            RECOVERY_CONTEXT,
            &self.recovery,
            scope,
            &recovery.public(),
            private.as_ref(),
        )
    }

    fn open(
        &self,
        crypto: &impl OpenMlsCrypto,
        context: &[u8],
        list: &[ShareEntry],
        scope: &ShareScope<'_>,
        recipient: &PublicKey,
        private: &[u8],
    ) -> Option<OwnerSecret> {
        let entry = list.iter().find(|e| e.recipient == *recipient)?;
        let sealed = HpkeCiphertext {
            kem_output: entry.kem_output.clone().into(),
            ciphertext: entry.ciphertext.clone().into(),
        };
        let info = info(context, scope, &self.owner_key, recipient);
        let plain = Zeroizing::new(
            crypto
                .hpke_open(hpke_config(), &sealed, private, &info, recipient)
                .ok()?,
        );
        let secret = Zeroizing::new(<[u8; KEY_LEN]>::try_from(plain.as_slice()).ok()?);
        let owner = OwnerSecret::from_secret(secret);
        (owner.public() == self.owner_key).then_some(owner)
    }
}

pub(super) fn read_list(r: &mut BytesReader<'_>) -> Result<Vec<ShareEntry>, String> {
    // A recipient key and two length bytes at the least.
    let count = plausible_count(r, KEY_LEN + 2)?;
    if count > MAX_SHARES as u64 {
        return Err(format!("{count} owner shares are too many"));
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(ShareEntry {
            recipient: read_array(r)?,
            kem_output: r.read_var_bytes()?.to_vec(),
            ciphertext: r.read_var_bytes()?.to_vec(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use openmls_rust_crypto::RustCrypto;

    use super::*;
    use crate::mls::LeafKeys;

    fn recipient(leaf: &LeafKeys) -> Recipient {
        Recipient {
            signer: leaf.signer_pub(),
            hpke_pub: leaf.hpke_pub().to_vec(),
        }
    }

    #[test]
    fn shares_open_for_their_recipient_only() {
        let crypto = RustCrypto::default();
        let (a, b, outsider) = (
            LeafKeys::generate(),
            LeafKeys::generate(),
            LeafKeys::generate(),
        );
        let recovery = DeviceKey::generate();
        let sender = [7; 32];
        let scope = ShareScope {
            group_id: b"group",
            sender: &sender,
        };
        let secret = OwnerSecret::generate();
        let shares = OwnerShares::seal(
            &crypto,
            &scope,
            &secret,
            &[recipient(&a), recipient(&b)],
            &[recovery.public()],
        );
        let shares = OwnerShares::decode(&shares.encode()).unwrap();
        assert_eq!(shares.owner_key, secret.public());
        for leaf in [&a, &b] {
            assert!(shares.covers_leaf(&leaf.signer_pub()));
            let opened = shares
                .open_leaf(&crypto, &scope, &leaf.signer_pub(), leaf.hpke_private())
                .unwrap();
            assert_eq!(opened, secret);
        }
        assert!(shares.covers_recovery(&recovery.public()));
        assert_eq!(
            shares.open_recovery(&crypto, &scope, &recovery),
            Some(secret.clone())
        );

        // Nobody else, and not under another group or sender.
        assert!(
            shares
                .open_leaf(
                    &crypto,
                    &scope,
                    &outsider.signer_pub(),
                    outsider.hpke_private()
                )
                .is_none()
        );
        assert!(
            shares
                .open_recovery(&crypto, &scope, &DeviceKey::generate())
                .is_none()
        );
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
            assert!(
                shares
                    .open_leaf(&crypto, &wrong, &a.signer_pub(), a.hpke_private())
                    .is_none()
            );
            assert!(shares.open_recovery(&crypto, &wrong, &recovery).is_none());
        }
        // A leaf entry is no recovery entry, even for the same key bytes.
        let mut swapped = shares.clone();
        swapped.recovery = vec![ShareEntry {
            recipient: recovery.public(),
            ..shares.leaves[0].clone()
        }];
        assert!(swapped.open_recovery(&crypto, &scope, &recovery).is_none());
    }

    #[test]
    fn a_share_must_derive_the_named_key() {
        let crypto = RustCrypto::default();
        let leaf = LeafKeys::generate();
        let sender = [7; 32];
        let scope = ShareScope {
            group_id: b"group",
            sender: &sender,
        };
        let shares = OwnerShares::seal(
            &crypto,
            &scope,
            &OwnerSecret::generate(),
            &[recipient(&leaf)],
            &[],
        );
        let open = |shares: &OwnerShares| {
            shares.open_leaf(&crypto, &scope, &leaf.signer_pub(), leaf.hpke_private())
        };
        assert!(open(&shares).is_some());
        // Claiming another key breaks the HPKE context.
        let mut renamed = shares.clone();
        renamed.owner_key = OwnerSecret::generate().public();
        assert!(open(&renamed).is_none());

        // A sender that seals a secret under someone else's public key.
        let real = OwnerSecret::generate();
        let fake = OwnerSecret::generate();
        let info = info(LEAF_CONTEXT, &scope, &real.public(), &leaf.signer_pub());
        let sealed = crypto
            .hpke_seal(
                hpke_config(),
                leaf.hpke_pub(),
                &info,
                &leaf.signer_pub(),
                fake.secret(),
            )
            .unwrap();
        let forged = OwnerShares {
            owner_key: real.public(),
            leaves: vec![ShareEntry {
                recipient: leaf.signer_pub(),
                kem_output: sealed.kem_output.as_slice().to_vec(),
                ciphertext: sealed.ciphertext.as_slice().to_vec(),
            }],
            recovery: Vec::new(),
        };
        assert!(open(&forged).is_none());
    }

    #[test]
    fn the_codec_refuses_junk() {
        let shares = OwnerShares {
            owner_key: [1; 32],
            leaves: vec![ShareEntry {
                recipient: [2; 32],
                kem_output: vec![3; 32],
                ciphertext: vec![4; 48],
            }],
            recovery: vec![ShareEntry {
                recipient: [5; 32],
                kem_output: vec![6],
                ciphertext: vec![],
            }],
        };
        let bytes = shares.encode();
        assert_eq!(OwnerShares::decode(&bytes).unwrap(), shares);
        for len in 0..bytes.len() {
            assert!(OwnerShares::decode(&bytes[..len]).is_err(), "{len}");
        }
        assert!(OwnerShares::decode(&[bytes.clone(), vec![0]].concat()).is_err());
        let mut newer = bytes;
        newer[0] = SHARES_VERSION + 1;
        assert!(OwnerShares::decode(&newer).is_err());

        // A count far beyond the data, and one past the cap that would fit.
        let mut huge = vec![SHARES_VERSION];
        huge.extend([1; 32]);
        huge.extend([0xff, 0xff, 0xff, 0x7f]);
        assert!(OwnerShares::decode(&huge).is_err());
        let many = OwnerShares {
            leaves: vec![shares.recovery[0].clone(); MAX_SHARES + 1],
            recovery: Vec::new(),
            ..shares
        };
        assert!(OwnerShares::decode(&many.encode()).is_err());
        let most = OwnerShares {
            leaves: vec![many.leaves[0].clone(); MAX_SHARES],
            ..many
        };
        assert!(OwnerShares::decode(&most.encode()).is_ok());
    }
}
