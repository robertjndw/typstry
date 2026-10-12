//! The MLS extensions typstry puts on leaves and on the group, and the
//! capabilities that let them be used.
//!
//! - `0xff00` on a leaf: who may write. The editor attestation for one
//!   generation and the HPKE key the edit link is sent to on rotation.
//!   Viewers have none.
//! - `0xff01` on a leaf: the member's profile (name, color) sealed under
//!   the doc key of a generation, so the server and removed members cannot
//!   read it.
//! - `0xff02` on a leaf: the identity, i.e. a device key's binding of the
//!   leaf key and the person graph that says whether that device counts,
//!   sealed under the identity key. A leaf keeps its device for its whole
//!   life; a commit copies the identity unchanged or extends the graph.
//! - `0xff03` on a leaf: shares of the project's owner key for the owner's
//!   other devices and recovery keys, see [`super::owner_share`]. Only an
//!   owner's leaf counts, and no rule of the policy depends on it.
//! - `0xff10` in the GroupContext: the policy, i.e. the attestation public
//!   key of every generation and the owner tag. The tag stands for the
//!   owner's person (see [`crate::crypto::Keyring::owner_tag`]); an owner is
//!   an editor whose leaf identity resolves to that person, so there is no
//!   owner extension on leaves. Every member checks commits against the
//!   policy, and only a commit can change it.
//!
//! openmls only lets a leaf carry an extension type, or a group require
//! one, when the leaf's capabilities list it. A joiner that forgets one
//! fails to build its external commit, so [`capabilities`] lists them all.

use loro_protocol::{BytesReader, BytesWriter};
use openmls::prelude::*;

use super::owner_share::OwnerShares;
use crate::codec::plausible_count;
use crate::crypto::{Attestation, KEY_LEN, PublicKey, SIGNATURE_LEN};

pub const EXT_EDITOR: u16 = 0xff00;
pub const EXT_PROFILE: u16 = 0xff01;
pub const EXT_IDENTITY: u16 = 0xff02;
pub const EXT_OWNER_SHARES: u16 = 0xff03;
pub const EXT_POLICY: u16 = 0xff10;

/// X25519, AES-128-GCM, SHA-256, Ed25519: the suite every MLS client has to
/// support, and the one the HPKE helpers below use as well.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

const EDITOR_VERSION: u8 = 1;
const POLICY_VERSION: u8 = 1;

/// Upper bound for the policy's list. Each rotation adds 32 bytes, so this
/// is far beyond what a project reaches and only keeps junk out.
const MAX_POLICY_ENTRIES: usize = 4096;

/// What an editor's leaf says about its holder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorInfo {
    pub generation: u32,
    pub attestation: Attestation,
    pub hpke_pub: Vec<u8>,
}

impl EditorInfo {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(EDITOR_VERSION);
        w.push_uleb128(u64::from(self.generation));
        w.push_bytes(&self.attestation);
        w.push_var_bytes(&self.hpke_pub);
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = BytesReader::new(bytes);
        version(&mut r, EDITOR_VERSION)?;
        let generation = u32::try_from(r.read_uleb128()?).map_err(|_| "generation too large")?;
        let attestation = r
            .read_bytes(SIGNATURE_LEN)?
            .try_into()
            .expect("read 64 bytes");
        let hpke_pub = r.read_var_bytes()?.to_vec();
        done(&r)?;
        Ok(Self {
            generation,
            attestation,
            hpke_pub,
        })
    }
}

/// The group's policy, as carried in the GroupContext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// The attestation public key of each generation, oldest first. Its
    /// length is the current generation. Leaves attested in an older
    /// generation stay valid, so every key has to stay.
    pub attest_pubs: Vec<PublicKey>,
    /// The tag of the owner's person, fixed for the life of the project and
    /// kept by every rotation and reset.
    pub owner_tag: [u8; KEY_LEN],
}

impl Policy {
    pub fn new(attest_pub: PublicKey, owner_tag: [u8; KEY_LEN]) -> Self {
        Self {
            attest_pubs: vec![attest_pub],
            owner_tag,
        }
    }

    pub fn generation(&self) -> u32 {
        self.attest_pubs.len() as u32
    }

    pub fn attest_pub(&self, generation: u32) -> Option<&PublicKey> {
        self.attest_pubs
            .get(usize::try_from(generation.checked_sub(1)?).ok()?)
    }

    /// The policy after a rotation to a link with `attest_pub`.
    pub fn next(&self, attest_pub: PublicKey) -> Self {
        let mut next = self.clone();
        next.attest_pubs.push(attest_pub);
        next
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(POLICY_VERSION);
        w.push_bytes(&self.owner_tag);
        w.push_uleb128(self.attest_pubs.len() as u64);
        for key in &self.attest_pubs {
            w.push_bytes(key);
        }
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = BytesReader::new(bytes);
        version(&mut r, POLICY_VERSION)?;
        let owner_tag = r.read_bytes(KEY_LEN)?.try_into().expect("read 32 bytes");
        let count = bounded(&mut r, KEY_LEN)?;
        if count == 0 {
            return Err("policy without a generation".into());
        }
        let mut attest_pubs = Vec::with_capacity(count);
        for _ in 0..count {
            attest_pubs.push(r.read_bytes(KEY_LEN)?.try_into().expect("read 32 bytes"));
        }
        done(&r)?;
        Ok(Self {
            attest_pubs,
            owner_tag,
        })
    }
}

fn version(r: &mut BytesReader<'_>, known: u8) -> Result<(), String> {
    match r.read_byte()? {
        v if v == known => Ok(()),
        v => Err(format!("extension version {v} is not supported")),
    }
}

fn done(r: &BytesReader<'_>) -> Result<(), String> {
    match r.remaining() {
        0 => Ok(()),
        n => Err(format!("{n} trailing bytes")),
    }
}

/// A count checked against the bytes left, so a hostile one cannot make the
/// reader allocate ahead of the data.
fn bounded(r: &mut BytesReader<'_>, min_entry: usize) -> Result<usize, String> {
    let count = plausible_count(r, min_entry)?;
    if count > MAX_POLICY_ENTRIES as u64 {
        return Err(format!("count {count} does not fit"));
    }
    Ok(count as usize)
}

pub fn unknown(ty: u16, bytes: Vec<u8>) -> Extension {
    Extension::Unknown(ty, UnknownExtension(bytes))
}

/// What a leaf of ours supports. Every unknown extension type has to be
/// listed, including the group extension that RequiredCapabilities demands.
pub fn capabilities() -> Capabilities {
    Capabilities::builder()
        .ciphersuites(vec![CIPHERSUITE])
        .extensions(vec![
            ExtensionType::Unknown(EXT_EDITOR),
            ExtensionType::Unknown(EXT_PROFILE),
            ExtensionType::Unknown(EXT_IDENTITY),
            ExtensionType::Unknown(EXT_OWNER_SHARES),
            ExtensionType::Unknown(EXT_POLICY),
        ])
        .build()
}

/// The extensions of a leaf: `editor` only for editors, `profile` already
/// sealed. `sealed_identity` is the sealed leaf identity, for members that
/// have a person, and `owner_shares` the encoded owner key shares of a
/// device that holds the owner key.
pub fn leaf_extensions(
    editor: Option<&EditorInfo>,
    sealed_profile: Vec<u8>,
    sealed_identity: Option<Vec<u8>>,
    owner_shares: Option<Vec<u8>>,
) -> Result<Extensions<LeafNode>, String> {
    let mut exts = Vec::with_capacity(4);
    if let Some(editor) = editor {
        exts.push(unknown(EXT_EDITOR, editor.encode()));
    }
    exts.push(unknown(EXT_PROFILE, sealed_profile));
    if let Some(identity) = sealed_identity {
        exts.push(unknown(EXT_IDENTITY, identity));
    }
    if let Some(shares) = owner_shares {
        exts.push(unknown(EXT_OWNER_SHARES, shares));
    }
    Extensions::from_vec(exts).map_err(|e| e.to_string())
}

pub fn leaf_parameters(
    editor: Option<&EditorInfo>,
    sealed_profile: Vec<u8>,
    sealed_identity: Option<Vec<u8>>,
    owner_shares: Option<Vec<u8>>,
) -> Result<LeafNodeParameters, String> {
    Ok(LeafNodeParameters::builder()
        .with_capabilities(capabilities())
        .with_extensions(leaf_extensions(
            editor,
            sealed_profile,
            sealed_identity,
            owner_shares,
        )?)
        .build())
}

/// The GroupContext extensions: the policy, and the requirement that every
/// member understands it. A GroupContextExtensions proposal replaces the
/// whole set, so rotations have to include both again.
pub fn group_extensions(policy: &Policy) -> Result<Extensions<GroupContext>, String> {
    Extensions::from_vec(vec![
        Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
            &[ExtensionType::Unknown(EXT_POLICY)],
            &[],
            &[],
        )),
        unknown(EXT_POLICY, policy.encode()),
    ])
    .map_err(|e| e.to_string())
}

pub fn read_policy(exts: &Extensions<GroupContext>) -> Result<Policy, String> {
    let ext = exts.unknown(EXT_POLICY).ok_or("group has no policy")?;
    Policy::decode(&ext.0)
}

/// What the typstry extensions of a leaf say. A leaf whose editor extension
/// does not parse is carried as an error, since it must never count as a
/// plain viewer by accident.
pub struct LeafInfo {
    pub editor: Result<Option<EditorInfo>, String>,
    pub sealed_profile: Option<Vec<u8>>,
    pub sealed_identity: Option<Vec<u8>>,
}

pub fn read_leaf(leaf: &LeafNode) -> LeafInfo {
    LeafInfo {
        editor: leaf
            .extensions()
            .unknown(EXT_EDITOR)
            .map(|ext| EditorInfo::decode(&ext.0))
            .transpose(),
        sealed_profile: leaf.extensions().unknown(EXT_PROFILE).map(|e| e.0.clone()),
        sealed_identity: leaf.extensions().unknown(EXT_IDENTITY).map(|e| e.0.clone()),
    }
}

/// A leaf's owner key shares. `None` also when they do not parse, which
/// costs the recipients their share and nobody anything else.
pub fn read_owner_shares(leaf: &LeafNode) -> Option<OwnerShares> {
    let ext = leaf.extensions().unknown(EXT_OWNER_SHARES)?;
    OwnerShares::decode(&ext.0).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_info_round_trips() {
        let info = EditorInfo {
            generation: 3,
            attestation: [7; 64],
            hpke_pub: vec![1, 2, 3],
        };
        assert_eq!(EditorInfo::decode(&info.encode()).unwrap(), info);
        let bytes = info.encode();
        for len in 0..bytes.len() {
            assert!(EditorInfo::decode(&bytes[..len]).is_err(), "{len}");
        }
        assert!(EditorInfo::decode(&[bytes.clone(), vec![0]].concat()).is_err());
        let mut newer = bytes;
        newer[0] = EDITOR_VERSION + 1;
        assert!(EditorInfo::decode(&newer).is_err());
    }

    #[test]
    fn policy_round_trips_and_refuses_junk() {
        let policy = Policy::new([1; 32], [9; 32]).next([2; 32]);
        assert_eq!(policy.generation(), 2);
        assert_eq!(policy.attest_pub(1), Some(&[1; 32]));
        assert_eq!(policy.attest_pub(0), None);
        assert_eq!(policy.attest_pub(3), None);
        let bytes = policy.encode();
        assert_eq!(Policy::decode(&bytes).unwrap(), policy);
        for len in 0..bytes.len() {
            assert!(Policy::decode(&bytes[..len]).is_err(), "{len}");
        }
        assert!(Policy::decode(&[bytes.clone(), vec![0]].concat()).is_err());
        // A count far beyond the data must not allocate.
        let mut huge = vec![POLICY_VERSION];
        huge.extend([9; 32]);
        huge.extend([0xff, 0xff, 0xff, 0x7f]);
        assert!(Policy::decode(&huge).is_err());
        let mut none = vec![POLICY_VERSION];
        none.extend([9; 32]);
        none.push(0);
        assert!(Policy::decode(&none).is_err());
    }
}
