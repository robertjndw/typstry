//! Which devices a graph counts as valid, as a pure function of its entries.
//!
//! The rules, with `past(E)` the strict ancestors of an entry `E`:
//!
//! - An entry is authorized if its author is valid in `past(E)`. Unauthorized
//!   entries are kept, since they are part of the hashes, but do nothing.
//! - An authorized revoke is effective. Two devices that revoke each other
//!   concurrently are both authorized, so both end up revoked: nobody can
//!   tell which of them was the thief.
//! - An authorized add by `X` counts only if `X` itself was introduced by
//!   the genesis or a counting add, and the add is an ancestor of every
//!   effective revoke of `X`. Devices `X` added before it was revoked
//!   survive, while one added on a stale head, unaware of the revoke, does
//!   not.
//! - A device is valid if the genesis or a counting add introduced it and no
//!   effective revoke targets it. A revoke is final, so re-adding changes
//!   nothing.
//!
//! - A device that a counting add flags as recovery is a recovery device. It
//!   may author adds and revokes like any valid device, which is how a person
//!   recovers, but nothing else: its profile entries are not authorized, and
//!   the layers above never accept it as a leaf.
//! - A profile entry counts if its author is a valid, non-recovery device in
//!   its past whose own introduction counts, and it is an ancestor of every
//!   effective revoke of the author, like an add. The profile is the
//!   counting entry that no other counting entry builds on; among concurrent
//!   ones the greatest hash wins.
//!
//! The same rules judge `past(E)` and the whole graph, so every replica
//! reaches one verdict no matter in which order it learned the entries.

use std::collections::{BTreeMap, BTreeSet};

use super::entry::{Entry, EntryKind, FLAG_RECOVERY};
use super::{GraphError, Hash, MAX_GRAPH_ENTRIES};
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
    /// Only set on the verdict over the whole graph.
    pub profile: Option<Vec<u8>>,
}

impl Validity {
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
        let mut authorized = vec![false; items.len()];
        for (i, entry) in items.iter().enumerate() {
            for parent in &entry.parents {
                let j = index[parent];
                ancestors[i] |= ancestors[j] | 1 << j;
            }
            authorized[i] = match entry.kind {
                EntryKind::Genesis => true,
                _ => {
                    let past = Frame {
                        items: &items,
                        hashes: &hashes,
                        ancestors: &ancestors,
                        authorized: &authorized,
                    }
                    .state(ancestors[i]);
                    past.valid.contains(&entry.author)
                        && (!matches!(entry.kind, EntryKind::SetProfile { .. })
                            || !past.recovery.contains(&entry.author))
                }
            };
        }
        let all = if items.len() == u64::BITS as usize {
            u64::MAX
        } else {
            (1u64 << items.len()) - 1
        };
        let frame = Frame {
            items: &items,
            hashes: &hashes,
            ancestors: &ancestors,
            authorized: &authorized,
        };
        let mut verdict = frame.state(all);
        let winner = frame.profile(all, &verdict);
        verdict.profile = winner.map(|j| match &items[j].kind {
            EntryKind::SetProfile { profile } => profile.clone(),
            _ => unreachable!("profile only picks profile entries"),
        });
        Ok(verdict)
    }
}

struct Frame<'a> {
    items: &'a [&'a Entry],
    hashes: &'a [&'a Hash],
    ancestors: &'a [u64],
    authorized: &'a [bool],
}

impl Frame<'_> {
    /// The verdict over the entries in `set`, which must be closed under
    /// ancestors and whose members are already authorized or not.
    fn state(&self, set: u64) -> Validity {
        let members = || (0..self.items.len()).filter(|j| set >> j & 1 == 1);
        let revokes: Vec<(usize, &PublicKey)> = members()
            .filter(|&j| self.authorized[j])
            .filter_map(|j| match &self.items[j].kind {
                EntryKind::RevokeDevice { device } => Some((j, device)),
                _ => None,
            })
            .collect();
        let mut introduced: BTreeSet<PublicKey> = members()
            .map(|j| self.items[j])
            .filter(|e| matches!(e.kind, EntryKind::Genesis))
            .map(|e| e.author)
            .collect();
        let adds: Vec<(&PublicKey, &PublicKey, u8, &Hash)> = members()
            .filter(|&j| self.authorized[j])
            .filter_map(|j| {
                let entry = self.items[j];
                let EntryKind::AddDevice { device, flags } = &entry.kind else {
                    return None;
                };
                let survives = revokes
                    .iter()
                    .filter(|(_, target)| **target == entry.author)
                    .all(|(r, _)| self.ancestors[*r] >> j & 1 == 1);
                survives.then_some((&entry.author, device, *flags, self.hashes[j]))
            })
            .collect();
        // An add also needs an author whose own introduction counts.
        // Otherwise a device that a revoked one added on a stale head, which
        // does not count, could still add further devices that would. Adds
        // only ever grow the set, so iterating to a fixpoint is order free.
        loop {
            let before = introduced.len();
            for (author, device, ..) in &adds {
                if introduced.contains(*author) {
                    introduced.insert(**device);
                }
            }
            if introduced.len() == before {
                break;
            }
        }
        let revoked: BTreeSet<PublicKey> = revokes.iter().map(|(_, d)| **d).collect();
        let valid = introduced.difference(&revoked).copied().collect();
        let recovery = adds
            .iter()
            .filter(|(author, _, flags, _)| {
                flags & FLAG_RECOVERY != 0 && introduced.contains(*author)
            })
            .map(|(_, device, ..)| **device)
            .collect();
        let mut added_by: BTreeMap<PublicKey, (&Hash, PublicKey)> = BTreeMap::new();
        for (author, device, _, hash) in &adds {
            if introduced.contains(*author)
                && added_by.get(*device).is_none_or(|(known, _)| hash < known)
            {
                added_by.insert(**device, (hash, **author));
            }
        }
        let added_by = added_by.into_iter().map(|(d, (_, a))| (d, a)).collect();
        Validity {
            valid,
            revoked,
            recovery,
            added_by,
            introduced,
            profile: None,
        }
    }

    /// The index of the entry whose profile stands in `set`, if any.
    fn profile(&self, set: u64, verdict: &Validity) -> Option<usize> {
        let members = || (0..self.items.len()).filter(|j| set >> j & 1 == 1);
        let revokes: Vec<(usize, &PublicKey)> = members()
            .filter(|&j| self.authorized[j])
            .filter_map(|j| match &self.items[j].kind {
                EntryKind::RevokeDevice { device } => Some((j, device)),
                _ => None,
            })
            .collect();
        let counting: Vec<usize> = members()
            .filter(|&j| self.authorized[j])
            .filter(|&j| {
                let entry = self.items[j];
                matches!(entry.kind, EntryKind::SetProfile { .. })
                    && verdict.introduced.contains(&entry.author)
                    && !verdict.recovery.contains(&entry.author)
                    && revokes
                        .iter()
                        .filter(|(_, target)| **target == entry.author)
                        .all(|(r, _)| self.ancestors[*r] >> j & 1 == 1)
            })
            .collect();
        counting
            .iter()
            .copied()
            .filter(|&j| counting.iter().all(|&k| self.ancestors[k] >> j & 1 == 0))
            .max_by_key(|&j| self.hashes[j])
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
