//! The set of signed entries that says which devices make up a person.

use std::collections::{BTreeMap, BTreeSet};

use loro_protocol::{BytesReader, BytesWriter};

use super::entry::{Entry, EntryKind, MAX_PROFILE_LEN, MIN_ENTRY_BYTES};
use super::validity::Validity;
use super::{DeviceKey, GraphError, Hash, MAX_GRAPH_BYTES, MAX_GRAPH_ENTRIES, PersonId, malformed};
use crate::codec::plausible_count;
use crate::crypto::PublicKey;

const GRAPH_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceState {
    Valid,
    /// An effective revoke targets it, for good.
    Revoked,
    /// Nothing in the graph counts it as a device of the person.
    Unknown,
}

/// A device the graph has a verdict on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device: PublicKey,
    pub state: DeviceState,
    pub recovery: bool,
}

/// A person's devices, as a hash-linked DAG of entries. Whatever its
/// replicas learned in whatever order, the same entries give the same
/// verdict, so merging is a union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonGraph {
    id: PersonId,
    entries: BTreeMap<Hash, Entry>,
    validity: Validity,
}

impl PersonGraph {
    /// A new person whose first device is `device`.
    pub fn genesis(device: &DeviceKey) -> Self {
        let entry = Entry::sign(device, Vec::new(), EntryKind::Genesis);
        Self::from_signed_entries([(entry.hash(), entry)].into())
            .expect("a lone genesis is a graph")
    }

    /// Checks everything a replica must not take on trust: the caps, the
    /// single genesis, every signature and the parent links.
    fn from_entries(entries: BTreeMap<Hash, Entry>) -> Result<Self, GraphError> {
        let id = Self::genesis_of(&entries)?;
        for entry in entries.values() {
            entry.verify()?;
        }
        Self::with_validity(id, entries)
    }

    /// [`Self::from_entries`] minus the signature checks, for entries that
    /// were verified on their way in or that this replica signed itself.
    /// Ed25519 verification dominates rebuilding a graph, and merge and
    /// append would otherwise redo it for every entry each time.
    fn from_signed_entries(entries: BTreeMap<Hash, Entry>) -> Result<Self, GraphError> {
        let id = Self::genesis_of(&entries)?;
        Self::with_validity(id, entries)
    }

    /// Enforces the entry cap and the single genesis, returning the person.
    fn genesis_of(entries: &BTreeMap<Hash, Entry>) -> Result<PersonId, GraphError> {
        if entries.len() > MAX_GRAPH_ENTRIES {
            return Err(GraphError::TooLarge);
        }
        let mut geneses = entries.iter().filter(|(_, e)| e.kind == EntryKind::Genesis);
        let (id, _) = geneses.next().ok_or(GraphError::Genesis)?;
        if geneses.next().is_some()
            || entries
                .values()
                .any(|e| e.parents.is_empty() != (e.kind == EntryKind::Genesis))
        {
            return Err(GraphError::Genesis);
        }
        Ok(*id)
    }

    /// Checks the parent links and the byte cap.
    fn with_validity(id: PersonId, entries: BTreeMap<Hash, Entry>) -> Result<Self, GraphError> {
        let validity = Validity::compute(&entries)?;
        let graph = Self {
            id,
            entries,
            validity,
        };
        if graph.encoded_len() > MAX_GRAPH_BYTES {
            return Err(GraphError::TooLarge);
        }
        Ok(graph)
    }

    /// `self.encode().len()` without building the whole encoding: the
    /// entries sit back to back after the version byte and their count.
    fn encoded_len(&self) -> usize {
        let count = self.entries.len() as u64;
        let count_len = (u64::BITS - count.max(1).leading_zeros()).div_ceil(7) as usize;
        1 + count_len
            + self
                .entries
                .values()
                .map(|e| e.encode().len())
                .sum::<usize>()
    }

    /// The person: the hash of the genesis entry.
    pub fn id(&self) -> PersonId {
        self.id
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Never empty, as a graph has its genesis; here for the convention.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The entries nothing builds on yet, sorted.
    pub fn heads(&self) -> Vec<Hash> {
        let parents: BTreeSet<&Hash> = self.entries.values().flat_map(|e| &e.parents).collect();
        self.entries
            .keys()
            .filter(|h| !parents.contains(h))
            .copied()
            .collect()
    }

    pub fn device_state(&self, device: &PublicKey) -> DeviceState {
        if self.validity.valid.contains(device) {
            DeviceState::Valid
        } else if self.validity.revoked.contains(device) {
            DeviceState::Revoked
        } else {
            DeviceState::Unknown
        }
    }

    /// Whether a counting add flagged the device as recovery. Such a device
    /// can add and revoke devices but is never a device that joins projects.
    pub fn is_recovery(&self, device: &PublicKey) -> bool {
        self.validity.recovery.contains(device)
    }

    /// The device that added `device`, for labelling it. `None` for a
    /// device the graph does not count and for one only the genesis
    /// introduced. With several counting adds the one with the lowest entry
    /// hash answers, so every replica names the same device.
    pub fn added_by(&self, device: &PublicKey) -> Option<PublicKey> {
        self.validity.added_by.get(device).copied()
    }

    /// The person's own profile bytes: the latest counting `SetProfile`,
    /// ties between concurrent ones broken by entry hash. Clients should
    /// append one only when the profile actually changed, since every entry
    /// stays in the graph for good and counts toward [`MAX_GRAPH_ENTRIES`].
    pub fn profile(&self) -> Option<&[u8]> {
        self.validity.profile.as_deref()
    }

    /// Every device the graph has a verdict on, valid or revoked, sorted by
    /// key.
    pub fn devices(&self) -> Vec<DeviceInfo> {
        let mut seen: BTreeSet<PublicKey> = BTreeSet::new();
        for entry in self.entries.values() {
            seen.insert(entry.author);
            if let EntryKind::AddDevice { device, .. } | EntryKind::RevokeDevice { device } =
                &entry.kind
            {
                seen.insert(*device);
            }
        }
        seen.into_iter()
            .map(|device| DeviceInfo {
                device,
                state: self.device_state(&device),
                recovery: self.is_recovery(&device),
            })
            .filter(|info| info.state != DeviceState::Unknown)
            .collect()
    }

    /// Sorted by key.
    pub fn valid_devices(&self) -> Vec<PublicKey> {
        self.validity.valid.iter().copied().collect()
    }

    /// Whether every entry of `other` is in this graph too.
    pub fn is_superset_of(&self, other: &Self) -> bool {
        other.entries.keys().all(|h| self.entries.contains_key(h))
    }

    /// Takes in what `other` knows. Both sides get the same graph whichever
    /// merges into whichever. On error nothing changes.
    pub fn merge(&mut self, other: &Self) -> Result<(), GraphError> {
        if self.id != other.id {
            return Err(GraphError::ForeignGraph);
        }
        let mut entries = self.entries.clone();
        entries.extend(other.entries.iter().map(|(h, e)| (*h, e.clone())));
        *self = Self::from_signed_entries(entries)?;
        Ok(())
    }

    /// Extends the graph on top of every current head. Only a device that
    /// counts as valid may speak for the person; the entries of a revoked
    /// one would be ignored anyway, and refusing is the clearer answer.
    pub fn append(&mut self, signer: &DeviceKey, kind: EntryKind) -> Result<Hash, GraphError> {
        if kind == EntryKind::Genesis {
            return Err(GraphError::Genesis);
        }
        if self.device_state(&signer.public()) != DeviceState::Valid {
            return Err(GraphError::NotValid);
        }
        match &kind {
            EntryKind::SetProfile { profile } if profile.len() > MAX_PROFILE_LEN => {
                return Err(GraphError::TooLarge);
            }
            // Its entries would be ignored, so refuse rather than spend a
            // slot of the cap on nothing.
            EntryKind::SetProfile { .. } if self.is_recovery(&signer.public()) => {
                return Err(GraphError::NotValid);
            }
            _ => {}
        }
        let entry = Entry::sign(signer, self.heads(), kind);
        let hash = entry.hash();
        let mut entries = self.entries.clone();
        entries.insert(hash, entry);
        *self = Self::from_signed_entries(entries)?;
        Ok(hash)
    }

    /// `signer` adds `device` as an ordinary device, which is how pairing
    /// vouches for a new one. True if an entry was added, false if the
    /// device is valid already, so a retried pairing does not spend a slot
    /// of the cap twice. Fails with [`GraphError::NotValid`] for a signer
    /// that is not valid, even when there is nothing to add, and with
    /// [`GraphError::DeviceRevoked`] for a device that was revoked: a revoke
    /// is final, and adding it again would only look like it worked.
    pub fn vouch(&mut self, signer: &DeviceKey, device: &PublicKey) -> Result<bool, GraphError> {
        if self.device_state(&signer.public()) != DeviceState::Valid {
            return Err(GraphError::NotValid);
        }
        match self.device_state(device) {
            DeviceState::Valid => Ok(false),
            DeviceState::Revoked => Err(GraphError::DeviceRevoked),
            DeviceState::Unknown => {
                self.append(
                    signer,
                    EntryKind::AddDevice {
                        device: *device,
                        flags: 0,
                    },
                )?;
                Ok(true)
            }
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(GRAPH_VERSION);
        w.push_uleb128(self.entries.len() as u64);
        for entry in self.entries.values() {
            w.push_bytes(&entry.encode());
        }
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, GraphError> {
        if bytes.len() > MAX_GRAPH_BYTES {
            return Err(GraphError::TooLarge);
        }
        let bad = |e: String| malformed("person graph", e);
        let mut r = BytesReader::new(bytes);
        match r.read_byte().map_err(bad)? {
            GRAPH_VERSION => {}
            v => return Err(GraphError::NewerVersion(v)),
        }
        let count = plausible_count(&mut r, MIN_ENTRY_BYTES).map_err(bad)?;
        if count > MAX_GRAPH_ENTRIES as u64 {
            return Err(GraphError::TooLarge);
        }
        let mut entries = BTreeMap::new();
        for _ in 0..count {
            let entry = Entry::read(&mut r)?;
            let hash = entry.hash();
            // Ascending hashes, so a graph has one encoding and a repeated
            // entry cannot pad it.
            if entries
                .last_key_value()
                .is_some_and(|(last, _)| *last >= hash)
            {
                return Err(bad("entries are not sorted and unique".into()));
            }
            entries.insert(hash, entry);
        }
        match r.remaining() {
            0 => Self::from_entries(entries),
            n => Err(bad(format!("{n} trailing bytes"))),
        }
    }

    /// Adds an entry without any of the checks `append` makes, to build the
    /// graphs a misbehaving device would.
    #[cfg(test)]
    fn push_unchecked(&mut self, entry: Entry) {
        let mut entries = self.entries.clone();
        entries.insert(entry.hash(), entry);
        *self = Self::from_entries(entries).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::FLAG_RECOVERY;

    fn add(device: &DeviceKey) -> EntryKind {
        EntryKind::AddDevice {
            device: device.public(),
            flags: 0,
        }
    }

    fn recovery(device: &DeviceKey) -> EntryKind {
        EntryKind::AddDevice {
            device: device.public(),
            flags: FLAG_RECOVERY,
        }
    }

    fn profile(text: &str) -> EntryKind {
        EntryKind::SetProfile {
            profile: text.as_bytes().to_vec(),
        }
    }

    fn revoke(device: &DeviceKey) -> EntryKind {
        EntryKind::RevokeDevice {
            device: device.public(),
        }
    }

    fn state(g: &PersonGraph, d: &DeviceKey) -> DeviceState {
        g.device_state(&d.public())
    }

    /// `a` made the person and added `b`.
    fn pair() -> (DeviceKey, DeviceKey, PersonGraph) {
        let (a, b) = (DeviceKey::generate(), DeviceKey::generate());
        let mut g = PersonGraph::genesis(&a);
        g.append(&a, add(&b)).unwrap();
        (a, b, g)
    }

    #[test]
    fn devices_lists_valid_and_revoked_ones() {
        let (a, b, mut g) = pair();
        let c = DeviceKey::generate();
        g.append(&a, add(&c)).unwrap();
        g.append(&a, revoke(&b)).unwrap();
        let r = DeviceKey::generate();
        g.append(&a, recovery(&r)).unwrap();
        let info = |d: &DeviceKey, state, recovery| DeviceInfo {
            device: d.public(),
            state,
            recovery,
        };
        let mut expected = vec![
            info(&a, DeviceState::Valid, false),
            info(&b, DeviceState::Revoked, false),
            info(&c, DeviceState::Valid, false),
            info(&r, DeviceState::Valid, true),
        ];
        expected.sort_by_key(|i| i.device);
        assert_eq!(g.devices(), expected);
    }

    #[test]
    fn genesis_and_append() {
        let (a, b, mut g) = pair();
        assert_eq!(g.len(), 2);
        assert_eq!(g.heads().len(), 1);
        assert_eq!(state(&g, &a), DeviceState::Valid);
        assert_eq!(state(&g, &b), DeviceState::Valid);
        let stranger = DeviceKey::generate();
        assert_eq!(state(&g, &stranger), DeviceState::Unknown);
        assert_eq!(
            g.append(&stranger, add(&stranger)),
            Err(GraphError::NotValid)
        );
        assert_eq!(g.append(&a, EntryKind::Genesis), Err(GraphError::Genesis));
        let mut want = vec![a.public(), b.public()];
        want.sort();
        assert_eq!(g.valid_devices(), want);
    }

    #[test]
    fn add_before_revoke_survives() {
        let (a, b, mut g) = pair();
        let c = DeviceKey::generate();
        g.append(&b, add(&c)).unwrap();
        g.append(&a, revoke(&b)).unwrap();
        assert_eq!(state(&g, &b), DeviceState::Revoked);
        assert_eq!(state(&g, &c), DeviceState::Valid);
        assert_eq!(g.heads().len(), 1);
    }

    #[test]
    fn add_concurrent_with_the_signers_revoke_is_invalid() {
        let (a, b, g) = pair();
        let c = DeviceKey::generate();
        let (mut by_b, mut by_a) = (g.clone(), g);
        by_b.append(&b, add(&c)).unwrap();
        by_a.append(&a, revoke(&b)).unwrap();
        by_a.merge(&by_b).unwrap();
        assert_eq!(state(&by_a, &b), DeviceState::Revoked);
        assert_eq!(state(&by_a, &c), DeviceState::Unknown);
        assert_eq!(by_a.heads().len(), 2);
    }

    #[test]
    fn mutual_concurrent_revokes_revoke_both() {
        let (a, b, g) = pair();
        let (mut by_a, mut by_b) = (g.clone(), g);
        by_a.append(&a, revoke(&b)).unwrap();
        by_b.append(&b, revoke(&a)).unwrap();
        by_a.merge(&by_b).unwrap();
        assert_eq!(state(&by_a, &a), DeviceState::Revoked);
        assert_eq!(state(&by_a, &b), DeviceState::Revoked);
        assert!(by_a.valid_devices().is_empty());
    }

    #[test]
    fn revoked_devices_later_entries_are_ignored() {
        let (a, b, mut g) = pair();
        let (c, d) = (DeviceKey::generate(), DeviceKey::generate());
        // An add written on a stale head, unaware of the revoke.
        let mut stale = g.clone();
        stale.append(&b, add(&c)).unwrap();
        g.append(&a, revoke(&b)).unwrap();
        g.merge(&stale).unwrap();
        assert_eq!(state(&g, &c), DeviceState::Unknown);

        // An add that does build on the revoke, which `append` would refuse.
        g.push_unchecked(Entry::sign(&b, g.heads(), add(&d)));
        assert_eq!(state(&g, &d), DeviceState::Unknown);
        assert_eq!(g.append(&b, add(&d)), Err(GraphError::NotValid));
        // A revoke from it does nothing either.
        g.push_unchecked(Entry::sign(&b, g.heads(), revoke(&a)));
        assert_eq!(state(&g, &a), DeviceState::Valid);
    }

    #[test]
    fn devices_added_by_a_device_that_does_not_count_do_not_count() {
        let (a, b, g) = pair();
        let (c, d) = (DeviceKey::generate(), DeviceKey::generate());
        // The thief on b adds c on a stale head, and c adds d on top of that.
        let mut thief = g.clone();
        thief.append(&b, add(&c)).unwrap();
        thief.append(&c, add(&d)).unwrap();
        let mut owner = g;
        owner.append(&a, revoke(&b)).unwrap();
        owner.merge(&thief).unwrap();
        assert_eq!(state(&owner, &c), DeviceState::Unknown);
        assert_eq!(state(&owner, &d), DeviceState::Unknown);
        assert_eq!(owner.valid_devices(), vec![a.public()]);
    }

    #[test]
    fn genesis_device_can_be_revoked_by_another() {
        let (a, b, mut g) = pair();
        let c = DeviceKey::generate();
        g.append(&b, add(&c)).unwrap();
        g.append(&b, revoke(&a)).unwrap();
        assert_eq!(state(&g, &a), DeviceState::Revoked);
        assert_eq!(state(&g, &b), DeviceState::Valid);
        // The revoke came after the add, so what a added or b added still
        // stands, but a can no longer extend the graph.
        assert_eq!(state(&g, &c), DeviceState::Valid);
        assert_eq!(g.append(&a, add(&a)), Err(GraphError::NotValid));
    }

    #[test]
    fn a_revoked_device_stays_revoked_when_added_again() {
        let (a, b, mut g) = pair();
        g.append(&a, revoke(&b)).unwrap();
        g.append(&a, add(&b)).unwrap();
        assert_eq!(state(&g, &b), DeviceState::Revoked);
    }

    /// Three forks off one base, each with its own add or revoke.
    fn forks() -> Vec<PersonGraph> {
        let (a, b, base) = pair();
        let (c, d) = (DeviceKey::generate(), DeviceKey::generate());
        let mut one = base.clone();
        one.append(&b, add(&c)).unwrap();
        let mut two = base.clone();
        two.append(&a, revoke(&b)).unwrap();
        let mut three = base;
        three.append(&a, add(&d)).unwrap();
        vec![one, two, three]
    }

    #[test]
    fn merge_is_commutative_and_idempotent() {
        let forks = forks();
        let orders = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];
        let mut results = Vec::new();
        for order in orders {
            let mut g = forks[order[0]].clone();
            for &i in &order[1..] {
                g.merge(&forks[i]).unwrap();
                // Again changes nothing.
                let before = g.clone();
                g.merge(&forks[i]).unwrap();
                assert_eq!(g, before);
            }
            results.push(g);
        }
        assert!(results.windows(2).all(|w| w[0] == w[1]));
        assert_eq!(results[0].encode(), results[5].encode());
        assert!(results[0].is_superset_of(&forks[1]));
        assert!(!forks[1].is_superset_of(&results[0]));
        // Merging in a pairwise tree gives the same graph as a chain.
        let mut ab = forks[0].clone();
        ab.merge(&forks[1]).unwrap();
        let mut bc = forks[1].clone();
        bc.merge(&forks[2]).unwrap();
        ab.merge(&bc).unwrap();
        assert_eq!(ab, results[0]);
    }

    #[test]
    fn foreign_genesis_merge_is_refused() {
        let (_, _, mut g) = pair();
        let other = PersonGraph::genesis(&DeviceKey::generate());
        let before = g.clone();
        assert_eq!(g.merge(&other), Err(GraphError::ForeignGraph));
        assert_eq!(g, before);
    }

    #[test]
    fn decode_roundtrips() {
        let (a, _, mut g) = pair();
        g.append(&a, add(&DeviceKey::generate())).unwrap();
        let decoded = PersonGraph::decode(&g.encode()).unwrap();
        assert_eq!(decoded, g);
        assert_eq!(decoded.id(), g.id());
    }

    #[test]
    fn encoded_len_matches_the_encoding() {
        let (a, _, mut g) = pair();
        assert_eq!(g.encoded_len(), g.encode().len());
        g.append(&a, profile("Ada")).unwrap();
        g.append(&a, revoke(&DeviceKey::generate())).unwrap();
        assert_eq!(g.encoded_len(), g.encode().len());
    }

    #[test]
    fn decode_refuses_a_missing_parent() {
        let (a, _, g) = pair();
        let orphan = Entry::sign(&a, vec![[9; 32]], add(&a));
        let mut entries = g.entries.clone();
        entries.insert(orphan.hash(), orphan);
        assert_eq!(
            PersonGraph::from_entries(entries.clone()),
            Err(GraphError::MissingParent)
        );
        let mut w = BytesWriter::new();
        w.push_byte(GRAPH_VERSION);
        w.push_uleb128(entries.len() as u64);
        for e in entries.values() {
            w.push_bytes(&e.encode());
        }
        assert_eq!(
            PersonGraph::decode(&w.finalize()),
            Err(GraphError::MissingParent)
        );
    }

    #[test]
    fn decode_refuses_a_tampered_signature() {
        let (_, _, g) = pair();
        let mut bytes = g.encode();
        // The last byte is part of an entry's signature.
        *bytes.last_mut().unwrap() ^= 1;
        assert!(PersonGraph::decode(&bytes).is_err());
    }

    #[test]
    fn decode_refuses_a_forged_author() {
        let (a, _, g) = pair();
        let mut forged = Entry::sign(&a, g.heads(), add(&a));
        forged.author = DeviceKey::generate().public();
        let mut entries = g.entries.clone();
        entries.insert(forged.hash(), forged);
        assert_eq!(
            PersonGraph::from_entries(entries),
            Err(GraphError::BadSignature)
        );
    }

    #[test]
    fn decode_refuses_zero_or_two_geneses() {
        let (_, _, g) = pair();
        let second = Entry::sign(&DeviceKey::generate(), vec![], EntryKind::Genesis);
        let mut two = g.entries.clone();
        two.insert(second.hash(), second);
        assert_eq!(PersonGraph::from_entries(two), Err(GraphError::Genesis));
        assert_eq!(
            PersonGraph::from_entries(BTreeMap::new()),
            Err(GraphError::Genesis)
        );
    }

    #[test]
    fn decode_rejects_bad_encodings() {
        let (_, _, g) = pair();
        let bytes = g.encode();
        for len in 0..bytes.len() {
            assert!(PersonGraph::decode(&bytes[..len]).is_err(), "prefix {len}");
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(matches!(
            PersonGraph::decode(&trailing),
            Err(GraphError::Malformed(_))
        ));
        let mut newer = bytes.clone();
        newer[0] = 2;
        assert_eq!(
            PersonGraph::decode(&newer),
            Err(GraphError::NewerVersion(2))
        );
    }

    #[test]
    fn decode_refuses_unsorted_or_repeated_entries() {
        let (_, _, g) = pair();
        let entries: Vec<_> = g.entries.values().collect();
        for order in [[0, 0], [1, 0]] {
            let mut w = BytesWriter::new();
            w.push_byte(GRAPH_VERSION);
            w.push_uleb128(2);
            for i in order {
                w.push_bytes(&entries[i].encode());
            }
            assert!(PersonGraph::decode(&w.finalize()).is_err());
        }
    }

    #[test]
    fn decode_refuses_a_hostile_count() {
        let mut w = BytesWriter::new();
        w.push_byte(GRAPH_VERSION);
        w.push_uleb128(1 << 60);
        assert!(PersonGraph::decode(&w.finalize()).is_err());
    }

    #[test]
    fn entry_cap_holds() {
        let a = DeviceKey::generate();
        let mut g = PersonGraph::genesis(&a);
        for _ in 1..MAX_GRAPH_ENTRIES {
            g.append(&a, add(&DeviceKey::generate())).unwrap();
        }
        assert_eq!(g.len(), MAX_GRAPH_ENTRIES);
        let before = g.clone();
        assert_eq!(
            g.append(&a, add(&DeviceKey::generate())),
            Err(GraphError::TooLarge)
        );
        assert_eq!(g, before);
        assert!(g.encode().len() <= MAX_GRAPH_BYTES);
        assert_eq!(PersonGraph::decode(&g.encode()).unwrap(), g);
    }

    #[test]
    fn merge_rechecks_the_caps() {
        let a = DeviceKey::generate();
        let mut base = PersonGraph::genesis(&a);
        for _ in 1..MAX_GRAPH_ENTRIES - 1 {
            base.append(&a, add(&DeviceKey::generate())).unwrap();
        }
        let (mut left, mut right) = (base.clone(), base);
        left.append(&a, add(&DeviceKey::generate())).unwrap();
        right.append(&a, add(&DeviceKey::generate())).unwrap();
        let before = left.clone();
        assert_eq!(left.merge(&right), Err(GraphError::TooLarge));
        assert_eq!(left, before);
    }

    #[test]
    fn byte_cap_holds() {
        // Many parents make entries big, so the bytes bind before the count.
        let a = DeviceKey::generate();
        let base = PersonGraph::genesis(&a);
        let mut entries = base.entries.clone();
        let genesis = *entries.keys().next().unwrap();
        let mut heads = vec![genesis];
        for i in 0..MAX_GRAPH_ENTRIES - 1 {
            let e = Entry::sign(
                &a,
                heads.clone(),
                EntryKind::AddDevice {
                    device: [i as u8; 32],
                    flags: 0,
                },
            );
            heads.push(e.hash());
            entries.insert(e.hash(), e);
        }
        assert_eq!(
            PersonGraph::from_entries(entries),
            Err(GraphError::TooLarge)
        );
    }

    #[test]
    fn recovery_device_adds_and_revokes_but_is_flagged() {
        let (a, b, mut g) = pair();
        let r = DeviceKey::generate();
        g.append(&a, recovery(&r)).unwrap();
        assert!(g.is_recovery(&r.public()));
        assert!(!g.is_recovery(&a.public()));
        assert_eq!(state(&g, &r), DeviceState::Valid);

        // Everything the person needs after losing a and b.
        let c = DeviceKey::generate();
        g.append(&r, add(&c)).unwrap();
        g.append(&r, revoke(&a)).unwrap();
        g.append(&r, revoke(&b)).unwrap();
        assert_eq!(state(&g, &a), DeviceState::Revoked);
        assert_eq!(state(&g, &b), DeviceState::Revoked);
        assert_eq!(state(&g, &c), DeviceState::Valid);
        assert!(!g.is_recovery(&c.public()));
        assert_eq!(g.added_by(&c.public()), Some(r.public()));
    }

    #[test]
    fn recovery_device_can_be_revoked() {
        let (a, _, mut g) = pair();
        let r = DeviceKey::generate();
        g.append(&a, recovery(&r)).unwrap();
        g.append(&a, revoke(&r)).unwrap();
        assert_eq!(state(&g, &r), DeviceState::Revoked);
        assert_eq!(g.append(&r, add(&r)), Err(GraphError::NotValid));
        // A replacement key can be added after.
        let r2 = DeviceKey::generate();
        g.append(&a, recovery(&r2)).unwrap();
        assert!(g.is_recovery(&r2.public()));
    }

    #[test]
    fn recovery_flag_needs_a_counting_add() {
        let (a, b, g) = pair();
        let r = DeviceKey::generate();
        // The thief on b flags r on a stale head, then b is revoked.
        let mut thief = g.clone();
        thief.append(&b, recovery(&r)).unwrap();
        let mut owner = g;
        owner.append(&a, revoke(&b)).unwrap();
        owner.merge(&thief).unwrap();
        assert_eq!(state(&owner, &r), DeviceState::Unknown);
        assert!(!owner.is_recovery(&r.public()));
    }

    #[test]
    fn profile_follows_causal_order() {
        let (a, b, mut g) = pair();
        assert_eq!(g.profile(), None);
        g.append(&a, profile("one")).unwrap();
        assert_eq!(g.profile(), Some(&b"one"[..]));
        g.append(&b, profile("two")).unwrap();
        assert_eq!(g.profile(), Some(&b"two"[..]));
        g.append(&a, profile("three")).unwrap();
        assert_eq!(g.profile(), Some(&b"three"[..]));
        assert_eq!(
            PersonGraph::decode(&g.encode()).unwrap().profile(),
            g.profile()
        );
    }

    #[test]
    fn concurrent_profiles_break_ties_by_hash_in_any_merge_order() {
        let (a, b, base) = pair();
        let (mut left, mut right) = (base.clone(), base);
        let h1 = left.append(&a, profile("from a")).unwrap();
        let h2 = right.append(&b, profile("from b")).unwrap();
        let winner: &[u8] = if h1 > h2 { b"from a" } else { b"from b" };
        let mut lr = left.clone();
        lr.merge(&right).unwrap();
        let mut rl = right.clone();
        rl.merge(&left).unwrap();
        assert_eq!(lr.profile(), Some(winner));
        assert_eq!(rl.profile(), Some(winner));
        assert_eq!(lr, rl);

        // A later write that saw both settles it for good.
        lr.append(&a, profile("settled")).unwrap();
        assert_eq!(lr.profile(), Some(&b"settled"[..]));
    }

    #[test]
    fn profile_of_a_device_that_does_not_count_is_ignored() {
        let (a, b, mut g) = pair();
        g.append(&a, profile("real")).unwrap();

        let stranger = DeviceKey::generate();
        g.push_unchecked(Entry::sign(&stranger, g.heads(), profile("stranger")));
        assert_eq!(g.profile(), Some(&b"real"[..]));
        assert_eq!(g.append(&stranger, profile("x")), Err(GraphError::NotValid));

        // Written on a head that does not know b was revoked.
        let mut stale = g.clone();
        stale.append(&b, profile("thief")).unwrap();
        g.append(&a, revoke(&b)).unwrap();
        g.merge(&stale).unwrap();
        assert_eq!(g.profile(), Some(&b"real"[..]));

        // Written on top of the revoke, which `append` would refuse.
        g.push_unchecked(Entry::sign(&b, g.heads(), profile("later thief")));
        assert_eq!(g.profile(), Some(&b"real"[..]));
    }

    #[test]
    fn profile_of_a_device_added_on_a_stale_head_is_ignored() {
        let (a, b, g) = pair();
        let c = DeviceKey::generate();
        // The thief on b adds c without knowing about the revoke, and c,
        // which nobody ever revokes, renames the person.
        let mut thief = g.clone();
        thief.append(&b, add(&c)).unwrap();
        thief.append(&c, profile("thief")).unwrap();
        let mut owner = g;
        owner.append(&a, profile("real")).unwrap();
        owner.append(&a, revoke(&b)).unwrap();
        owner.merge(&thief).unwrap();
        assert_eq!(owner.profile(), Some(&b"real"[..]));
    }

    #[test]
    fn profile_written_before_the_revoke_stands() {
        let (a, b, mut g) = pair();
        g.append(&b, profile("kept")).unwrap();
        g.append(&a, revoke(&b)).unwrap();
        assert_eq!(g.profile(), Some(&b"kept"[..]));
    }

    #[test]
    fn recovery_device_has_no_profile() {
        let (a, _, mut g) = pair();
        let r = DeviceKey::generate();
        g.append(&a, recovery(&r)).unwrap();
        g.append(&a, profile("mine")).unwrap();
        assert_eq!(g.append(&r, profile("hers")), Err(GraphError::NotValid));
        g.push_unchecked(Entry::sign(&r, g.heads(), profile("hers")));
        assert_eq!(g.profile(), Some(&b"mine"[..]));
    }

    #[test]
    fn profile_is_capped() {
        let (a, _, mut g) = pair();
        let big = EntryKind::SetProfile {
            profile: vec![b'x'; crate::identity::MAX_PROFILE_LEN + 1],
        };
        let before = g.clone();
        assert_eq!(g.append(&a, big), Err(GraphError::TooLarge));
        assert_eq!(g, before);
        let fits = EntryKind::SetProfile {
            profile: vec![b'x'; crate::identity::MAX_PROFILE_LEN],
        };
        g.append(&a, fits).unwrap();

        // Profiles share the entry cap.
        let mut full = PersonGraph::genesis(&a);
        for _ in 1..MAX_GRAPH_ENTRIES {
            full.append(&a, profile("n")).unwrap();
        }
        assert_eq!(full.append(&a, profile("n")), Err(GraphError::TooLarge));
    }

    #[test]
    fn added_by_names_the_introducer() {
        let (a, b, mut g) = pair();
        let c = DeviceKey::generate();
        g.append(&b, add(&c)).unwrap();
        assert_eq!(g.added_by(&b.public()), Some(a.public()));
        assert_eq!(g.added_by(&c.public()), Some(b.public()));
        assert_eq!(g.added_by(&a.public()), None);
        assert_eq!(g.added_by(&DeviceKey::generate().public()), None);
        // Still answers once the introducer is revoked.
        g.append(&a, revoke(&b)).unwrap();
        assert_eq!(g.added_by(&c.public()), Some(b.public()));
    }

    #[test]
    fn added_by_ignores_adds_that_do_not_count() {
        let (a, b, g) = pair();
        let c = DeviceKey::generate();
        let mut thief = g.clone();
        thief.append(&b, add(&c)).unwrap();
        let mut owner = g;
        owner.append(&a, revoke(&b)).unwrap();
        owner.merge(&thief).unwrap();
        assert_eq!(owner.added_by(&c.public()), None);
    }

    #[test]
    fn vouch_adds_once_and_only_for_a_valid_signer() {
        let (a, b, mut g) = pair();
        let c = DeviceKey::generate();
        assert_eq!(g.vouch(&a, &c.public()), Ok(true));
        assert_eq!(state(&g, &c), DeviceState::Valid);
        let len = g.len();
        assert_eq!(g.vouch(&b, &c.public()), Ok(false));
        assert_eq!(g.len(), len);

        g.append(&a, revoke(&b)).unwrap();
        let d = DeviceKey::generate();
        assert_eq!(g.vouch(&b, &d.public()), Err(GraphError::NotValid));
        // Even with nothing to add: a revoked holder must hear it is one.
        assert_eq!(g.vouch(&b, &c.public()), Err(GraphError::NotValid));
        assert_eq!(g.vouch(&a, &b.public()), Err(GraphError::DeviceRevoked));
        assert_eq!(g.len(), len + 1);
    }
}
