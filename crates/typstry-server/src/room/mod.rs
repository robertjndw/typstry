//! One actor per loaded project. The server cannot read project content:
//! the doc room holds encrypted `%ELO` records it indexes by their plaintext
//! headers, and the presence room relays opaque ciphertext blobs.

pub mod actor;
pub mod elo;
pub mod registry;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use loro_protocol::{BatchId, CrdtType, ProtocolMessage, encode};
use tokio::sync::{Notify, mpsc, oneshot};
use typstry_wire::fragment::encode_update;

use crate::store::projects::Permission;

pub use registry::{JoinOutcome, RoomRegistry};

pub type ConnId = u64;

/// Frames queued for a connection's writer task.
#[derive(Debug)]
pub enum Outbound {
    Binary(Bytes),
    Text(&'static str),
    Close(u16, &'static str),
}

impl Outbound {
    /// What the frame counts against the outbox byte budget. Text and close
    /// frames are a few static bytes; the frame cap covers those.
    fn cost(&self) -> usize {
        match self {
            Self::Binary(bytes) => bytes.len(),
            Self::Text(_) | Self::Close(..) => 0,
        }
    }
}

/// A connection's outbox as seen by rooms. Rooms never block on a slow
/// client: when the queue is full they fire `overflow` and drop the peer,
/// and the connection closes so the client resyncs on reconnect.
///
/// Full means either too many frames or too many bytes. Frames can be up to
/// 256 KiB, so a frame count alone would let one stalled client pin over
/// 100 MiB.
///
/// Join backfill bypasses both limits (see [`Self::push_backfill`]), so the
/// channel itself is unbounded and the limits are enforced on the counters.
#[derive(Debug, Clone)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<Queued>,
    overflow: Arc<Notify>,
    budget: Arc<Budget>,
    max_frames: usize,
    max_bytes: usize,
    max_backfills: usize,
}

/// What budgeted frames currently sit in the queue, and which joins have
/// backfill queued outside that budget.
#[derive(Debug, Default)]
struct Budget {
    frames: AtomicUsize,
    bytes: AtomicUsize,
    /// Every frame of a backfill holds a clone of its key, as does the
    /// join queueing it, so a key held only by this list has nothing
    /// left in the queue and is pruned.
    backfills: Mutex<Vec<Arc<BackfillKey>>>,
}

impl Budget {
    fn release(&self, cost: usize) {
        self.frames.fetch_sub(1, Ordering::AcqRel);
        self.bytes.fetch_sub(cost, Ordering::AcqRel);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct BackfillKey {
    room_id: String,
    crdt: [u8; 4],
}

/// A join's claim on queueing its backfill, from [`Outbox::start_backfill`].
#[derive(Debug)]
pub struct Backfill(Arc<BackfillKey>);

#[derive(Debug)]
enum Charge {
    Budget,
    /// Never read. Holding the key is the point, see `Budget::backfills`.
    Backfill {
        _key: Arc<BackfillKey>,
    },
}

#[derive(Debug)]
struct Queued {
    frame: Outbound,
    charge: Charge,
}

/// The writer task's end of an [`Outbox`].
#[derive(Debug)]
pub struct OutboxReceiver {
    rx: mpsc::UnboundedReceiver<Queued>,
    budget: Arc<Budget>,
}

impl Outbox {
    /// `max_backfills` caps how many joins can have backfill queued at
    /// once. A client that keeps reading never has more than its room limit.
    pub fn channel(
        max_frames: usize,
        max_bytes: usize,
        max_backfills: usize,
    ) -> (Self, OutboxReceiver) {
        let (tx, rx) = mpsc::unbounded_channel();
        let budget = Arc::new(Budget::default());
        let outbox = Self {
            tx,
            overflow: Arc::new(Notify::new()),
            budget: budget.clone(),
            max_frames,
            max_bytes,
            max_backfills,
        };
        (outbox, OutboxReceiver { rx, budget })
    }

    /// Fires once a push found the outbox full.
    pub fn overflow_signal(&self) -> Arc<Notify> {
        self.overflow.clone()
    }

    /// Returns false (and signals overflow) if the frame could not be queued.
    pub fn push(&self, frame: Outbound) -> bool {
        let cost = frame.cost();
        // Reserved before the check so rooms pushing concurrently cannot
        // overshoot the budget together. An empty queue takes any frame, so
        // a budget below the largest frame cannot wedge a connection.
        let frames = self.budget.frames.fetch_add(1, Ordering::AcqRel);
        let bytes = self.budget.bytes.fetch_add(cost, Ordering::AcqRel);
        if frames >= self.max_frames || (bytes > 0 && bytes + cost > self.max_bytes) {
            self.budget.release(cost);
            self.overflow.notify_one();
            return false;
        }
        if self
            .tx
            .send(Queued {
                frame,
                charge: Charge::Budget,
            })
            .is_err()
        {
            self.budget.release(cost);
            return false;
        }
        true
    }

    /// Queues a join's backfill outside the frame and byte limits; false
    /// only if the connection is gone.
    ///
    /// A join queues the whole doc at once, so with a budget a doc that grew
    /// past it could never be loaded again: every fresh client would
    /// overflow, reconnect and overflow again. The backfill is bounded by
    /// the doc itself, and live relays queued behind it still get the full
    /// budget on their own. [`Self::start_backfill`] bounds how many
    /// backfills a stalled client can hold.
    pub fn push_backfill(&self, backfill: &Backfill, frame: Bytes) -> bool {
        self.tx
            .send(Queued {
                frame: Outbound::Binary(frame),
                charge: Charge::Backfill {
                    _key: backfill.0.clone(),
                },
            })
            .is_ok()
    }

    /// Lets a join of `crdt` in `room_id` queue its backfill. A client that
    /// never reads could otherwise rejoin over and over and have the server
    /// queue a copy of the doc for every join, since backfill skips the
    /// budget. None, with overflow signalled, while an earlier backfill of
    /// the same room and CRDT is still queued, or `max_backfills` others
    /// are. Keyed by room so that switching projects on one socket is not
    /// held up by the previous project's backfill.
    pub fn start_backfill(&self, room_id: &str, crdt: CrdtType) -> Option<Backfill> {
        let key = BackfillKey {
            room_id: room_id.to_owned(),
            crdt: crdt.magic_bytes(),
        };
        let mut queued = self.budget.backfills.lock().expect("outbox poisoned");
        queued.retain(|other| Arc::strong_count(other) > 1);
        if queued.len() >= self.max_backfills || queued.iter().any(|other| **other == key) {
            drop(queued);
            self.overflow.notify_one();
            return None;
        }
        let key = Arc::new(key);
        queued.push(key.clone());
        Some(Backfill(key))
    }

    /// Encodes and queues a message; false if it could not be sent.
    pub fn push_message(&self, msg: &ProtocolMessage) -> bool {
        match encode(msg) {
            Ok(frame) => self.push(Outbound::Binary(frame.into())),
            Err(err) => {
                tracing::error!(%err, "failed to encode message");
                false
            }
        }
    }
}

impl OutboxReceiver {
    pub async fn recv(&mut self) -> Option<Outbound> {
        let Queued { frame, charge } = self.rx.recv().await?;
        if let Charge::Budget = charge {
            self.budget.release(frame.cost());
        }
        Some(frame)
    }
}

/// The frames that carry one update to a client.
pub(crate) fn update_frames(crdt: CrdtType, room_id: &str, update: Vec<u8>) -> Vec<Bytes> {
    encode_update(crdt, room_id, update)
        .into_iter()
        .map(Bytes::from)
        .collect()
}

#[derive(Debug)]
pub enum RoomCmd {
    Join {
        conn: ConnId,
        crdt: CrdtType,
        permission: Permission,
        version: Vec<u8>,
        outbox: Outbox,
        /// True when joined. False means the room already sent a JoinError.
        reply: oneshot::Sender<bool>,
    },
    Update {
        conn: ConnId,
        crdt: CrdtType,
        batch_id: BatchId,
        updates: Vec<Bytes>,
    },
    Leave {
        conn: ConnId,
        crdt: CrdtType,
    },
}

/// Cap on one presence blob. Real ones are a few hundred bytes of
/// encrypted cursor state; anything near this is not presence.
pub const MAX_PRESENCE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone)]
pub struct RoomConfig {
    /// Unload the room this long after the last peer left.
    pub unload_after: Duration,
    /// How often the actor checks for idle unloading and stale presence.
    pub tick: Duration,
    /// A connection's presence blob expires after this long without a
    /// refresh, so a client that froze without disconnecting fades out.
    pub ephemeral_timeout: Duration,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            unload_after: Duration::from_secs(60),
            tick: Duration::from_secs(5),
            ephemeral_timeout: Duration::from_secs(30),
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::FutureExt;

    use super::*;

    fn frame(len: usize) -> Outbound {
        Outbound::Binary(Bytes::from(vec![0; len]))
    }

    #[tokio::test]
    async fn outbox_overflows_on_bytes_before_frames() {
        let (outbox, mut rx) = Outbox::channel(16, 100, 8);
        let overflow = outbox.overflow_signal();
        assert!(outbox.push(frame(60)));
        assert!(!outbox.push(frame(60)), "120 bytes is over budget");
        assert!(overflow.notified().now_or_never().is_some());

        // Handing a frame to the writer frees its share of the budget.
        assert!(rx.recv().await.is_some());
        assert!(outbox.push(frame(60)));
        assert!(outbox.push(Outbound::Text("pong")));
    }

    #[test]
    fn outbox_overflows_on_frames() {
        let (outbox, _rx) = Outbox::channel(2, usize::MAX, 8);
        let overflow = outbox.overflow_signal();
        assert!(outbox.push(frame(1)));
        assert!(outbox.push(frame(1)));
        assert!(!outbox.push(frame(1)));
        assert!(overflow.notified().now_or_never().is_some());
        // The refused frame gave its share back.
        assert_eq!(outbox.budget.frames.load(Ordering::Acquire), 2);
        assert_eq!(outbox.budget.bytes.load(Ordering::Acquire), 2);
    }

    #[test]
    fn an_empty_outbox_takes_a_frame_over_budget() {
        let (outbox, _rx) = Outbox::channel(4, 10, 8);
        assert!(outbox.push(frame(50)));
        assert!(!outbox.push(frame(1)));
    }

    #[tokio::test]
    async fn backfill_ignores_the_limits_but_live_frames_behind_it_do_not() {
        let (outbox, mut rx) = Outbox::channel(2, 100, 8);
        let overflow = outbox.overflow_signal();
        let backfill = outbox.start_backfill("a", CrdtType::Elo).unwrap();
        for _ in 0..10 {
            assert!(outbox.push_backfill(&backfill, Bytes::from(vec![0; 60])));
        }
        assert!(overflow.notified().now_or_never().is_none());

        // Live frames get the whole budget on top of the backfill, no more.
        assert!(outbox.push(frame(60)));
        assert!(!outbox.push(frame(60)));
        assert!(overflow.notified().now_or_never().is_some());

        // Draining the backfill frees nothing; the live frame does.
        for _ in 0..10 {
            assert!(rx.recv().await.is_some());
        }
        assert!(!outbox.push(frame(60)));
        assert!(rx.recv().await.is_some());
        assert!(outbox.push(frame(60)));
    }

    /// Starts a backfill and queues one frame of it.
    fn queue_backfill(outbox: &Outbox, room_id: &str, crdt: CrdtType) -> bool {
        let Some(backfill) = outbox.start_backfill(room_id, crdt) else {
            return false;
        };
        outbox.push_backfill(&backfill, Bytes::from(vec![0; 60]))
    }

    #[tokio::test]
    async fn a_join_is_refused_while_its_room_has_backfill_queued() {
        let (outbox, mut rx) = Outbox::channel(16, 100, 8);
        let overflow = outbox.overflow_signal();
        assert!(queue_backfill(&outbox, "a", CrdtType::Elo));
        // Presence and other rooms have their own and are not held up.
        assert!(queue_backfill(&outbox, "a", CrdtType::LoroEphemeralStore));
        assert!(queue_backfill(&outbox, "b", CrdtType::Elo));
        assert!(overflow.notified().now_or_never().is_none());

        assert!(outbox.start_backfill("a", CrdtType::Elo).is_none());
        assert!(overflow.notified().now_or_never().is_some());
        assert!(rx.recv().await.is_some());
        assert!(queue_backfill(&outbox, "a", CrdtType::Elo));
    }

    #[tokio::test]
    async fn backfills_queued_at_once_are_capped() {
        let (outbox, mut rx) = Outbox::channel(16, 100, 2);
        let overflow = outbox.overflow_signal();
        assert!(queue_backfill(&outbox, "a", CrdtType::Elo));
        assert!(queue_backfill(&outbox, "b", CrdtType::Elo));
        assert!(outbox.start_backfill("c", CrdtType::Elo).is_none());
        assert!(overflow.notified().now_or_never().is_some());

        // A join whose backfill was empty, or failed, holds nothing.
        assert!(rx.recv().await.is_some());
        drop(outbox.start_backfill("c", CrdtType::Elo).unwrap());
        assert!(queue_backfill(&outbox, "d", CrdtType::Elo));
    }
}
