use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::actor::RoomActor;
use super::{ConnId, RoomCmd, RoomConfig};

const ROOM_QUEUE: usize = 256;

pub enum JoinOutcome {
    /// Joined; updates for the room go to this queue.
    Joined(mpsc::Sender<RoomCmd>),
    /// The room refused and already sent the client a JoinError.
    Refused,
    /// The room kept unloading under us, or the server is shutting down.
    Unavailable,
}

#[derive(Clone)]
pub struct RoomRegistry {
    inner: Arc<Inner>,
}

pub(super) struct Inner {
    pub(super) db: SqlitePool,
    pub(super) config: RoomConfig,
    /// Tells every actor to stop, for server shutdown.
    pub(super) stop: CancellationToken,
    rooms: Mutex<Rooms>,
    actors: TaskTracker,
    next_id: AtomicU64,
}

#[derive(Default)]
struct Rooms {
    map: HashMap<String, RoomEntry>,
    /// Set once shutdown starts. Checked under the same lock that spawns
    /// actors, so none can start after shutdown collected the running ones.
    closed: bool,
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
                stop: CancellationToken::new(),
                rooms: Mutex::new(Rooms::default()),
                actors: TaskTracker::new(),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn next_conn_id(&self) -> ConnId {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// The room's command queue, spawning (and loading) the actor if needed.
    /// The caller must already have checked that the project exists. None
    /// once shutdown has started.
    pub fn get(&self, project_id: &str) -> Option<mpsc::Sender<RoomCmd>> {
        let mut rooms = self.inner.rooms.lock().expect("room registry poisoned");
        if rooms.closed {
            return None;
        }
        if let Some(entry) = rooms.map.get(project_id)
            && !entry.tx.is_closed()
        {
            return Some(entry.tx.clone());
        }
        let generation = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(ROOM_QUEUE);
        rooms.map.insert(
            project_id.to_owned(),
            RoomEntry {
                tx: tx.clone(),
                generation,
            },
        );
        let actor = RoomActor::new(project_id.to_owned(), generation, self.inner.clone());
        self.inner.actors.spawn(actor.run(rx));
        Some(tx)
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
            let Some(room) = self.get(project_id) else {
                return JoinOutcome::Unavailable;
            };
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
            .map
            .get(project_id)
            .filter(|entry| !entry.tx.is_closed())
            .map(|entry| entry.tx.clone())
    }

    pub fn loaded_rooms(&self) -> usize {
        self.inner
            .rooms
            .lock()
            .expect("room registry poisoned")
            .map
            .len()
    }

    /// Stops every loaded room, all at once, and refuses to load new ones.
    /// Each room finishes the commands already queued for it first.
    pub async fn shutdown(&self) {
        self.inner
            .rooms
            .lock()
            .expect("room registry poisoned")
            .closed = true;
        self.inner.stop.cancel();
        self.inner.actors.close();
        self.inner.actors.wait().await;
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
        remove_generation(&mut rooms.map, project_id, generation);
        true
    }

    pub(super) fn remove(&self, project_id: &str, generation: u64) {
        let mut rooms = self.rooms.lock().expect("room registry poisoned");
        remove_generation(&mut rooms.map, project_id, generation);
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
