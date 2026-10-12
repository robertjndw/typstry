//! Randomized checks of what a thief can and cannot do to a person graph.
//!
//! Every case is an honest graph `H` plus attacker entries `A`. Keys in a set
//! `C` are compromised; `A` holds entries signed by them or by devices `A`
//! itself introduced, on any parents the attacker likes, as long as the
//! graph takes them in (it refuses unauthorized ones). One honest device `p`
//! revokes every key of `C` in `H`, and no key of `C` stands above `p`. A
//! key's standing is whether `H` flags it as recovery. The invariants:
//!
//! - (I1) If every key of `C` stands below `p`, so `p` is a recovery device
//!   and the thief holds ordinary ones only, merging any `A` changes
//!   nothing: the valid devices and their recovery flags are those of `H`.
//! - (I2) If `C` is a single key of `p`'s standing, `A` can at most force a
//!   tie: that key and every device `A` introduced stay out, and of the
//!   devices valid in `H` only `p` can be lost, with the devices that came in
//!   only through adds `p` signed outside the past of the stolen key's
//!   introduction.
//! - (I2') With more keys in `C` and one of `p`'s standing, the tie with `p`
//!   voids `p`'s concurrent revokes of the others, so some may stay valid
//!   and sign whatever they like from then on. When none does, the losses
//!   are bounded like in (I2), only by every honest device that signed
//!   something outside the past of some key of `C`'s introduction instead
//!   of by `p` alone.
//! - (I3) The verdict is a function of the graph's shape alone: the same
//!   graph signed with other keys, whose hashes order the entries
//!   differently, gives the same verdict.
//!
//! All of them need `p`'s own standing to be out of the attacker's reach:
//! `p` is the genesis or was introduced and flagged before every key of `C`,
//! and no honest entry revokes `p`. A key of `C` introduced before `p` could
//! sign on a head that lacks `p`'s add and revoke its introducer there, which
//! the graph cannot tell from the owner doing the same to a thief, so that
//! is a tie at best; the unit tests in `graph` show it.
//!
//! The case count is small enough for every `cargo test`; set
//! `TYPSTRY_ADVERSARY_CASES` for a deeper run.

use std::collections::{BTreeMap, BTreeSet};

use super::entry::{Entry, EntryKind, FLAG_RECOVERY};
use super::validity::Validity;
use super::{DeviceKey, GraphError, Hash};
use crate::crypto::PublicKey;

/// A small deterministic generator, so a failing case can be replayed from
/// its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<T: Copy>(&mut self, from: &[T]) -> T {
        from[self.below(from.len())]
    }
}

/// An entry by key and entry indices, so one shape can be signed with
/// different keys.
#[derive(Debug, Clone)]
struct Shape {
    author: usize,
    parents: Vec<usize>,
    kind: Kind,
}

#[derive(Debug, Clone, Copy)]
enum Kind {
    Genesis,
    Add(usize, u8),
    Revoke(usize),
}

/// A shape signed with one set of keys.
struct Signed {
    keys: Vec<DeviceKey>,
    shapes: Vec<Shape>,
    hashes: Vec<Hash>,
    entries: BTreeMap<Hash, Entry>,
}

impl Signed {
    fn new(keys: Vec<DeviceKey>) -> Self {
        Self {
            keys,
            shapes: Vec::new(),
            hashes: Vec::new(),
            entries: BTreeMap::new(),
        }
    }

    fn public(&self, key: usize) -> PublicKey {
        self.keys[key].public()
    }

    fn entry(&self, shape: &Shape) -> Entry {
        let kind = match shape.kind {
            Kind::Genesis => EntryKind::Genesis,
            Kind::Add(device, flags) => EntryKind::AddDevice {
                device: self.public(device),
                flags,
            },
            Kind::Revoke(device) => EntryKind::RevokeDevice {
                device: self.public(device),
            },
        };
        let parents = shape.parents.iter().map(|&j| self.hashes[j]).collect();
        Entry::sign(&self.keys[shape.author], parents, kind)
    }

    /// Takes the entry in if the graph would, and says whether it did.
    fn push(&mut self, shape: Shape) -> bool {
        let entry = self.entry(&shape);
        let hash = entry.hash();
        if self.entries.contains_key(&hash) {
            return false;
        }
        let mut entries = self.entries.clone();
        entries.insert(hash, entry);
        match Validity::compute(&entries) {
            Ok(_) => {
                self.entries = entries;
                self.shapes.push(shape);
                self.hashes.push(hash);
                true
            }
            Err(GraphError::Unauthorized) => false,
            Err(e) => panic!("unexpected {e:?}"),
        }
    }

    /// The verdict over the first `len` entries, by key index.
    fn verdict(&self, len: usize) -> Verdict {
        let entries = self.hashes[..len]
            .iter()
            .map(|h| (*h, self.entries[h].clone()))
            .collect();
        let v = Validity::compute(&entries).expect("only authorized entries are kept");
        let index = |set: &BTreeSet<PublicKey>| -> BTreeSet<usize> {
            (0..self.keys.len())
                .filter(|&i| set.contains(&self.public(i)))
                .collect()
        };
        Verdict {
            valid: index(&v.valid),
            revoked: index(&v.revoked),
            recovery: index(&v.recovery),
        }
    }

    /// The entries `of` and their ancestors.
    fn closure(&self, of: &[usize]) -> BTreeSet<usize> {
        let mut closed: BTreeSet<usize> = BTreeSet::new();
        let mut todo = of.to_vec();
        while let Some(j) = todo.pop() {
            if closed.insert(j) {
                todo.extend(&self.shapes[j].parents);
            }
        }
        closed
    }

    /// Whether `key` is valid with just the entries `parents` and their
    /// ancestors, so an entry it signs on them is authorized.
    fn may_sign(&self, key: usize, parents: &[usize]) -> bool {
        let entries = self
            .closure(parents)
            .iter()
            .map(|&j| (self.hashes[j], self.entries[&self.hashes[j]].clone()))
            .collect();
        Validity::compute(&entries).is_ok_and(|v| v.valid.contains(&self.public(key)))
    }

    /// One line per entry, `index: author parents kind`, honest ones first.
    fn describe(&self, honest: usize) -> String {
        let mut out = String::new();
        for (j, shape) in self.shapes.iter().enumerate() {
            let kind = match shape.kind {
                Kind::Genesis => "genesis".to_string(),
                Kind::Add(d, 0) => format!("add {d}"),
                Kind::Add(d, _) => format!("add {d} as recovery"),
                Kind::Revoke(d) => format!("revoke {d}"),
            };
            let side = if j < honest { "" } else { "attacker " };
            out += &format!(
                "\n  {j}: {side}{} on {:?}: {kind}",
                shape.author, shape.parents
            );
        }
        out
    }

    fn heads(&self) -> Vec<usize> {
        let built_on: BTreeSet<usize> = self
            .shapes
            .iter()
            .flat_map(|s| s.parents.iter().copied())
            .collect();
        (0..self.shapes.len())
            .filter(|j| !built_on.contains(j))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Verdict {
    valid: BTreeSet<usize>,
    revoked: BTreeSet<usize>,
    recovery: BTreeSet<usize>,
}

fn keys(rng: &mut Rng, n: usize) -> Vec<DeviceKey> {
    (0..n)
        .map(|_| {
            let mut seed = [0u8; 32];
            for chunk in seed.chunks_mut(8) {
                chunk.copy_from_slice(&rng.next().to_le_bytes());
            }
            DeviceKey::import(&seed).unwrap()
        })
        .collect()
}

const KEYS: usize = 16;
/// The genesis key.
const G: usize = 0;

/// One case, or `None` when the dice built one whose preconditions fail.
struct Case {
    signed: Signed,
    honest: usize,
    revoker: usize,
    compromised: BTreeSet<usize>,
    /// Keys only attacker entries introduced.
    minted: BTreeSet<usize>,
}

impl Case {
    /// The honest entries a key of `C` could revoke the author of on a head
    /// that lacks them: those outside the past of some introduction of one.
    fn after_a_thief_joined(&self) -> BTreeSet<usize> {
        let s = &self.signed;
        let pasts: Vec<BTreeSet<usize>> = (0..self.honest)
            .filter(
                |&j| matches!(s.shapes[j].kind, Kind::Add(d, _) if self.compromised.contains(&d)),
            )
            .map(|i| s.closure(&[i]))
            .collect();
        (0..self.honest)
            .filter(|j| pasts.iter().any(|past| !past.contains(j)))
            .collect()
    }

    /// The honest devices a tie can take down: `authors`, and the devices
    /// that only came in through adds of theirs made after a thief joined, or
    /// through devices those brought in.
    fn exposed(&self, honest: &Verdict, authors: &BTreeSet<usize>) -> BTreeSet<usize> {
        let s = &self.signed;
        let entries = self.after_a_thief_joined();
        let mut safe: BTreeSet<usize> = [G].into();
        loop {
            let before = safe.len();
            for j in 0..self.honest {
                let shape = &s.shapes[j];
                let Kind::Add(d, _) = shape.kind else {
                    continue;
                };
                let exposed = authors.contains(&shape.author) && entries.contains(&j);
                if safe.contains(&shape.author) && !exposed {
                    safe.insert(d);
                }
            }
            if safe.len() == before {
                break;
            }
        }
        honest
            .valid
            .difference(&safe)
            .chain(authors)
            .copied()
            .collect()
    }
}

fn case(seed: u64) -> Option<Case> {
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let mut s = Signed::new(keys(&mut rng, KEYS));
    let mut fresh = 1..KEYS;
    s.push(Shape {
        author: G,
        parents: vec![],
        kind: Kind::Genesis,
    });

    // Before any compromise, on one line: the genesis adds a few devices,
    // some of them recovery keys, and any of these may become the revoker.
    let mut early = vec![G];
    let mut recovery_keys = Vec::new();
    for _ in 0..1 + rng.below(3) {
        let device = fresh.next().unwrap();
        let flags = if rng.chance(40) { FLAG_RECOVERY } else { 0 };
        if flags != 0 {
            recovery_keys.push(device);
        }
        let tip = s.shapes.len() - 1;
        assert!(s.push(Shape {
            author: G,
            parents: vec![tip],
            kind: Kind::Add(device, flags),
        }));
        early.push(device);
    }
    // A recovery key throwing out a thief is the case that matters most.
    let revoker = if !recovery_keys.is_empty() && rng.chance(60) {
        rng.pick(&recovery_keys)
    } else {
        rng.pick(&early)
    };
    let tip = s.shapes.len() - 1;

    // Honest life on top of that, forking and merging, before some of the
    // new devices are stolen. Nothing honest revokes the revoker, so its
    // standing is settled.
    let mut later: Vec<usize> = Vec::new();
    for _ in 0..rng.below(6) {
        let mut parents = vec![rng.pick(&s.heads())];
        if rng.chance(30) {
            parents.push(tip + rng.below(s.shapes.len() - tip));
        }
        let authors: Vec<usize> = (0..KEYS).filter(|&k| s.may_sign(k, &parents)).collect();
        if authors.is_empty() {
            continue;
        }
        let author = rng.pick(&authors);
        let kind = if rng.chance(70) || later.is_empty() {
            let Some(device) = fresh.next() else { break };
            later.push(device);
            Kind::Add(device, if rng.chance(20) { FLAG_RECOVERY } else { 0 })
        } else {
            let targets: Vec<usize> = early
                .iter()
                .chain(&later)
                .copied()
                .filter(|&d| d != revoker)
                .collect();
            Kind::Revoke(rng.pick(&targets))
        };
        s.push(Shape {
            author,
            parents,
            kind,
        });
    }
    let before = s.verdict(s.shapes.len());
    let tier = |d: usize| before.recovery.contains(&d);
    // Anything introduced after the revoker may be stolen.
    let after_revoker = early.iter().skip_while(|&&d| d != revoker).skip(1);
    let compromised: BTreeSet<usize> = after_revoker
        .chain(&later)
        .copied()
        .filter(|&d| before.valid.contains(&d) && tier(d) <= tier(revoker) && rng.chance(60))
        .collect();
    if compromised.is_empty() || !before.valid.contains(&revoker) {
        return None;
    }

    // The owner notices and has the revoker throw them all out.
    let stolen = s.shapes.len();
    for &c in &compromised {
        let heads = s.heads();
        if !s.push(Shape {
            author: revoker,
            parents: heads,
            kind: Kind::Revoke(c),
        }) {
            return None;
        }
    }

    // Honest devices go on, some of them before they hear of the revokes.
    for _ in 0..rng.below(3) {
        let parents = vec![tip + rng.below(s.shapes.len() - tip)];
        let authors: Vec<usize> = (0..KEYS)
            .filter(|k| !compromised.contains(k) && s.may_sign(*k, &parents))
            .collect();
        let Some(device) = fresh.next() else { break };
        if authors.is_empty() {
            continue;
        }
        s.push(Shape {
            author: rng.pick(&authors),
            parents,
            kind: Kind::Add(device, if rng.chance(20) { FLAG_RECOVERY } else { 0 }),
        });
    }
    let honest = s.shapes.len();

    // The attacker signs whatever it likes with whatever it holds, on heads
    // as old as it likes, including ones it built itself.
    let mut holds: Vec<usize> = compromised.iter().copied().collect();
    let mut minted = BTreeSet::new();
    for _ in 0..1 + rng.below(8) {
        // Mostly on heads from before the revokes, as a thief would.
        let range = if rng.chance(50) {
            stolen
        } else {
            s.shapes.len()
        };
        let mut parents = vec![rng.below(range)];
        if rng.chance(25) {
            parents.push(rng.below(s.shapes.len()));
        }
        let signers: Vec<usize> = holds
            .iter()
            .copied()
            .filter(|&k| s.may_sign(k, &parents))
            .collect();
        if signers.is_empty() {
            continue;
        }
        let author = rng.pick(&signers);
        // The revoker is the target that matters most, so aim at it often.
        let known: Vec<usize> = (0..s.keys.len()).filter(|&k| k != author).collect();
        let target = |rng: &mut Rng| {
            if rng.chance(50) {
                revoker
            } else {
                rng.pick(&known)
            }
        };
        let (kind, new) = match rng.below(5) {
            0 | 1 => match fresh.next() {
                Some(device) => {
                    let flags = if rng.chance(50) { FLAG_RECOVERY } else { 0 };
                    (Kind::Add(device, flags), Some(device))
                }
                None => (Kind::Revoke(target(&mut rng)), None),
            },
            // Flag itself or someone else as recovery.
            2 => {
                let device = if rng.chance(50) {
                    author
                } else {
                    rng.pick(&known)
                };
                (Kind::Add(device, FLAG_RECOVERY), None)
            }
            _ => (Kind::Revoke(target(&mut rng)), None),
        };
        if s.push(Shape {
            author,
            parents,
            kind,
        }) && let Some(device) = new
        {
            holds.push(device);
            minted.insert(device);
        }
    }
    Some(Case {
        signed: s,
        honest,
        revoker,
        compromised,
        minted,
    })
}

fn cases() -> u64 {
    std::env::var("TYPSTRY_ADVERSARY_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(600)
}

#[test]
fn a_thief_cannot_outlast_the_owners_revoke() {
    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    for seed in 0..cases() {
        let Some(case) = case(seed) else { continue };
        checked += 1;
        let s = &case.signed;
        let honest = s.verdict(case.honest);
        let merged = s.verdict(s.shapes.len());
        let mut fail = |what: String| {
            failures.push(format!(
                "seed {seed}: {what}\n  honest {honest:?}\n  merged {merged:?}{}",
                s.describe(case.honest)
            ))
        };
        let thieves: BTreeSet<usize> = case.compromised.union(&case.minted).copied().collect();
        let surviving: BTreeSet<usize> = merged.valid.intersection(&thieves).copied().collect();
        let lost: BTreeSet<usize> = honest.valid.difference(&merged.valid).copied().collect();
        let flags = |v: &Verdict| -> BTreeSet<usize> {
            v.recovery
                .iter()
                .filter(|d| merged.valid.contains(d) && honest.valid.contains(d))
                .copied()
                .collect()
        };
        if surviving.is_empty() && flags(&merged) != flags(&honest) {
            fail("the recovery flags of valid devices changed".into());
        }
        let tier = |d: &usize| honest.recovery.contains(d);
        let peer = case
            .compromised
            .iter()
            .any(|c| tier(c) == tier(&case.revoker));
        if !peer {
            // I1: a higher tier settles it for good.
            if merged.valid != honest.valid {
                fail(format!("I1: lost {lost:?}, thieves left {surviving:?}"));
            }
        } else if case.compromised.len() == 1 {
            // I2: a peer can tie with the revoker, which takes the revoker
            // and what it added since the peer joined, and that is all.
            let allowed = case.exposed(&honest, &[case.revoker].into());
            if !surviving.is_empty() || !lost.is_subset(&allowed) {
                fail(format!("I2: lost {lost:?}, thieves left {surviving:?}"));
            }
        } else if surviving.is_empty() {
            // I2': ties can chain, but only through honest devices that
            // signed something since a thief joined.
            let active = case
                .after_a_thief_joined()
                .iter()
                .map(|&j| s.shapes[j].author)
                .collect();
            if !lost.is_subset(&case.exposed(&honest, &active)) {
                fail(format!("I2 with several peers: lost {lost:?}"));
            }
        }
    }
    assert!(checked > cases() / 4, "only {checked} cases were usable");
    assert!(
        failures.is_empty(),
        "{} of {checked} cases fail, the first:\n{}",
        failures.len(),
        failures[..failures.len().min(3)].join("\n")
    );
}

#[test]
fn the_verdict_does_not_depend_on_the_hashes() {
    for seed in 0..cases() / 3 {
        let Some(case) = case(seed) else { continue };
        let s = &case.signed;
        let mut rng = Rng(seed ^ 0x5555_aaaa_5555_aaaa | 1);
        let mut other = Signed::new(keys(&mut rng, KEYS));
        for shape in &s.shapes {
            assert!(
                other.push(shape.clone()),
                "seed {seed}: refused on other keys"
            );
        }
        for len in [case.honest, s.shapes.len()] {
            assert_eq!(s.verdict(len), other.verdict(len), "seed {seed}");
        }
    }
}
