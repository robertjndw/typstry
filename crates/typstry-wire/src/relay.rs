//! Where the server relays the pairing of two devices, and the limits both
//! sides agree on. The relay forwards opaque binary frames between the two
//! peers of a channel, so nothing about the pairing protocol lives here.

/// `POST` here allocates a channel and answers with its number and lifetime.
pub const RELAY_API_PATH: &str = "/api/relay";

/// The relay socket, joined with `?channel=N`.
pub const RELAY_WS_PATH: &str = "/ws/relay";

/// Channels are numbered `1..=CHANNEL_MAX`. The number is part of the code a
/// person types, so it stays short.
pub const CHANNEL_MAX: u16 = 9999;

/// How long a channel lives after it was allocated, in seconds. Past that
/// the server drops it, whether or not anyone joined.
pub const CHANNEL_TTL_SECS: u64 = 5 * 60;

/// Upper bound for one frame. The grant carries a project list, which is
/// the biggest thing sent.
pub const MAX_RELAY_MESSAGE: usize = 64 * 1024;

/// The reasons the relay gives when it closes a socket. Clients match on
/// them to tell the person what went wrong, so they are part of the wire.
pub mod close_reason {
    /// The channel outlived [`super::CHANNEL_TTL_SECS`].
    pub const EXPIRED: &str = "expired";
    /// The join was refused. Unknown, expired and full channels look the
    /// same from outside.
    pub const NO_CHANNEL: &str = "no_channel";
    /// The peer sent frames faster than the server allows.
    pub const RATE_LIMITED: &str = "rate_limited";
    /// More was sent to a peer that has not joined yet than the server
    /// holds for it.
    pub const TOO_MANY_FRAMES: &str = "too_many_frames";
    /// The other peer closed its socket.
    pub const PEER_LEFT: &str = "peer_left";
}
