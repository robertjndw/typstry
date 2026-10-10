//! Splitting outgoing updates into fragments and reassembling incoming ones.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use loro_protocol::{BatchId, CrdtType, ProtocolMessage, UpdateStatusCode, encode};

/// Same per-fragment payload the JS client uses, which leaves room for the
/// envelope under the protocol's 256 KiB message cap.
const FRAGMENT_LIMIT: usize = 240 * 1024;

/// Upper bound for one reassembled update.
pub const MAX_REASSEMBLED: usize = 8 * 1024 * 1024;

/// Batches a single connection may have in flight at once. Bounds memory a
/// misbehaving client can pin to `MAX_PENDING_BATCHES * MAX_REASSEMBLED`.
const MAX_PENDING_BATCHES: usize = 4;

/// Matches the timeout used by the JS client and reference server.
pub const FRAGMENT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn random_batch_id() -> BatchId {
    let mut id = [0u8; 8];
    getrandom::fill(&mut id).expect("OS random source unavailable");
    BatchId(id)
}

/// Encodes one update as a single `DocUpdate`, or as a header plus fragments
/// when it would not fit in one message.
pub fn encode_update(crdt: CrdtType, room_id: &str, update: &[u8]) -> Vec<Vec<u8>> {
    encode_batch(crdt, room_id, random_batch_id(), update)
}

/// [`encode_update`] under a batch id the caller picked, for senders that
/// match acks to what they sent.
pub fn encode_batch(
    crdt: CrdtType,
    room_id: &str,
    batch_id: BatchId,
    update: &[u8],
) -> Vec<Vec<u8>> {
    if update.len() <= FRAGMENT_LIMIT {
        let msg = ProtocolMessage::DocUpdate {
            crdt,
            room_id: room_id.to_owned(),
            updates: vec![update.to_vec()],
            batch_id,
        };
        return vec![encode(&msg).expect("update below the fragment limit fits")];
    }

    let chunks = update.chunks(FRAGMENT_LIMIT);
    let mut out = Vec::with_capacity(chunks.len() + 1);
    out.push(
        encode(&ProtocolMessage::DocUpdateFragmentHeader {
            crdt,
            room_id: room_id.to_owned(),
            batch_id,
            fragment_count: chunks.len() as u64,
            total_size_bytes: update.len() as u64,
        })
        .expect("header is small"),
    );
    for (index, chunk) in chunks.enumerate() {
        out.push(
            encode(&ProtocolMessage::DocUpdateFragment {
                crdt,
                room_id: room_id.to_owned(),
                batch_id,
                index: index as u64,
                fragment: chunk.to_vec(),
            })
            .expect("fragment below the limit fits"),
        );
    }
    out
}

/// Key of an in-flight batch: CRDT magic, room id and batch id.
pub type BatchKey = ([u8; 4], String, BatchId);

struct Pending {
    crdt: CrdtType,
    parts: Vec<Option<Vec<u8>>>,
    received: usize,
    bytes: usize,
    total: usize,
    started: Instant,
}

#[derive(Default)]
pub struct Reassembler {
    pending: HashMap<BatchKey, Pending>,
}

impl Reassembler {
    pub fn start(
        &mut self,
        crdt: CrdtType,
        room_id: &str,
        batch_id: BatchId,
        fragment_count: u64,
        total_size: u64,
    ) -> Result<(), UpdateStatusCode> {
        if total_size > MAX_REASSEMBLED as u64 {
            return Err(UpdateStatusCode::PayloadTooLarge);
        }
        // Every fragment carries at least one byte, which also caps the
        // allocation for the parts list.
        if fragment_count == 0 || fragment_count > total_size {
            return Err(UpdateStatusCode::InvalidUpdate);
        }
        let key = (crdt.magic_bytes(), room_id.to_owned(), batch_id);
        if !self.pending.contains_key(&key) && self.pending.len() >= MAX_PENDING_BATCHES {
            return Err(UpdateStatusCode::RateLimited);
        }
        self.pending.insert(
            key,
            Pending {
                crdt,
                parts: vec![None; fragment_count as usize],
                received: 0,
                bytes: 0,
                total: total_size as usize,
                started: Instant::now(),
            },
        );
        Ok(())
    }

    /// Adds a fragment; returns the full update once every part arrived.
    pub fn push(
        &mut self,
        crdt: CrdtType,
        room_id: &str,
        batch_id: BatchId,
        index: u64,
        fragment: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, UpdateStatusCode> {
        let key = (crdt.magic_bytes(), room_id.to_owned(), batch_id);
        let Some(batch) = self.pending.get_mut(&key) else {
            return Err(UpdateStatusCode::FragmentTimeout);
        };
        let Some(slot) = batch.parts.get_mut(index as usize) else {
            self.pending.remove(&key);
            return Err(UpdateStatusCode::InvalidUpdate);
        };
        if let Some(previous) = slot.replace(fragment) {
            batch.bytes -= previous.len();
        } else {
            batch.received += 1;
        }
        batch.bytes += slot.as_ref().map_or(0, Vec::len);
        if batch.bytes > batch.total {
            self.pending.remove(&key);
            return Err(UpdateStatusCode::InvalidUpdate);
        }
        if batch.received < batch.parts.len() {
            return Ok(None);
        }

        let batch = self.pending.remove(&key).expect("checked above");
        if batch.bytes != batch.total {
            return Err(UpdateStatusCode::InvalidUpdate);
        }
        let mut data = Vec::with_capacity(batch.total);
        for part in batch.parts.into_iter().flatten() {
            data.extend_from_slice(&part);
        }
        Ok(Some(data))
    }

    /// Drops batches older than [`FRAGMENT_TIMEOUT`] and returns them so the
    /// caller can send `FragmentTimeout` acks.
    pub fn expire(&mut self, now: Instant) -> Vec<(CrdtType, String, BatchId)> {
        let mut expired = Vec::new();
        self.pending.retain(|(_, room_id, batch_id), batch| {
            let keep = now.duration_since(batch.started) < FRAGMENT_TIMEOUT;
            if !keep {
                expired.push((batch.crdt, room_id.clone(), *batch_id));
            }
            keep
        });
        expired
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro_protocol::decode;

    fn reassemble(messages: &[Vec<u8>]) -> Vec<u8> {
        let mut r = Reassembler::default();
        let mut out = None;
        for raw in messages {
            match decode(raw).unwrap() {
                ProtocolMessage::DocUpdateFragmentHeader {
                    crdt,
                    room_id,
                    batch_id,
                    fragment_count,
                    total_size_bytes,
                } => r
                    .start(crdt, &room_id, batch_id, fragment_count, total_size_bytes)
                    .unwrap(),
                ProtocolMessage::DocUpdateFragment {
                    crdt,
                    room_id,
                    batch_id,
                    index,
                    fragment,
                } => out = r.push(crdt, &room_id, batch_id, index, fragment).unwrap(),
                other => panic!("unexpected {other:?}"),
            }
        }
        out.expect("complete")
    }

    #[test]
    fn small_update_is_a_single_message() {
        let msgs = encode_update(CrdtType::Elo, "room", b"abc");
        assert_eq!(msgs.len(), 1);
        assert!(matches!(
            decode(&msgs[0]).unwrap(),
            ProtocolMessage::DocUpdate { updates, .. } if updates == vec![b"abc".to_vec()]
        ));
    }

    #[test]
    fn large_update_round_trips_through_fragments() {
        let data: Vec<u8> = (0..600_000u32).map(|i| (i % 251) as u8).collect();
        let msgs = encode_update(CrdtType::Elo, "room", &data);
        assert_eq!(msgs.len(), 4);
        assert_eq!(reassemble(&msgs), data);
    }

    #[test]
    fn rejects_oversized_and_inconsistent_batches() {
        let mut r = Reassembler::default();
        let id = BatchId([1; 8]);
        assert_eq!(
            r.start(CrdtType::Elo, "x", id, 1, MAX_REASSEMBLED as u64 + 1),
            Err(UpdateStatusCode::PayloadTooLarge)
        );
        assert_eq!(
            r.start(CrdtType::Elo, "x", id, 10, 5),
            Err(UpdateStatusCode::InvalidUpdate)
        );
        r.start(CrdtType::Elo, "x", id, 2, 4).unwrap();
        assert_eq!(
            r.push(CrdtType::Elo, "x", id, 0, vec![0; 5]),
            Err(UpdateStatusCode::InvalidUpdate)
        );
        assert_eq!(
            r.push(CrdtType::Elo, "x", id, 0, vec![0; 1]),
            Err(UpdateStatusCode::FragmentTimeout)
        );
    }

    #[test]
    fn expires_stale_batches() {
        let mut r = Reassembler::default();
        r.start(CrdtType::Elo, "x", BatchId([2; 8]), 2, 4).unwrap();
        assert!(r.expire(Instant::now()).is_empty());
        let later = Instant::now() + FRAGMENT_TIMEOUT;
        assert_eq!(r.expire(later).len(), 1);
    }
}
