//! One signed statement in a person graph.

use loro_protocol::{BytesReader, BytesWriter};
use sha2::{Digest, Sha256};

use super::{DeviceKey, GraphError, Hash, MAX_GRAPH_ENTRIES, malformed, verify};
use crate::codec::plausible_count;
use crate::crypto::{KEY_LEN, PublicKey, SIGNATURE_LEN};

/// Signed so an entry can never be replayed as another kind of signature.
const ENTRY_CONTEXT: &[u8] = b"typstry:v1:person-entry";
const ENTRY_VERSION: u8 = 1;

const KIND_GENESIS: u8 = 0;
const KIND_ADD: u8 = 1;
const KIND_REVOKE: u8 = 2;
const KIND_PROFILE: u8 = 3;

/// Marks a device as a recovery device: it can add and revoke devices but is
/// never itself a device that joins projects.
pub const FLAG_RECOVERY: u8 = 1;
const KNOWN_FLAGS: u8 = FLAG_RECOVERY;

/// Upper bound on a profile entry, which every leaf of every project carries
/// in its graph.
pub const MAX_PROFILE_LEN: usize = 256;

/// The least an entry takes: version, parent count, author, kind and
/// signature. Bounds the count a hostile graph can claim.
pub(super) const MIN_ENTRY_BYTES: usize = 1 + 1 + KEY_LEN + 1 + SIGNATURE_LEN;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    /// Starts the graph. Its author is the first device.
    Genesis,
    AddDevice {
        device: PublicKey,
        flags: u8,
    },
    RevokeDevice {
        device: PublicKey,
    },
    /// The person's own name and colour, as the same JSON bytes the clients
    /// put in a leaf profile. Opaque to the graph.
    SetProfile {
        profile: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Every head the author knew, sorted and without duplicates, so that
    /// one statement has one encoding and one hash.
    pub parents: Vec<Hash>,
    pub author: PublicKey,
    pub kind: EntryKind,
    pub sig: [u8; SIGNATURE_LEN],
}

impl Entry {
    pub(super) fn sign(key: &DeviceKey, mut parents: Vec<Hash>, kind: EntryKind) -> Self {
        parents.sort_unstable();
        parents.dedup();
        let mut entry = Self {
            parents,
            author: key.public(),
            kind,
            sig: [0; SIGNATURE_LEN],
        };
        entry.sig = key.sign(&entry.message());
        entry
    }

    /// Everything the signature covers.
    fn unsigned(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(ENTRY_VERSION);
        w.push_uleb128(self.parents.len() as u64);
        for parent in &self.parents {
            w.push_bytes(parent);
        }
        w.push_bytes(&self.author);
        match &self.kind {
            EntryKind::Genesis => w.push_byte(KIND_GENESIS),
            EntryKind::AddDevice { device, flags } => {
                w.push_byte(KIND_ADD);
                w.push_bytes(device);
                w.push_byte(*flags);
            }
            EntryKind::RevokeDevice { device } => {
                w.push_byte(KIND_REVOKE);
                w.push_bytes(device);
            }
            EntryKind::SetProfile { profile } => {
                w.push_byte(KIND_PROFILE);
                w.push_var_bytes(profile);
            }
        }
        w.finalize()
    }

    fn message(&self) -> Vec<u8> {
        [ENTRY_CONTEXT, &self.unsigned()].concat()
    }

    pub fn encode(&self) -> Vec<u8> {
        [self.unsigned(), self.sig.to_vec()].concat()
    }

    /// The hash covers the signature too, so two signatures over one
    /// statement are two entries.
    pub fn hash(&self) -> Hash {
        Sha256::digest(self.encode()).into()
    }

    pub fn verify(&self) -> Result<(), GraphError> {
        verify(&self.author, &self.message(), &self.sig)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, GraphError> {
        let mut r = BytesReader::new(bytes);
        let entry = Self::read(&mut r)?;
        match r.remaining() {
            0 => Ok(entry),
            n => Err(malformed("person entry", format!("{n} trailing bytes"))),
        }
    }

    pub(super) fn read(r: &mut BytesReader<'_>) -> Result<Self, GraphError> {
        let bad = |e: String| malformed("person entry", e);
        match r.read_byte().map_err(bad)? {
            ENTRY_VERSION => {}
            v => return Err(GraphError::NewerVersion(v)),
        }
        let count = plausible_count(r, KEY_LEN).map_err(bad)?;
        if count > MAX_GRAPH_ENTRIES as u64 {
            return Err(GraphError::TooLarge);
        }
        let mut parents: Vec<Hash> = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let parent: Hash = r
                .read_bytes(KEY_LEN)
                .map_err(bad)?
                .try_into()
                .expect("read 32 bytes");
            if parents.last().is_some_and(|last| *last >= parent) {
                return Err(bad("parents are not sorted and unique".into()));
            }
            parents.push(parent);
        }
        let author = r
            .read_bytes(KEY_LEN)
            .map_err(bad)?
            .try_into()
            .expect("read 32 bytes");
        let key = |r: &mut BytesReader<'_>| -> Result<PublicKey, GraphError> {
            Ok(r.read_bytes(KEY_LEN)
                .map_err(bad)?
                .try_into()
                .expect("read 32 bytes"))
        };
        let kind = match r.read_byte().map_err(bad)? {
            KIND_GENESIS => EntryKind::Genesis,
            KIND_ADD => {
                let device = key(r)?;
                let flags = r.read_byte().map_err(bad)?;
                if flags & !KNOWN_FLAGS != 0 {
                    return Err(bad(format!("unknown flags {flags:#x}")));
                }
                EntryKind::AddDevice { device, flags }
            }
            KIND_REVOKE => EntryKind::RevokeDevice { device: key(r)? },
            KIND_PROFILE => {
                let profile = r.read_var_bytes().map_err(bad)?;
                if profile.len() > MAX_PROFILE_LEN {
                    return Err(GraphError::TooLarge);
                }
                EntryKind::SetProfile {
                    profile: profile.to_vec(),
                }
            }
            // A kind this build lacks comes from a newer typstry.
            other => return Err(GraphError::NewerVersion(other)),
        };
        let sig = r
            .read_bytes(SIGNATURE_LEN)
            .map_err(bad)?
            .try_into()
            .expect("read 64 bytes");
        let entry = Self {
            parents,
            author,
            kind,
            sig,
        };
        // The genesis is the only entry without parents, and the graph
        // relies on that to find it.
        if entry.parents.is_empty() != (entry.kind == EntryKind::Genesis) {
            return Err(GraphError::Genesis);
        }
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(key: &DeviceKey, parent: Hash, device: PublicKey) -> Entry {
        Entry::sign(key, vec![parent], EntryKind::AddDevice { device, flags: 0 })
    }

    #[test]
    fn roundtrips_and_hashes_the_signature() {
        let key = DeviceKey::generate();
        let entry = add(&key, [3; 32], [4; 32]);
        let bytes = entry.encode();
        assert_eq!(Entry::decode(&bytes).unwrap(), entry);
        assert_eq!(entry.hash(), Entry::decode(&bytes).unwrap().hash());
        assert!(entry.verify().is_ok());
        let mut other = entry.clone();
        other.sig[0] ^= 1;
        assert_ne!(other.hash(), entry.hash());
        assert_eq!(other.verify(), Err(GraphError::BadSignature));
    }

    #[test]
    fn parents_are_canonical() {
        let key = DeviceKey::generate();
        let entry = Entry::sign(
            &key,
            vec![[9; 32], [1; 32], [9; 32]],
            EntryKind::RevokeDevice { device: [2; 32] },
        );
        assert_eq!(entry.parents, vec![[1; 32], [9; 32]]);

        let mut unsorted = entry.clone();
        unsorted.parents.reverse();
        assert!(matches!(
            Entry::decode(&unsorted.encode()),
            Err(GraphError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_bad_encodings() {
        let key = DeviceKey::generate();
        let bytes = add(&key, [3; 32], [4; 32]).encode();
        for len in 0..bytes.len() {
            assert!(Entry::decode(&bytes[..len]).is_err(), "prefix of {len}");
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(matches!(
            Entry::decode(&trailing),
            Err(GraphError::Malformed(_))
        ));
        let mut newer = bytes.clone();
        newer[0] = 2;
        assert_eq!(Entry::decode(&newer), Err(GraphError::NewerVersion(2)));
    }

    #[test]
    fn rejects_unknown_flags_and_misplaced_genesis() {
        let key = DeviceKey::generate();
        let flagged = Entry::sign(
            &key,
            vec![[3; 32]],
            EntryKind::AddDevice {
                device: [4; 32],
                flags: 0x80,
            },
        );
        assert!(Entry::decode(&flagged.encode()).is_err());

        let orphan = Entry::sign(&key, vec![], EntryKind::RevokeDevice { device: [4; 32] });
        assert_eq!(Entry::decode(&orphan.encode()), Err(GraphError::Genesis));
        let child = Entry::sign(&key, vec![[3; 32]], EntryKind::Genesis);
        assert_eq!(Entry::decode(&child.encode()), Err(GraphError::Genesis));
    }

    #[test]
    fn profile_roundtrips_and_is_capped() {
        let key = DeviceKey::generate();
        let sign =
            |profile: Vec<u8>| Entry::sign(&key, vec![[3; 32]], EntryKind::SetProfile { profile });
        let entry = sign(br#"{"name":"Ada"}"#.to_vec());
        assert_eq!(Entry::decode(&entry.encode()).unwrap(), entry);
        let full = sign(vec![b'x'; MAX_PROFILE_LEN]);
        assert_eq!(Entry::decode(&full.encode()).unwrap(), full);
        let over = sign(vec![b'x'; MAX_PROFILE_LEN + 1]);
        assert_eq!(Entry::decode(&over.encode()), Err(GraphError::TooLarge));
    }

    #[test]
    fn unknown_kind_reads_as_newer() {
        let key = DeviceKey::generate();
        let mut bytes = add(&key, [3; 32], [4; 32]).encode();
        // version, count, one parent, author, then the kind byte.
        bytes[1 + 1 + KEY_LEN + KEY_LEN] = 9;
        assert_eq!(Entry::decode(&bytes), Err(GraphError::NewerVersion(9)));
    }
}
