//! The frames a joining doc client is sent, encoded once and shared.
//!
//! If every join encoded its own copy of what it lacked, N clients joining
//! with a version (and a hostile one can send any version) would pin N
//! copies of the doc in their queues. So the stored records are packed into
//! containers once, and a join is handed clones of the frames it needs,
//! which only bump reference counts.

use std::sync::Arc;

use axum::body::Bytes;
use loro_protocol::CrdtType;
use typstry_wire::elo::{PeerId, Version, encode_container, pack_ranges};

use super::elo::{CONTAINER_LIMIT, DocIndex, get};
use super::update_frames;

/// What one join may encode of its own, for chunks it needs only part of.
/// Past this, such chunks go out whole: the client already has the rest,
/// and importing known ops again changes nothing. Reconnecting clients
/// usually lack only the newest deltas, which fit easily, while a crafted
/// version can make every chunk partial and would otherwise get a fresh
/// copy of the doc per join again.
const COPY_BUDGET: usize = CONTAINER_LIMIT;

/// Deltas packed into one container, in log order.
struct Chunk {
    /// Index of its first delta in the index's delta list.
    start: usize,
    /// Record bytes it holds, to know whether more fit.
    size: usize,
    /// Peer, end and record of each delta in it.
    records: Vec<(PeerId, u64, Bytes)>,
    frames: Arc<[Bytes]>,
}

pub(super) struct BackfillCache {
    layout: u64,
    snapshot: Option<(Version, Arc<[Bytes]>)>,
    chunks: Vec<Chunk>,
    /// Deltas packed into `chunks` so far.
    packed: usize,
}

impl BackfillCache {
    /// Builds what is needed to serve every version of `index`.
    pub(super) fn new(index: &DocIndex, room_id: &str) -> Self {
        let snapshot = index.snapshot_record().map(|(vv, bytes)| {
            let container = encode_container(&[&bytes[..]]);
            (
                vv.clone(),
                update_frames(CrdtType::Elo, room_id, container).into(),
            )
        });
        let mut cache = Self {
            layout: index.layout(),
            snapshot,
            chunks: Vec::new(),
            packed: 0,
        };
        cache.extend(index, room_id);
        cache
    }

    /// Whether this cache still describes `index`, possibly missing deltas
    /// appended since, which [`Self::extend`] adds.
    pub(super) fn fits(&self, index: &DocIndex) -> bool {
        self.layout == index.layout() && self.packed <= index.delta_count()
    }

    /// Packs the deltas appended since the last call. The last chunk is
    /// packed again with them while it has room, so a doc edited between
    /// joins does not end up as many tiny containers. That chunk's old
    /// frames stay valid for whoever still holds them.
    pub(super) fn extend(&mut self, index: &DocIndex, room_id: &str) {
        if self.packed == index.delta_count() {
            return;
        }
        if let Some(last) = self.chunks.pop_if(|last| last.size < CONTAINER_LIMIT) {
            self.packed = last.start;
        }
        let fresh: Vec<(PeerId, u64, Bytes)> = index
            .deltas_from(self.packed)
            .map(|(peer, end, bytes)| (peer, end, bytes.clone()))
            .collect();
        let slices: Vec<&[u8]> = fresh.iter().map(|(_, _, bytes)| &bytes[..]).collect();
        for range in pack_ranges(&slices, CONTAINER_LIMIT) {
            let container = encode_container(&slices[range.clone()]);
            self.chunks.push(Chunk {
                start: self.packed + range.start,
                size: slices[range.clone()].iter().map(|s| s.len()).sum(),
                records: fresh[range].to_vec(),
                frames: update_frames(CrdtType::Elo, room_id, container).into(),
            });
        }
        self.packed = index.delta_count();
    }

    /// The frames a client at `client` needs, in the order it has to apply
    /// them: the snapshot unless it has all of it, then the deltas it
    /// lacks, oldest first. Whole chunks are shared; see [`COPY_BUDGET`]
    /// for the rest.
    pub(super) fn frames_for(&self, client: &Version, room_id: &str) -> Vec<Bytes> {
        let has = |peer: PeerId, end: u64| get(client, peer) >= end;
        let mut out = Vec::new();
        if let Some((vv, frames)) = &self.snapshot
            && !vv.iter().all(|(&peer, &count)| has(peer, count))
        {
            out.extend(frames.iter().cloned());
        }
        let mut budget = COPY_BUDGET;
        for chunk in &self.chunks {
            let missing: Vec<&[u8]> = chunk
                .records
                .iter()
                .filter(|&&(peer, end, _)| !has(peer, end))
                .map(|(_, _, bytes)| &bytes[..])
                .collect();
            let size: usize = missing.iter().map(|record| record.len()).sum();
            if missing.is_empty() {
                continue;
            }
            if missing.len() == chunk.records.len() || size > budget {
                out.extend(chunk.frames.iter().cloned());
            } else {
                budget -= size;
                let container = encode_container(&missing);
                out.extend(update_frames(CrdtType::Elo, room_id, container));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use loro_protocol::{ProtocolMessage, decode_elo_container, try_decode};

    use super::*;

    fn version(pairs: &[(PeerId, u64)]) -> Version {
        pairs.iter().copied().collect()
    }

    /// The records the frames carry, in order. Every test record is small,
    /// so each frame is one whole DocUpdate.
    fn records(frames: &[Bytes]) -> Vec<Vec<u8>> {
        frames
            .iter()
            .flat_map(|frame| match try_decode(frame).unwrap() {
                ProtocolMessage::DocUpdate { updates, .. } => updates,
                other => panic!("unexpected {other:?}"),
            })
            .flat_map(|container| {
                decode_elo_container(&container)
                    .unwrap()
                    .into_iter()
                    .map(|record| record.to_vec())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn delta(index: &mut DocIndex, seq: i64, peer: PeerId, start: u64, end: u64, len: usize) {
        let bytes = Bytes::from(vec![seq as u8; len]);
        index.add_delta(seq, peer, start, end, bytes);
    }

    #[test]
    fn serves_what_the_index_would_and_shares_the_frames() {
        let mut index = DocIndex::default();
        delta(&mut index, 1, 1, 0, 5, 10);
        delta(&mut index, 2, 2, 0, 3, 10);
        let snap = version(&[(1, 5), (2, 3)]);
        index.install_snapshot(3, snap.clone(), Bytes::from_static(b"snap"));
        delta(&mut index, 4, 1, 5, 6, 10);
        delta(&mut index, 5, 2, 3, 4, 10);

        let cache = BackfillCache::new(&index, "room");
        let all = cache.frames_for(&Version::new(), "room");
        let expected: Vec<Vec<u8>> = index
            .backfill(&Version::new())
            .into_iter()
            .map(<[u8]>::to_vec)
            .collect();
        assert_eq!(records(&all), expected);

        // Up to date with the snapshot: only the chunk of later deltas.
        let rest = cache.frames_for(&snap, "room");
        assert_eq!(records(&rest), vec![vec![4; 10], vec![5; 10]]);
        assert!(
            cache
                .frames_for(&version(&[(1, 6), (2, 4)]), "room")
                .is_empty()
        );

        // The same allocation, not a copy, for every join.
        let again = cache.frames_for(&Version::new(), "room");
        for (a, b) in all.iter().zip(&again) {
            assert_eq!(a.as_ptr(), b.as_ptr());
        }
    }

    #[test]
    fn extends_with_new_deltas_and_starts_over_after_a_snapshot() {
        let mut index = DocIndex::default();
        delta(&mut index, 1, 1, 0, 1, 10);
        let mut cache = BackfillCache::new(&index, "room");
        delta(&mut index, 2, 1, 1, 2, 10);
        assert!(cache.fits(&index));
        cache.extend(&index, "room");
        assert_eq!(cache.chunks.len(), 1, "the small last chunk is repacked");
        assert_eq!(records(&cache.frames_for(&Version::new(), "room")).len(), 2);

        index.install_snapshot(3, version(&[(1, 2)]), Bytes::from_static(b"s"));
        assert!(!cache.fits(&index));
    }

    #[test]
    fn chunks_stay_under_the_container_limit() {
        let mut index = DocIndex::default();
        // Three to a container, with room for their length prefixes.
        let len = CONTAINER_LIMIT / 3 - 8;
        for seq in 1..=7 {
            let peer = seq as u64;
            delta(&mut index, seq, peer, 0, 1, len);
        }
        let cache = BackfillCache::new(&index, "room");
        assert_eq!(cache.chunks.len(), 3);
        assert!(
            cache
                .chunks
                .iter()
                .all(|chunk| chunk.size <= CONTAINER_LIMIT)
        );
        let starts: HashSet<usize> = cache.chunks.iter().map(|chunk| chunk.start).collect();
        assert_eq!(starts, HashSet::from([0, 3, 6]));

        // A chunk needed in part is cut down to what is missing, as long
        // as the join's copy budget lasts; after that it goes out whole.
        let mut client: Version = (1..=7).map(|peer| (peer, 1)).collect();
        client.insert(5, 0);
        let frames = cache.frames_for(&client, "room");
        assert_eq!(records(&frames), vec![vec![5; len]]);

        let client: Version = [(2, 1), (5, 1)].into_iter().collect();
        let frames = cache.frames_for(&client, "room");
        // Chunk one: peers 1 and 3 cut out (2/3 of a budget's worth); chunk
        // two: 4 and 6 would overdraw it, so all three go; chunk three is
        // peer 7 alone.
        assert_eq!(records(&frames).len(), 2 + 3 + 1);
        assert_eq!(
            frames[1].as_ptr(),
            cache.chunks[1].frames[0].as_ptr(),
            "the second chunk is shared"
        );
    }
}
