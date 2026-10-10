//! `%ELO` records and the per-room index built from their plaintext headers.
//!
//! Clients encrypt every change with a key the server never gets, so all it
//! can know about a record is what the header says: which peer's ops it
//! carries (delta span) or which version it is a full copy of (snapshot).
//! That is enough to backfill a rejoining client with only what it lacks
//! and to let a client-made snapshot replace the deltas it covers.

use std::collections::{HashMap, HashSet};

use loro::VersionVector;
use loro_protocol::{BytesReader, EloHeader, decode_elo_container, parse_elo_record_header};
#[cfg(test)]
use typstry_wire::elo::encode_container;
use typstry_wire::elo::parse_peer_id;

pub type PeerId = u64;

/// Per peer, an exclusive op counter: `{p: c}` means ops `[0, c)` of `p`.
pub type Version = HashMap<PeerId, u64>;

/// Loro op counters are i32, so a larger one cannot come from a real doc
/// and would not survive encoding the coverage as a Loro version vector.
const MAX_COUNTER: u64 = i32::MAX as u64;

/// Backfill containers stay below this so most go out as a single message
/// without fragmenting. A lone larger record still gets a container of its
/// own and is fragmented on the way out.
pub const CONTAINER_LIMIT: usize = 200 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    Delta { peer: PeerId, start: u64, end: u64 },
    Snapshot { vv: Version },
}

fn counter(value: u64) -> Result<u64, String> {
    if value > MAX_COUNTER {
        return Err(format!("counter {value} does not fit a Loro counter"));
    }
    Ok(value)
}

/// Reads the leading uleb128 count and checks it against the bytes left.
/// The library pre-allocates from that count, so a hostile one like 2^60
/// would abort the process before any bounds check runs.
fn plausible_count(reader: &mut BytesReader<'_>, min_entry_bytes: usize) -> Result<(), String> {
    let count = reader.read_uleb128()?;
    let room = (reader.remaining() / min_entry_bytes) as u64;
    if count > room {
        return Err(format!("count {count} exceeds the remaining bytes"));
    }
    Ok(())
}

pub fn parse_record(record: &[u8]) -> Result<Record, String> {
    if record.first() == Some(&0x01) {
        // Each vv entry is at least a one-byte length and a one-byte counter.
        plausible_count(&mut BytesReader::new(&record[1..]), 2)?;
    }
    match parse_elo_record_header(record)?.header {
        EloHeader::Delta(delta) => Ok(Record::Delta {
            peer: parse_peer_id(&delta.peer_id).ok_or("invalid delta peer id")?,
            start: counter(delta.start)?,
            end: counter(delta.end)?,
        }),
        EloHeader::Snapshot(snapshot) => {
            let mut vv = Version::with_capacity(snapshot.vv.len());
            for (peer, count) in snapshot.vv {
                let peer = parse_peer_id(&peer).ok_or("invalid snapshot peer id")?;
                if vv.insert(peer, counter(count)?).is_some() {
                    return Err("snapshot lists a peer twice".into());
                }
            }
            Ok(Record::Snapshot { vv })
        }
    }
}

/// Parses every record of one update payload. All or nothing: a single bad
/// record rejects the whole payload, so the room never stores half of it.
pub fn parse_container(payload: &[u8]) -> Result<Vec<(Record, &[u8])>, String> {
    // Every record is at least its one-byte length prefix.
    plausible_count(&mut BytesReader::new(payload), 1)?;
    let records = decode_elo_container(payload)?;
    if records.is_empty() {
        return Err("empty container".into());
    }
    records
        .into_iter()
        .map(|bytes| Ok((parse_record(bytes)?, bytes)))
        .collect()
}

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

#[derive(Debug)]
struct StoredSnapshot {
    seq: i64,
    vv: Version,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct StoredDelta {
    seq: i64,
    peer: PeerId,
    start: u64,
    end: u64,
    bytes: Vec<u8>,
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
}

impl DocIndex {
    /// Rebuilds the index from stored records in sequence order.
    pub fn load(records: Vec<(i64, Vec<u8>)>) -> Result<Self, String> {
        let mut index = Self::default();
        for (seq, bytes) in records {
            match parse_record(&bytes).map_err(|err| format!("record {seq}: {err}"))? {
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
            // Every counter was checked against MAX_COUNTER on the way in.
            vv.insert(peer, count as i32);
        }
        vv
    }

    /// True when every op of the span is already held, so storing it again
    /// would only grow the log.
    pub fn covers(&self, peer: PeerId, end: u64) -> bool {
        end <= get(&self.coverage, peer)
    }

    pub fn add_delta(&mut self, seq: i64, peer: PeerId, start: u64, end: u64, bytes: Vec<u8>) {
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
    pub fn install_snapshot(&mut self, seq: i64, vv: Version, bytes: Vec<u8>) {
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
            out.push(snapshot.bytes.as_slice());
        }
        out.extend(
            self.deltas
                .iter()
                .filter(|delta| delta.end > get(client, delta.peer))
                .map(|delta| delta.bytes.as_slice()),
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
    use loro_protocol::BytesWriter;

    use super::*;

    fn delta(peer: &[u8], start: u64, end: u64, ct: &[u8]) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(0x00);
        w.push_var_bytes(peer);
        w.push_uleb128(start);
        w.push_uleb128(end);
        w.push_var_string("k1");
        w.push_var_bytes(&[0; 12]);
        w.push_var_bytes(ct);
        w.finalize()
    }

    fn snapshot(vv: &[(&[u8], u64)]) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(0x01);
        w.push_uleb128(vv.len() as u64);
        for (peer, count) in vv {
            w.push_var_bytes(peer);
            w.push_uleb128(*count);
        }
        w.push_var_string("k1");
        w.push_var_bytes(&[0; 12]);
        w.push_var_bytes(b"ct");
        w.finalize()
    }

    fn version(pairs: &[(PeerId, u64)]) -> Version {
        pairs.iter().copied().collect()
    }

    #[test]
    fn parses_and_rejects_containers() {
        let d = delta(b"7", 0, 3, b"x");
        let s = snapshot(&[(b"7", 3)]);
        let container = encode_container(&[&d, &s]);
        let parsed = parse_container(&container).unwrap();
        assert_eq!(
            parsed[0],
            (
                Record::Delta {
                    peer: 7,
                    start: 0,
                    end: 3
                },
                d.as_slice()
            )
        );
        assert_eq!(
            parsed[1].0,
            Record::Snapshot {
                vv: version(&[(7, 3)])
            }
        );

        let too_big = MAX_COUNTER + 1;
        for bad in [
            encode_container(&[]),
            encode_container(&[&delta(b"07", 0, 1, b"x")]),
            encode_container(&[&delta(b"7", 0, too_big, b"x")]),
            encode_container(&[&snapshot(&[(b"7", too_big)])]),
            encode_container(&[&snapshot(&[(b"7", 1), (b"7", 2)])]),
            encode_container(&[&d, b"\x05garbage"]),
            b"\xff\xff\xff\xff\xff\xff\xff\xff\x0f".to_vec(),
            // A snapshot claiming 2^35 vv entries in zero bytes.
            b"\x01\x07\x01\x80\x80\x80\x80\x80\x01".to_vec(),
        ] {
            assert!(parse_container(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn coverage_waits_for_gaps_to_fill() {
        let mut index = DocIndex::default();
        index.add_delta(1, 1, 0, 5, vec![]);
        index.add_delta(2, 1, 10, 15, vec![]);
        assert_eq!(index.coverage(), &version(&[(1, 5)]));
        assert!(!index.covers(1, 15));
        index.add_delta(3, 1, 5, 10, vec![]);
        assert_eq!(index.coverage(), &version(&[(1, 15)]));
        assert!(index.gapped.is_empty());
    }

    #[test]
    fn snapshot_must_dominate_and_prune() {
        let mut index = DocIndex::default();
        index.add_delta(1, 1, 0, 5, vec![]);
        index.add_delta(2, 2, 0, 5, vec![]);
        assert_eq!(index.snapshot_replaces(&version(&[(1, 5)])), None);
        assert_eq!(
            index.snapshot_replaces(&version(&[(1, 5), (2, 4)])),
            None,
            "misses an op of peer 2"
        );
        let full = version(&[(1, 5), (2, 5)]);
        assert_eq!(index.snapshot_replaces(&full), Some(vec![1, 2]));
        index.install_snapshot(3, full.clone(), b"snap".to_vec());
        assert_eq!(index.delta_count(), 0);
        assert_eq!(index.coverage(), &full);

        // Nothing left to prune, so the same version again is pointless.
        assert_eq!(index.snapshot_replaces(&full), None);
        index.add_delta(4, 1, 5, 6, b"d".to_vec());
        assert_eq!(
            index.snapshot_replaces(&version(&[(1, 6), (2, 5)])),
            Some(vec![4, 3])
        );

        assert_eq!(index.backfill(&full), vec![&b"d"[..]]);
        assert_eq!(index.backfill(&Version::new()), vec![&b"snap"[..], b"d"]);
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
