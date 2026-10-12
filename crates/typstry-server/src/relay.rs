//! Channels that pair two devices. The server only introduces the two
//! sockets and forwards their frames: what is said is sealed end to end.
//!
//! A channel is single use. It is allocated, joined by up to two peers, and
//! gone as soon as either of them leaves or its time is up. Nothing is
//! persisted, so a restart drops open channels.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use axum::body::Bytes;
use tokio::time::{Instant, MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;
use typstry_wire::relay::{CHANNEL_MAX, CHANNEL_TTL_SECS, close_reason};

use crate::room::{ConnId, Outbound, Outbox};
use crate::token;
use crate::ws::{CLOSE_NORMAL, CLOSE_POLICY};

/// Frames the first peer may send before the second one has joined. Only
/// the first message of the key exchange goes out right on connect; every
/// later one answers something from the peer, so it cannot exist before the
/// peer does. The rest is headroom.
const HELD_FRAMES: usize = 4;

/// Bytes across those frames. That first message is 35 bytes.
const HELD_BYTES: usize = 4 * 1024;

/// Bytes held across all channels, so what an idle crowd of first peers
/// pins does not grow with `max_channels`. Even every number with its
/// first message waiting needs about a third of this.
const HELD_BYTES_TOTAL: usize = 1024 * 1024;

/// How often expired channels are dropped in the background, so their
/// held frames and lone peers do not wait for the next allocation.
const SWEEP_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// How long a channel lives after it was allocated.
    pub ttl: Duration,
    /// Open channels across all callers. Nothing limits callers per
    /// address, so this is what keeps the numbers from being used up.
    pub max_channels: usize,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(CHANNEL_TTL_SECS),
            max_channels: 1000,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AllocateError {
    /// Every number is taken, or the cap on open channels is reached.
    Full,
}

#[derive(Debug, PartialEq, Eq)]
pub enum JoinError {
    /// Never allocated, expired, or already used up.
    Unknown,
    /// Two peers are already there.
    Taken,
}

struct Peer {
    id: ConnId,
    outbox: Outbox,
}

/// The seat of whoever allocated the channel, and of whoever enters its code.
const OWNER: usize = 0;
const GUEST: usize = 1;

struct Channel {
    deadline: Instant,
    /// Proves the holder allocated the channel. Only it opens the owner
    /// seat, so someone who guessed the number cannot take that seat and
    /// push the real owner into the guest's.
    claim: String,
    seats: [Option<Peer>; 2],
    /// Per recipient seat, what the other side sent before it arrived.
    held: [Vec<Bytes>; 2],
    held_bytes: [usize; 2],
}

impl Channel {
    /// Tells whoever is connected to go, then drops their outboxes so the
    /// writers can finish.
    fn close(self, code: u16, reason: &'static str) {
        for peer in self.seats.iter().flatten() {
            peer.outbox.push(Outbound::Close(code, reason));
        }
    }

    fn seat_of(&self, id: ConnId) -> Option<usize> {
        self.seats
            .iter()
            .position(|seat| seat.as_ref().is_some_and(|peer| peer.id == id))
    }
}

#[derive(Default)]
struct Channels {
    open: BTreeMap<u16, Channel>,
    /// Sum of `held_bytes` over every open channel.
    held_bytes: usize,
}

impl Channels {
    /// Every removal goes through here, so the total stays in step.
    fn remove(&mut self, number: u16) -> Option<Channel> {
        let ch = self.open.remove(&number)?;
        self.held_bytes -= ch.held_bytes.iter().sum::<usize>();
        Some(ch)
    }

    fn sweep(&mut self, now: Instant) {
        let expired: Vec<u16> = self
            .open
            .iter()
            .filter(|(_, ch)| ch.deadline <= now)
            .map(|(&n, _)| n)
            .collect();
        for number in expired {
            if let Some(ch) = self.remove(number) {
                ch.close(CLOSE_POLICY, close_reason::EXPIRED);
            }
        }
    }
}

#[derive(Clone)]
pub struct RelayRegistry {
    channels: Arc<Mutex<Channels>>,
    config: RelayConfig,
}

impl RelayRegistry {
    pub fn new(config: RelayConfig) -> Self {
        Self {
            channels: Arc::default(),
            config,
        }
    }

    pub fn ttl(&self) -> Duration {
        self.config.ttl
    }

    fn lock(&self) -> MutexGuard<'_, Channels> {
        lock(&self.channels)
    }

    /// Drops expired channels every [`SWEEP_EVERY`] until `shutdown` is
    /// cancelled or the registry is gone. A stale channel is refused on
    /// join and forward anyway; this only frees what it holds sooner and
    /// tells a peer still waiting on it.
    pub fn spawn_sweeper(&self, shutdown: CancellationToken) {
        // Weak, so a registry dropped without a shutdown (as in tests) does
        // not live on in its own sweeper.
        let channels = Arc::downgrade(&self.channels);
        tokio::spawn(sweep_until(channels, shutdown));
    }

    /// Drops every expired channel and tells its peers why.
    pub fn sweep(&self, now: Instant) {
        self.lock().sweep(now);
    }

    /// Opens the lowest free channel number and returns it with the claim
    /// for the owner seat. Expired channels are swept first so they never
    /// count against the cap.
    pub fn allocate(&self, now: Instant) -> Result<(u16, String), AllocateError> {
        let mut channels = self.lock();
        channels.sweep(now);
        if channels.open.len() >= self.config.max_channels {
            return Err(AllocateError::Full);
        }
        let mut free = 1;
        for &taken in channels.open.keys() {
            if taken != free {
                break;
            }
            free += 1;
        }
        if free > CHANNEL_MAX {
            return Err(AllocateError::Full);
        }
        let claim = token::generate();
        channels.open.insert(
            free,
            Channel {
                deadline: now + self.config.ttl,
                claim: claim.clone(),
                seats: [None, None],
                held: [Vec::new(), Vec::new()],
                held_bytes: [0, 0],
            },
        );
        Ok((free, claim))
    }

    /// Seats a connection: the owner seat for the right claim, the guest
    /// seat for no claim. Either one receives what the other side sent
    /// before it arrived, so the guest may well come first.
    pub fn join(
        &self,
        number: u16,
        claim: Option<&str>,
        id: ConnId,
        outbox: Outbox,
        now: Instant,
    ) -> Result<(), JoinError> {
        let mut channels = self.lock();
        let channels = &mut *channels;
        let Some(ch) = channels.open.get_mut(&number) else {
            return Err(JoinError::Unknown);
        };
        if ch.deadline <= now {
            if let Some(ch) = channels.remove(number) {
                ch.close(CLOSE_POLICY, close_reason::EXPIRED);
            }
            return Err(JoinError::Unknown);
        }
        let seat = match claim {
            // A bearer token as random as the space ids, so a plain
            // comparison leaks nothing worth timing.
            Some(given) if given == ch.claim => OWNER,
            Some(_) => return Err(JoinError::Unknown),
            None => GUEST,
        };
        if ch.seats[seat].is_some() {
            return Err(JoinError::Taken);
        }
        for frame in ch.held[seat].drain(..) {
            outbox.push(Outbound::Binary(frame));
        }
        channels.held_bytes -= std::mem::take(&mut ch.held_bytes[seat]);
        ch.seats[seat] = Some(Peer { id, outbox });
        Ok(())
    }

    /// Passes a frame to the other peer, or holds it until there is one.
    /// False means the channel is gone, or was just closed because the
    /// sender ran past its allowance; the sender stops either way.
    pub fn forward(&self, number: u16, from: ConnId, frame: Bytes, now: Instant) -> bool {
        let mut channels = self.lock();
        let channels = &mut *channels;
        let Some(ch) = channels.open.get_mut(&number) else {
            return false;
        };
        let Some(sender) = ch.seat_of(from) else {
            return false;
        };
        if ch.deadline <= now {
            if let Some(ch) = channels.remove(number) {
                ch.close(CLOSE_POLICY, close_reason::EXPIRED);
            }
            return false;
        }
        let to = 1 - sender;
        if let Some(other) = &ch.seats[to] {
            other.outbox.push(Outbound::Binary(frame));
            return true;
        }
        // Past the shared budget the sender gets the same answer as past
        // its own: whoever is filling it, this channel cannot be served.
        if ch.held[to].len() >= HELD_FRAMES
            || ch.held_bytes[to] + frame.len() > HELD_BYTES
            || channels.held_bytes + frame.len() > HELD_BYTES_TOTAL
        {
            if let Some(ch) = channels.remove(number) {
                ch.close(CLOSE_POLICY, close_reason::TOO_MANY_FRAMES);
            }
            return false;
        }
        ch.held_bytes[to] += frame.len();
        channels.held_bytes += frame.len();
        ch.held[to].push(frame);
        true
    }

    /// Ends the channel for good when one of its peers goes away, and tells
    /// the other. Does nothing for a connection that was never seated or
    /// whose channel was already closed, even if the number has been handed
    /// out again since.
    pub fn leave(&self, number: u16, id: ConnId) {
        let mut channels = self.lock();
        if channels
            .open
            .get(&number)
            .is_some_and(|ch| ch.seat_of(id).is_some())
            && let Some(ch) = channels.remove(number)
        {
            ch.close(CLOSE_NORMAL, close_reason::PEER_LEFT);
        }
    }

    pub fn open_channels(&self) -> usize {
        self.lock().open.len()
    }

    /// Bytes held for peers that have not joined yet, across all channels.
    pub fn held_bytes(&self) -> usize {
        self.lock().held_bytes
    }
}

fn lock(channels: &Mutex<Channels>) -> MutexGuard<'_, Channels> {
    // Nothing here panics while holding the lock, and the map stays
    // consistent either way.
    channels.lock().unwrap_or_else(|e| e.into_inner())
}

async fn sweep_until(channels: Weak<Mutex<Channels>>, shutdown: CancellationToken) {
    let mut tick = interval(SWEEP_EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            _ = tick.tick() => {
                let Some(channels) = channels.upgrade() else {
                    return;
                };
                lock(&channels).sweep(Instant::now());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(max_channels: usize) -> RelayRegistry {
        RelayRegistry::new(RelayConfig {
            ttl: Duration::from_secs(10),
            max_channels,
        })
    }

    fn outbox() -> Outbox {
        Outbox::channel(16, 1 << 20, 8).0
    }

    #[tokio::test(start_paused = true)]
    async fn allocates_the_lowest_free_number() {
        let relay = registry(100);
        let now = Instant::now();
        assert_eq!(relay.allocate(now).unwrap().0, 1);
        assert_eq!(relay.allocate(now).unwrap().0, 2);
        assert_eq!(relay.allocate(now).unwrap().0, 3);
        relay.join(2, None, 1, outbox(), now).unwrap();
        relay.leave(2, 1);
        assert_eq!(relay.allocate(now).unwrap().0, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_past_the_cap() {
        let relay = registry(2);
        let now = Instant::now();
        relay.allocate(now).unwrap();
        relay.allocate(now).unwrap();
        assert_eq!(relay.allocate(now), Err(AllocateError::Full));
    }

    #[tokio::test(start_paused = true)]
    async fn expired_channels_are_swept_on_allocate() {
        let relay = registry(1);
        let now = Instant::now();
        relay.allocate(now).unwrap();
        let later = now + Duration::from_secs(10);
        assert_eq!(relay.allocate(later).unwrap().0, 1);
        assert_eq!(relay.open_channels(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_held_budget_is_shared_across_channels() {
        let relay = registry(1000);
        let now = Instant::now();
        let full = HELD_BYTES_TOTAL / HELD_BYTES;
        for id in 0..full {
            let (number, claim) = relay.allocate(now).unwrap();
            relay
                .join(number, Some(&claim), id as ConnId, outbox(), now)
                .unwrap();
            let frame = Bytes::from(vec![0; HELD_BYTES]);
            assert!(relay.forward(number, id as ConnId, frame, now));
        }
        assert_eq!(relay.held_bytes(), HELD_BYTES_TOTAL);

        // Within its own allowance, but the shared one is used up.
        let (number, claim) = relay.allocate(now).unwrap();
        let late = full as ConnId;
        relay
            .join(number, Some(&claim), late, outbox(), now)
            .unwrap();
        assert!(!relay.forward(number, late, Bytes::from_static(b"hi"), now));
        assert_eq!(relay.open_channels(), full);

        // A guest arriving takes what was held for it off the total.
        relay.join(1, None, 9999, outbox(), now).unwrap();
        assert_eq!(relay.held_bytes(), HELD_BYTES_TOTAL - HELD_BYTES);
        relay.leave(2, 1);
        assert_eq!(relay.held_bytes(), HELD_BYTES_TOTAL - 2 * HELD_BYTES);
        relay.sweep(now + Duration::from_secs(10));
        assert_eq!(relay.open_channels(), 0);
        assert_eq!(relay.held_bytes(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_sweeper_drops_expired_channels_and_stops_on_shutdown() {
        let relay = registry(10);
        let shutdown = CancellationToken::new();
        relay.spawn_sweeper(shutdown.clone());
        let (number, claim) = relay.allocate(Instant::now()).unwrap();
        relay
            .join(number, Some(&claim), 1, outbox(), Instant::now())
            .unwrap();
        assert!(relay.forward(number, 1, Bytes::from_static(b"pake"), Instant::now()));

        tokio::time::sleep(Duration::from_secs(11)).await;
        assert_eq!(relay.open_channels(), 0);
        assert_eq!(relay.held_bytes(), 0);

        shutdown.cancel();
        tokio::task::yield_now().await;
        assert_eq!(Arc::weak_count(&relay.channels), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_sweeper_ends_with_its_registry() {
        let relay = registry(10);
        let channels = Arc::downgrade(&relay.channels);
        relay.spawn_sweeper(CancellationToken::new());
        drop(relay);
        tokio::time::sleep(SWEEP_EVERY * 2).await;
        assert_eq!(channels.weak_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn leave_ignores_a_stale_connection() {
        let relay = registry(10);
        let now = Instant::now();
        let (_, claim) = relay.allocate(now).unwrap();
        relay.join(1, Some(&claim), 7, outbox(), now).unwrap();
        relay.leave(1, 7);
        let (_, claim) = relay.allocate(now).unwrap();
        relay.join(1, Some(&claim), 8, outbox(), now).unwrap();
        relay.leave(1, 7);
        assert_eq!(relay.open_channels(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn only_the_claim_opens_the_owner_seat() {
        let relay = registry(10);
        let now = Instant::now();
        let (number, claim) = relay.allocate(now).unwrap();
        assert_eq!(
            relay.join(number, Some("wrong"), 1, outbox(), now),
            Err(JoinError::Unknown)
        );
        // A squatter without the claim lands in the guest seat and the
        // owner still gets in.
        relay.join(number, None, 2, outbox(), now).unwrap();
        relay.join(number, Some(&claim), 3, outbox(), now).unwrap();
        assert_eq!(
            relay.join(number, None, 4, outbox(), now),
            Err(JoinError::Taken)
        );
        assert_eq!(
            relay.join(number, Some(&claim), 5, outbox(), now),
            Err(JoinError::Taken)
        );
    }
}
