//! The per-room index built from `%ELO` record headers.
//!
//! Clients encrypt every change with a key the server never gets, so all it
//! can know about a record is what the header says: which peer's ops it
//! carries (delta span) or which version it is a full copy of (snapshot).
//! That is enough to backfill a rejoining client with only what it lacks
//! and to let a client-made snapshot replace the deltas it covers.

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use loro::VersionVector;
use typstry_wire::elo::{PeerId, Record, Version, parse_record};

/// Backfill containers stay below this so most go out as a single message
/// without fragmenting. A lone larger record still gets a container of its
/// own and is fragmented on the way out.
pub const CONTAINER_LIMIT: usize = 200 * 1024;

/// Groups records into as few containers as [`CONTAINER_LIMIT`] allows,
/// keeping their order.
pub fn pack(records: &[&[u8]]) -> Vec<Vec<u8>> {
    typstry_wire::elo::pack(records, CONTAINER_LIMIT)
}

/// A Loro version vector as sent in a JoinRequest. Counters are i32 there;
/// a negative one would be nonsense and simply counts as nothing.
pub fn from_vv(vv: &VersionVector) -> Version {
    vv.iter()
        .map(|(&peer, &count)| (peer, u64::try_from(count).unwrap_or(0)))
        .collect()
}

fn get(version: &Version, peer: PeerId) -> u64 {
    version.get(&peer).copied().unwrap_or(0)
}

#[derive(Debug, Clone)]
struct StoredSnapshot {
    seq: i64,
    vv: Version,
    bytes: Bytes,
}

#[derive(Debug, Clone)]
struct StoredDelta {
    seq: i64,
    peer: PeerId,
    start: u64,
    end: u64,
    bytes: Bytes,
}

/// A stored record whose header no longer parses, so the room cannot load.
#[derive(Debug, thiserror::Error)]
#[error("stored record {seq} is malformed: {reason}")]
pub struct LoadError {
    pub seq: i64,
    pub reason: String,
}

/// What [`DocIndex::rollback`] restores. Deltas are only ever appended
/// between snapshots, so until a snapshot lands, cutting the list back and
/// restoring the coverage maps is enough. A snapshot drops deltas, so the
/// first one staged saves the records it may need to put back.
#[derive(Debug)]
struct Journal {
    deltas: usize,
    coverage: Version,
    gapped: HashSet<PeerId>,
    before_snapshot: Option<(Option<StoredSnapshot>, Vec<StoredDelta>)>,
}

/// What the room holds for one project, mirroring the `doc_records` rows.
#[derive(Debug, Default)]
pub struct DocIndex {
    snapshot: Option<StoredSnapshot>,
    /// In sequence order, which is also the order backfill replays them in.
    deltas: Vec<StoredDelta>,
    /// Per peer, how far the server holds every op without a hole. Spans
    /// past a hole are stored but do not count until the hole is filled,
    /// because a client that trusted them would never ask for the hole.
    coverage: Version,
    /// Peers with at least one stored span beyond their coverage. Only
    /// these need a rescan when coverage grows, which keeps the common
    /// in-order case O(1).
    gapped: HashSet<PeerId>,
    journal: Option<Journal>,
}

impl DocIndex {
    /// Rebuilds the index from stored records in sequence order.
    pub fn load(records: Vec<(i64, Vec<u8>)>) -> Result<Self, LoadError> {
        let mut index = Self::default();
        for (seq, bytes) in records {
            let bytes = Bytes::from(bytes);
            let record = parse_record(&bytes).map_err(|reason| LoadError { seq, reason })?;
            match record {
                Record::Delta { peer, start, end } => index.deltas.push(StoredDelta {
                    seq,
                    peer,
                    start,
                    end,
                    bytes,
                }),
                // Replacing a snapshot deletes the old one in the same
                // transaction, so there is at most one; the newest wins
                // regardless.
                Record::Snapshot { vv } => {
                    index.snapshot = Some(StoredSnapshot { seq, vv, bytes });
                }
            }
        }
        index.recompute_all();
        Ok(index)
    }

    pub fn delta_count(&self) -> usize {
        self.deltas.len()
    }

    pub fn coverage(&self) -> &Version {
        &self.coverage
    }

    pub fn coverage_vv(&self) -> VersionVector {
        let mut vv = VersionVector::new();
        for (&peer, &count) in &self.coverage {
            // The parser checked every counter against MAX_COUNTER.
            vv.insert(peer, count as i32);
        }
        vv
    }

    /// True when every op of the span is already held, so storing it again
    /// would only grow the log.
    pub fn covers(&self, peer: PeerId, end: u64) -> bool {
        end <= get(&self.coverage, peer)
    }

    /// Starts staging changes the store has not committed yet. Until
    /// [`Self::commit`] or [`Self::rollback`], the index answers as if they
    /// were stored, so later records of the same batch are judged against
    /// earlier ones.
    pub fn begin(&mut self) {
        debug_assert!(self.journal.is_none(), "staging already in progress");
        self.journal = Some(Journal {
            deltas: self.deltas.len(),
            coverage: self.coverage.clone(),
            gapped: self.gapped.clone(),
            before_snapshot: None,
        });
    }

    /// Keeps everything staged since [`Self::begin`].
    pub fn commit(&mut self) {
        self.journal = None;
    }

    /// Undoes everything staged since [`Self::begin`].
    pub fn rollback(&mut self) {
        let Some(journal) = self.journal.take() else {
            return;
        };
        match journal.before_snapshot {
            Some((snapshot, deltas)) => {
                self.snapshot = snapshot;
                self.deltas = deltas;
            }
            None => self.deltas.truncate(journal.deltas),
        }
        self.coverage = journal.coverage;
        self.gapped = journal.gapped;
    }

    pub fn add_delta(&mut self, seq: i64, peer: PeerId, start: u64, end: u64, bytes: Bytes) {
        self.deltas.push(StoredDelta {
            seq,
            peer,
            start,
            end,
            bytes,
        });
        let covered = get(&self.coverage, peer);
        if start > covered {
            self.gapped.insert(peer);
            return;
        }
        if end > covered {
            self.coverage.insert(peer, end);
        }
        if self.gapped.contains(&peer) {
            self.recompute_peer(peer);
        }
    }

    /// The sequence numbers a snapshot at `vv` would make obsolete, or None
    /// when it should be ignored. It must hold everything the server can
    /// already serve, or replacing deltas with it would lose ops, and it
    /// must let at least one delta go, or it is just a copy of what is
    /// already stored.
    pub fn snapshot_replaces(&self, vv: &Version) -> Option<Vec<i64>> {
        if self
            .coverage
            .iter()
            .any(|(&peer, &count)| get(vv, peer) < count)
        {
            return None;
        }
        let mut obsolete: Vec<i64> = self
            .deltas
            .iter()
            .filter(|delta| delta.end <= get(vv, delta.peer))
            .map(|delta| delta.seq)
            .collect();
        match &self.snapshot {
            Some(_) if obsolete.is_empty() => None,
            Some(old) => {
                obsolete.push(old.seq);
                Some(obsolete)
            }
            None => Some(obsolete),
        }
    }

    /// Applies a snapshot that [`Self::snapshot_replaces`] accepted, after
    /// the store dropped the records it named.
    pub fn install_snapshot(&mut self, seq: i64, vv: Version, bytes: Bytes) {
        if let Some(journal) = &mut self.journal
            && journal.before_snapshot.is_none()
        {
            journal.before_snapshot = Some((
                self.snapshot.clone(),
                self.deltas[..journal.deltas].to_vec(),
            ));
        }
        self.deltas.retain(|delta| delta.end > get(&vv, delta.peer));
        self.snapshot = Some(StoredSnapshot { seq, vv, bytes });
        self.recompute_all();
    }

    /// The records a client at version `client` is missing, in the order it
    /// must apply them: the snapshot first, then deltas oldest first.
    pub fn backfill(&self, client: &Version) -> Vec<&[u8]> {
        let mut out = Vec::new();
        if let Some(snapshot) = &self.snapshot
            && !snapshot
                .vv
                .iter()
                .all(|(&peer, &count)| get(client, peer) >= count)
        {
            out.push(&snapshot.bytes[..]);
        }
        out.extend(
            self.deltas
                .iter()
                .filter(|delta| delta.end > get(client, delta.peer))
                .map(|delta| &delta.bytes[..]),
        );
        out
    }

    fn baseline(&self, peer: PeerId) -> u64 {
        self.snapshot
            .as_ref()
            .map_or(0, |snapshot| get(&snapshot.vv, peer))
    }

    fn recompute_peer(&mut self, peer: PeerId) {
        let mut spans: Vec<(u64, u64)> = self
            .deltas
            .iter()
            .filter(|delta| delta.peer == peer)
            .map(|delta| (delta.start, delta.end))
            .collect();
        self.set_coverage(peer, &mut spans);
    }

    fn recompute_all(&mut self) {
        let mut spans: HashMap<PeerId, Vec<(u64, u64)>> = HashMap::new();
        for delta in &self.deltas {
            spans
                .entry(delta.peer)
                .or_default()
                .push((delta.start, delta.end));
        }
        if let Some(snapshot) = &self.snapshot {
            for &peer in snapshot.vv.keys() {
                spans.entry(peer).or_default();
            }
        }
        self.coverage.clear();
        self.gapped.clear();
        for (peer, mut spans) in spans {
            self.set_coverage(peer, &mut spans);
        }
    }

    fn set_coverage(&mut self, peer: PeerId, spans: &mut [(u64, u64)]) {
        spans.sort_unstable();
        let mut covered = self.baseline(peer);
        let mut gap = false;
        for &(start, end) in spans.iter() {
            if start > covered {
                gap = true;
                break;
            }
            covered = covered.max(end);
        }
        // Zero entries would only bloat the version sent on every join.
        if covered > 0 {
            self.coverage.insert(peer, covered);
        } else {
            self.coverage.remove(&peer);
        }
        if gap {
            self.gapped.insert(peer);
        } else {
            self.gapped.remove(&peer);
        }
    }
}

#[cfg(test)]
mod tests {
    use loro_protocol::decode_elo_container;

    use super::*;

    fn version(pairs: &[(PeerId, u64)]) -> Version {
        pairs.iter().copied().collect()
    }

    #[test]
    fn coverage_waits_for_gaps_to_fill() {
        let mut index = DocIndex::default();
        index.add_delta(1, 1, 0, 5, Bytes::new());
        index.add_delta(2, 1, 10, 15, Bytes::new());
        assert_eq!(index.coverage(), &version(&[(1, 5)]));
        assert!(!index.covers(1, 15));
        index.add_delta(3, 1, 5, 10, Bytes::new());
        assert_eq!(index.coverage(), &version(&[(1, 15)]));
        assert!(index.gapped.is_empty());
    }

    #[test]
    fn snapshot_must_dominate_and_prune() {
        let mut index = DocIndex::default();
        index.add_delta(1, 1, 0, 5, Bytes::new());
        index.add_delta(2, 2, 0, 5, Bytes::new());
        assert_eq!(index.snapshot_replaces(&version(&[(1, 5)])), None);
        assert_eq!(
            index.snapshot_replaces(&version(&[(1, 5), (2, 4)])),
            None,
            "misses an op of peer 2"
        );
        let full = version(&[(1, 5), (2, 5)]);
        assert_eq!(index.snapshot_replaces(&full), Some(vec![1, 2]));
        index.install_snapshot(3, full.clone(), Bytes::from_static(b"snap"));
        assert_eq!(index.delta_count(), 0);
        assert_eq!(index.coverage(), &full);

        // Nothing left to prune, so the same version again is pointless.
        assert_eq!(index.snapshot_replaces(&full), None);
        index.add_delta(4, 1, 5, 6, Bytes::from_static(b"d"));
        assert_eq!(
            index.snapshot_replaces(&version(&[(1, 6), (2, 5)])),
            Some(vec![4, 3])
        );

        assert_eq!(index.backfill(&full), vec![&b"d"[..]]);
        assert_eq!(index.backfill(&Version::new()), vec![&b"snap"[..], b"d"]);
    }

    #[test]
    fn rollback_undoes_staged_deltas_and_snapshots() {
        let mut index = DocIndex::default();
        index.add_delta(1, 1, 0, 5, Bytes::from_static(b"a"));
        index.add_delta(2, 2, 3, 4, Bytes::from_static(b"gap"));

        index.begin();
        index.add_delta(3, 2, 0, 3, Bytes::from_static(b"fill"));
        assert_eq!(index.coverage(), &version(&[(1, 5), (2, 4)]));
        index.rollback();
        assert_eq!(index.coverage(), &version(&[(1, 5)]));
        assert!(index.gapped.contains(&2));
        assert_eq!(index.delta_count(), 2);

        index.begin();
        index.add_delta(3, 2, 0, 3, Bytes::from_static(b"fill"));
        let vv = version(&[(1, 5), (2, 4)]);
        assert_eq!(index.snapshot_replaces(&vv), Some(vec![1, 2, 3]));
        index.install_snapshot(4, vv, Bytes::from_static(b"snap"));
        index.add_delta(5, 1, 5, 6, Bytes::from_static(b"b"));
        index.rollback();
        assert_eq!(index.backfill(&Version::new()), vec![&b"a"[..], b"gap"]);
        assert_eq!(index.coverage(), &version(&[(1, 5)]));

        index.begin();
        index.add_delta(3, 1, 5, 6, Bytes::from_static(b"b"));
        index.commit();
        index.rollback();
        assert_eq!(index.delta_count(), 3);
    }

    #[test]
    fn load_names_the_bad_record() {
        let err = DocIndex::load(vec![(7, b"junk".to_vec())]).unwrap_err();
        assert_eq!(err.seq, 7);
    }

    #[test]
    fn packs_records_under_the_limit() {
        let small = vec![1u8; CONTAINER_LIMIT / 3];
        let huge = vec![2u8; CONTAINER_LIMIT * 2];
        let containers = pack(&[&small, &small, &huge, &small]);
        let sizes: Vec<usize> = containers
            .iter()
            .map(|c| decode_elo_container(c).unwrap().len())
            .collect();
        assert_eq!(sizes, [2, 1, 1]);
        assert!(pack(&[]).is_empty());
    }
}
