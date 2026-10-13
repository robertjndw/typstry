//! Which devices a graph counts as valid, as a pure function of its entries.
//!
//! The rules, with `past(E)` the strict ancestors of an entry `E`:
//!
//! - An entry is authorized if its author is valid in `past(E)`, and for a
//!   profile entry not a recovery device there. A graph with an entry that
//!   is not is refused: whether it is depends on `E` and its ancestors only,
//!   so every replica refuses the same entries whatever else it holds, and
//!   no outsider can pad a person's graph with entries of its own.
//! - A revoke by `X` counts only if `X` was introduced by the genesis or a
//!   counting add, and the revoke is an ancestor of every counting revoke of
//!   `X`, so a device that was revoked cannot reach back to a head before its
//!   revoke and take the person's other devices with it, nor have a device
//!   it added there do so. Two exceptions to which revokes of `X` void one
//!   by `X`:
//!   - Two devices of the same standing that revoke each other concurrently
//!     do not void each other's revoke, so both end up revoked: nobody can
//!     tell which of them was the thief. Their revokes of anyone else are
//!     voided as usual.
//!   - An ordinary device's revoke never voids a recovery device's. When the
//!     two revoke each other concurrently the recovery device wins, which is
//!     what lets a recovery key throw out stolen devices that keep signing.
//!
//!   A revoke stands as a recovery device's against another only if an add
//!   that counts in the pasts of both flagged its author. A flag the other
//!   side never saw is no standing against it, or a thief could flag itself,
//!   or a device of its own, on a stale head and meet the recovery key as its
//!   equal. So a recovery key outranks the devices introduced after its
//!   flag, while one introduced before can at most tie with it.
//!
//!   As this is circular, the counting revokes are the well-founded answer:
//!   those that count however the circle is cut, plus, of the ones that are
//!   left undecided, those on a cycle of undecided entries that void or
//!   introduce one another. Such a cycle is a contest like a mutual revoke,
//!   and everyone in it loses. One that merely depends on a cycle does not
//!   count, so a device whose standing is contested cannot take out a
//!   bystander.
//! - An add by `X` counts only if `X` itself was introduced by the genesis
//!   or a counting add, and the add is an ancestor of every counting revoke
//!   of `X`. Devices `X` added before it was revoked survive, while one added
//!   on a stale head, unaware of the revoke, does not.
//! - A device is valid if the genesis or a counting add introduced it and no
//!   counting revoke targets it. A revoke is final, so re-adding changes
//!   nothing.
//!
//! - A device that a counting add flags as recovery is a recovery device. It
//!   may author adds and revokes like any valid device, which is how a person
//!   recovers, but nothing else: its profile entries are not authorized, and
//!   the layers above never accept it as a leaf.
//! - A profile entry counts if its author is a valid, non-recovery device in
//!   its past whose own introduction counts, and it is an ancestor of every
//!   counting revoke of the author, like an add. The profile is the
//!   counting entry that no other counting entry builds on; among concurrent
//!   ones the greatest hash wins.
//!
//! - The genesis and every entry that is neither a revoke nor authored by
//!   a recovery device in its past are at most `MAX_GRAPH_ENTRIES -
//!   RESERVED_ENTRIES` entries and `MAX_GRAPH_BYTES - RESERVED_BYTES`
//!   encoded bytes together; a graph past either is refused as too large.
//!   The rest is kept for revokes and for a recovery key, so a device that
//!   fills the graph with profiles or adds leaves room for the revoke that
//!   throws it out. One that fills the reserve too still blocks it, with
//!   revokes or with adds signed by a recovery key it flagged itself: the
//!   caps cannot tell those from honest ones, as any valid device may flag
//!   a recovery key (see [`RESERVED_ENTRIES`]).
//!
//! The same rules judge `past(E)` and the whole graph, so every replica
//! reaches one verdict no matter in which order it learned the entries.

use std::collections::{BTreeMap, BTreeSet};

use super::entry::{Entry, EntryKind, FLAG_RECOVERY};
use super::{
    GraphError, Hash, MAX_GRAPH_BYTES, MAX_GRAPH_ENTRIES, RESERVED_BYTES, RESERVED_ENTRIES,
};
use crate::crypto::PublicKey;

// Ancestor sets are bitsets over the entries in topological order.
const _: () = assert!(MAX_GRAPH_ENTRIES <= u64::BITS as usize);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Validity {
    pub valid: BTreeSet<PublicKey>,
    pub revoked: BTreeSet<PublicKey>,
    pub recovery: BTreeSet<PublicKey>,
    pub added_by: BTreeMap<PublicKey, PublicKey>,
    /// Devices whose introduction counts, revoked ones included.
    pub introduced: BTreeSet<PublicKey>,
    pub profile: Option<Vec<u8>>,
}

impl Validity {
    /// Fails with [`GraphError::Unauthorized`] on an entry that is not
    /// authorized, and with [`GraphError::TooLarge`] when the entries other
    /// than revokes and those of recovery devices reach into the reserve
    /// (see [`RESERVED_ENTRIES`]).
    pub fn compute(entries: &BTreeMap<Hash, Entry>) -> Result<Self, GraphError> {
        if entries.len() > MAX_GRAPH_ENTRIES {
            return Err(GraphError::TooLarge);
        }
        let order = topological(entries)?;
        let index: BTreeMap<&Hash, usize> = order
            .iter()
            .enumerate()
            .map(|(i, (h, _))| (*h, i))
            .collect();
        let items: Vec<&Entry> = order.iter().map(|(_, e)| *e).collect();
        let hashes: Vec<&Hash> = order.iter().map(|(h, _)| *h).collect();

        let mut ancestors = vec![0u64; items.len()];
        let mut flagged_by = vec![0u64; items.len()];
        let mut counting_adds = vec![0u64; items.len()];
        let (mut ordinary, mut ordinary_bytes) = (0, 0);
        for (i, entry) in items.iter().enumerate() {
            for parent in &entry.parents {
                let j = index[parent];
                ancestors[i] |= ancestors[j] | 1 << j;
            }
            if entry.kind == EntryKind::Genesis {
                ordinary += 1;
                ordinary_bytes += entry.encode().len();
                continue;
            }
            // Every entry before this one in the order passed already, so
            // the frame only ever judges authorized entries.
            let (past, adds) = Frame {
                items: &items,
                hashes: &hashes,
                ancestors: &ancestors,
                flagged_by: &flagged_by,
                counting_adds: &counting_adds,
            }
            .state(ancestors[i]);
            let recovery = past.recovery.contains(&entry.author);
            if !past.valid.contains(&entry.author)
                || (recovery && matches!(entry.kind, EntryKind::SetProfile { .. }))
            {
                return Err(GraphError::Unauthorized);
            }
            if !recovery && !matches!(entry.kind, EntryKind::RevokeDevice { .. }) {
                ordinary += 1;
                ordinary_bytes += entry.encode().len();
            }
            counting_adds[i] = adds;
            flagged_by[i] = adds
                & (0..i)
                    .filter(|&j| match &items[j].kind {
                        EntryKind::AddDevice { device, flags } => {
                            *device == entry.author && flags & FLAG_RECOVERY != 0
                        }
                        _ => false,
                    })
                    .fold(0u64, |mask, j| mask | 1 << j);
        }
        if ordinary > MAX_GRAPH_ENTRIES - RESERVED_ENTRIES
            || ordinary_bytes > MAX_GRAPH_BYTES - RESERVED_BYTES
        {
            return Err(GraphError::TooLarge);
        }
        let all = if items.len() == u64::BITS as usize {
            u64::MAX
        } else {
            (1u64 << items.len()) - 1
        };
        let (validity, _) = Frame {
            items: &items,
            hashes: &hashes,
            ancestors: &ancestors,
            flagged_by: &flagged_by,
            counting_adds: &counting_adds,
        }
        .state(all);
        Ok(validity)
    }
}

struct Frame<'a> {
    items: &'a [&'a Entry],
    hashes: &'a [&'a Hash],
    ancestors: &'a [u64],
    /// The counting adds in the entry's past that flag its author as a
    /// recovery device.
    flagged_by: &'a [u64],
    /// The adds that count in the entry's past.
    counting_adds: &'a [u64],
}

impl Frame<'_> {
    fn members(&self, set: u64) -> impl Iterator<Item = usize> {
        (0..self.items.len()).filter(move |j| set >> j & 1 == 1)
    }

    fn is_ancestor(&self, j: usize, of: usize) -> bool {
        self.ancestors[of] >> j & 1 == 1
    }

    fn target(&self, revoke: usize) -> &PublicKey {
        match &self.items[revoke].kind {
            EntryKind::RevokeDevice { device } => device,
            _ => unreachable!("only revokes have a target"),
        }
    }

    /// Whether entry `x` stands as a recovery device's against `other`:
    /// an add that counts in the pasts of both made its author one.
    fn recovery_against(&self, x: usize, other: usize) -> bool {
        self.flagged_by[x] & self.counting_adds[other] != 0
    }

    /// The revokes in `revokes` that void entry `e` if they count: those of
    /// its author that `e` is not an ancestor of, less the two exceptions a
    /// revoke has.
    fn voiders(&self, revokes: u64, e: usize) -> u64 {
        let entry = self.items[e];
        self.members(revokes)
            .filter(|&s| *self.target(s) == entry.author && !self.is_ancestor(e, s))
            .filter(|&s| match &entry.kind {
                EntryKind::RevokeDevice { device } => {
                    let (ours, theirs) = (self.recovery_against(s, e), self.recovery_against(e, s));
                    let tie = ours == theirs
                        && *device == self.items[s].author
                        && !self.is_ancestor(s, e);
                    ours >= theirs && !tie
                }
                _ => true,
            })
            .fold(0, |mask, s| mask | 1 << s)
    }

    /// Of the revokes the fixpoint leaves undecided, those that count: the
    /// ones on a cycle of undecided entries that void or introduce one
    /// another. Such a cycle is a contest the graph cannot settle, like two
    /// devices revoking each other, and it is settled the same way, against
    /// everyone in it. A revoke that only hangs off a cycle, such as the
    /// thief's revoke of a bystander, does not count: the fixpoint left it
    /// undecided only because its author's own standing is contested.
    fn contested(
        &self,
        adds: u64,
        voiders: &[u64],
        sure: u64,
        possible: u64,
        introduced: &dyn Fn(u64) -> BTreeSet<PublicKey>,
    ) -> u64 {
        let (high, low) = (introduced(sure), introduced(possible));
        let undecided_adds = self
            .members(adds)
            .filter(|&j| {
                let author = &self.items[j].author;
                let maybe = voiders[j] & sure == 0 && high.contains(author);
                let surely = voiders[j] & possible == 0 && low.contains(author);
                maybe && !surely
            })
            .fold(0u64, |mask, j| mask | 1 << j);
        let undecided_revokes = possible & !sure;
        let undecided = undecided_adds | undecided_revokes;
        // What each undecided entry hangs on directly: the undecided revokes
        // that void it and the undecided adds of its author.
        let mut before: Vec<u64> = (0..self.items.len())
            .map(|e| {
                if undecided >> e & 1 == 0 {
                    return 0;
                }
                let author = &self.items[e].author;
                let introducers = self
                    .members(undecided_adds)
                    .filter(|&a| match &self.items[a].kind {
                        EntryKind::AddDevice { device, .. } => device == author,
                        _ => false,
                    })
                    .fold(0u64, |mask, a| mask | 1 << a);
                voiders[e] & undecided_revokes | introducers
            })
            .collect();
        // Close it transitively, so an entry hangs on itself exactly when it
        // is on a cycle.
        loop {
            let mut changed = false;
            for e in self.members(undecided) {
                let widened = self
                    .members(before[e])
                    .fold(before[e], |mask, d| mask | before[d]);
                if widened != before[e] {
                    before[e] = widened;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        self.members(undecided_revokes)
            .filter(|&r| before[r] >> r & 1 == 1)
            .fold(0u64, |mask, r| mask | 1 << r)
    }

    /// The verdict over the entries in `set`, which must be closed under
    /// ancestors and hold authorized entries only, and the adds that count.
    fn state(&self, set: u64) -> (Validity, u64) {
        let of_kind = |pick: fn(&EntryKind) -> bool| {
            self.members(set)
                .filter(|&j| pick(&self.items[j].kind))
                .fold(0u64, |mask, j| mask | 1 << j)
        };
        let revokes = of_kind(|k| matches!(k, EntryKind::RevokeDevice { .. }));
        let adds = of_kind(|k| matches!(k, EntryKind::AddDevice { .. }));
        let voiders: Vec<u64> = (0..self.items.len())
            .map(|j| {
                if set >> j & 1 == 1 {
                    self.voiders(revokes, j)
                } else {
                    0
                }
            })
            .collect();

        // The devices introduced when the revokes in `counting` count. An
        // add needs an author whose own introduction counts, or a device
        // that a revoked one added on a stale head could still add further
        // devices that would; so this grows from the genesis, and adds only
        // ever grow it, which makes the order free.
        let introduced = |counting: u64| {
            let mut introduced: BTreeSet<PublicKey> = self
                .members(set)
                .map(|j| self.items[j])
                .filter(|e| e.kind == EntryKind::Genesis)
                .map(|e| e.author)
                .collect();
            loop {
                let before = introduced.len();
                for j in self.members(adds) {
                    let entry = self.items[j];
                    if voiders[j] & counting == 0 && introduced.contains(&entry.author) {
                        let EntryKind::AddDevice { device, .. } = &entry.kind else {
                            unreachable!("adds are adds");
                        };
                        introduced.insert(*device);
                    }
                }
                if introduced.len() == before {
                    break introduced;
                }
            }
        };
        // The revokes that count when those in `counting` do. Like an add, a
        // revoke needs an author whose introduction counts, so a device the
        // thief added on a stale head cannot sign revokes in its place.
        let next = |counting: u64| {
            let introduced = introduced(counting);
            self.members(revokes)
                .filter(|&r| {
                    voiders[r] & counting == 0 && introduced.contains(&self.items[r].author)
                })
                .fold(0u64, |mask, r| mask | 1 << r)
        };
        // Which revokes count is circular, so take the well-founded answer
        // by alternating fixpoint: `sure` only grows and the revokes it
        // leaves possible only shrink, until neither moves. It is unique, so
        // no visiting order can change it.
        let mut sure = 0u64;
        let possible = loop {
            let possible = next(sure);
            let again = next(possible);
            if again == sure {
                break possible;
            }
            sure = again;
        };
        let counting = if possible == sure {
            sure
        } else {
            sure | self.contested(adds, &voiders, sure, possible, &introduced)
        };
        let introduced = introduced(counting);
        let counts =
            |j: usize| voiders[j] & counting == 0 && introduced.contains(&self.items[j].author);
        let counting_adds = self
            .members(adds)
            .filter(|&j| counts(j))
            .fold(0u64, |mask, j| mask | 1 << j);
        let surviving: Vec<(&PublicKey, &PublicKey, u8, &Hash)> = self
            .members(counting_adds)
            .map(|j| {
                let entry = self.items[j];
                let EntryKind::AddDevice { device, flags } = &entry.kind else {
                    unreachable!("adds are adds");
                };
                (&entry.author, device, *flags, self.hashes[j])
            })
            .collect();
        let revoked: BTreeSet<PublicKey> =
            self.members(counting).map(|r| *self.target(r)).collect();
        let valid = introduced.difference(&revoked).copied().collect();
        let recovery: BTreeSet<PublicKey> = surviving
            .iter()
            .filter(|(_, _, flags, _)| flags & FLAG_RECOVERY != 0)
            .map(|(_, device, ..)| **device)
            .collect();
        let mut added_by: BTreeMap<PublicKey, (&Hash, PublicKey)> = BTreeMap::new();
        for (author, device, _, hash) in &surviving {
            if added_by.get(*device).is_none_or(|(known, _)| hash < known) {
                added_by.insert(**device, (hash, **author));
            }
        }
        let added_by = added_by.into_iter().map(|(d, (_, a))| (d, a)).collect();

        let profiles: Vec<usize> = self
            .members(set)
            .filter(|&j| matches!(self.items[j].kind, EntryKind::SetProfile { .. }))
            .filter(|&j| counts(j) && !recovery.contains(&self.items[j].author))
            .collect();
        let profile = profiles
            .iter()
            .copied()
            .filter(|&j| profiles.iter().all(|&k| !self.is_ancestor(j, k)))
            .max_by_key(|&j| self.hashes[j])
            .map(|j| match &self.items[j].kind {
                EntryKind::SetProfile { profile } => profile.clone(),
                _ => unreachable!("profiles are profiles"),
            });
        let validity = Validity {
            valid,
            revoked,
            recovery,
            added_by,
            introduced,
            profile,
        };
        (validity, counting_adds)
    }
}

/// Parents before children, ties broken by hash. Refuses a parent that is
/// missing, and a cycle, which hashing makes impossible but a hand-built map
/// could still hold.
fn topological(entries: &BTreeMap<Hash, Entry>) -> Result<Vec<(&Hash, &Entry)>, GraphError> {
    if entries
        .values()
        .any(|e| e.parents.iter().any(|p| !entries.contains_key(p)))
    {
        return Err(GraphError::MissingParent);
    }
    let mut order: Vec<(&Hash, &Entry)> = Vec::with_capacity(entries.len());
    let mut placed: BTreeSet<&Hash> = BTreeSet::new();
    while order.len() < entries.len() {
        let next = entries
            .iter()
            .find(|(h, e)| !placed.contains(h) && e.parents.iter().all(|p| placed.contains(p)))
            .ok_or_else(|| GraphError::Malformed("person graph has a cycle".into()))?;
        placed.insert(next.0);
        order.push(next);
    }
    Ok(order)
}
