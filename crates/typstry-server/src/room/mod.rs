//! One actor per loaded project. The server cannot read project content:
//! the doc room holds encrypted `%ELO` records it indexes by their plaintext
//! headers, and the presence room relays opaque ciphertext blobs.

pub mod actor;
pub mod elo;
pub mod registry;

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use loro_protocol::{BatchId, CrdtType, ProtocolMessage, encode};
use tokio::sync::{Notify, mpsc, oneshot};

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

/// A connection's outbox as seen by rooms. Rooms never block on a slow
/// client: when the queue is full they fire `overflow` and drop the peer,
/// and the connection closes so the client resyncs on reconnect.
#[derive(Debug, Clone)]
pub struct Outbox {
    pub tx: mpsc::Sender<Outbound>,
    pub overflow: Arc<Notify>,
}

impl Outbox {
    /// Returns false (and signals overflow) if the frame could not be queued.
    pub fn push(&self, frame: Outbound) -> bool {
        match self.tx.try_send(frame) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflow.notify_one();
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
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
        updates: Vec<Vec<u8>>,
    },
    Leave {
        conn: ConnId,
        crdt: CrdtType,
    },
    /// Stop; used on server shutdown. Every record is already durable, so
    /// there is nothing to flush.
    Shutdown {
        done: oneshot::Sender<()>,
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
