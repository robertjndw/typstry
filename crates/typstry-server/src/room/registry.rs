use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};

use super::actor::RoomActor;
use super::{ConnId, RoomCmd, RoomConfig};

const ROOM_QUEUE: usize = 256;

pub enum JoinOutcome {
    /// Joined; updates for the room go to this queue.
    Joined(mpsc::Sender<RoomCmd>),
    /// The room refused and already sent the client a JoinError.
    Refused,
    /// The room kept unloading under us.
    Unavailable,
}

#[derive(Clone)]
pub struct RoomRegistry {
    inner: Arc<Inner>,
}

pub(super) struct Inner {
    pub(super) db: SqlitePool,
    pub(super) config: RoomConfig,
    rooms: Mutex<HashMap<String, RoomEntry>>,
    next_id: AtomicU64,
}

struct RoomEntry {
    tx: mpsc::Sender<RoomCmd>,
    generation: u64,
}

impl RoomRegistry {
    pub fn new(db: SqlitePool, config: RoomConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                config,
                rooms: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn next_conn_id(&self) -> ConnId {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// The room's command queue, spawning (and loading) the actor if needed.
    /// The caller must already have checked that the project exists.
    pub fn get(&self, project_id: &str) -> mpsc::Sender<RoomCmd> {
        let mut rooms = self.inner.rooms.lock().expect("room registry poisoned");
        if let Some(entry) = rooms.get(project_id)
            && !entry.tx.is_closed()
        {
            return entry.tx.clone();
        }
        let generation = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(ROOM_QUEUE);
        rooms.insert(
            project_id.to_owned(),
            RoomEntry {
                tx: tx.clone(),
                generation,
            },
        );
        let actor = RoomActor::new(project_id.to_owned(), generation, self.inner.clone());
        tokio::spawn(actor.run(rx));
        tx
    }

    /// Sends a join to the project's room and waits for its answer. A room
    /// can unload between handing out its queue and reading the join, so a
    /// dropped queue or reply is retried once against a fresh actor.
    /// `cmd` builds the join around the reply channel.
    pub async fn join(
        &self,
        project_id: &str,
        mut cmd: impl FnMut(oneshot::Sender<bool>) -> RoomCmd,
    ) -> JoinOutcome {
        for _ in 0..2 {
            let room = self.get(project_id);
            let (reply, joined) = oneshot::channel();
            if room.send(cmd(reply)).await.is_err() {
                continue;
            }
            match joined.await {
                Ok(true) => return JoinOutcome::Joined(room),
                Ok(false) => return JoinOutcome::Refused,
                Err(_) => continue,
            }
        }
        JoinOutcome::Unavailable
    }

    /// The room's queue if it is loaded right now; never spawns an actor.
    pub fn loaded(&self, project_id: &str) -> Option<mpsc::Sender<RoomCmd>> {
        let rooms = self.inner.rooms.lock().expect("room registry poisoned");
        rooms
            .get(project_id)
            .filter(|entry| !entry.tx.is_closed())
            .map(|entry| entry.tx.clone())
    }

    pub fn loaded_rooms(&self) -> usize {
        self.inner
            .rooms
            .lock()
            .expect("room registry poisoned")
            .len()
    }

    /// Stops every loaded room.
    pub async fn shutdown(&self) {
        let senders: Vec<_> = self
            .inner
            .rooms
            .lock()
            .expect("room registry poisoned")
            .values()
            .map(|entry| entry.tx.clone())
            .collect();
        for tx in senders {
            let (done, wait) = oneshot::channel();
            if tx.send(RoomCmd::Shutdown { done }).await.is_ok() {
                let _ = wait.await;
            }
        }
    }
}

impl Inner {
    /// Removes the room if this actor is still the registered one and nothing
    /// is queued for it. Holding the registry lock while checking the queue
    /// means no new sender can be handed out in between; a sender cloned
    /// earlier may still race in, but its oneshot reply is dropped with the
    /// queue and `RoomRegistry::join` retries against a fresh actor.
    pub(super) fn remove_if_idle(
        &self,
        project_id: &str,
        generation: u64,
        rx: &mpsc::Receiver<RoomCmd>,
    ) -> bool {
        let mut rooms = self.rooms.lock().expect("room registry poisoned");
        if !rx.is_empty() {
            return false;
        }
        remove_generation(&mut rooms, project_id, generation);
        true
    }

    pub(super) fn remove(&self, project_id: &str, generation: u64) {
        let mut rooms = self.rooms.lock().expect("room registry poisoned");
        remove_generation(&mut rooms, project_id, generation);
    }
}

/// A newer actor may already have replaced this one; only remove our own.
fn remove_generation(rooms: &mut HashMap<String, RoomEntry>, project_id: &str, generation: u64) {
    if rooms
        .get(project_id)
        .is_some_and(|entry| entry.generation == generation)
    {
        rooms.remove(project_id);
    }
}
