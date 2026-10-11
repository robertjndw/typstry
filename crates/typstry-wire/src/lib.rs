//! What typstry clients and the sync server put on the wire: `%ELO` record
//! containers, update fragmentation and, behind the `crypto` feature, the
//! end-to-end encryption the clients use and, behind `mls`, the MLS group
//! that authenticates and rotates it. `mls_frame` and `ds`, the delivery
//! service side of MLS, and `token` need no crypto, so the server uses them
//! too.
//!
//! Everything here must stay byte-compatible with the web client, which
//! speaks the same protocol through the npm `loro-protocol` package.

mod codec;
#[cfg(feature = "crypto")]
pub mod crypto;
pub mod ds;
pub mod elo;
pub mod fragment;
#[cfg(feature = "mls")]
pub mod mls;
pub mod mls_frame;
pub mod relay;
pub mod token;

/// Version of the HTTP and WebSocket contract between clients and the
/// server. Bump it when a client starts relying on a new endpoint or field,
/// or a response or message changes. Bumping alone locks nobody out, it
/// only lets the server tell old and new clients apart.
///
/// `apps/web/src/sync/protocol.ts` mirrors this, and its test parses this
/// line, so keep the format.
pub const PROTOCOL_VERSION: u32 = 1;

/// The oldest client the server still serves. Everyone below it is told to
/// upgrade or reload, so only raise it once older clients would corrupt
/// data or break in confusing ways.
pub const MIN_PROTOCOL_VERSION: u32 = 1;

/// Request header carrying the client's [`PROTOCOL_VERSION`].
pub const PROTOCOL_HEADER: &str = "x-typstry-protocol";

/// Query parameter carrying the client's [`PROTOCOL_VERSION`] on the
/// WebSocket URL, since browsers cannot set headers on a WebSocket.
pub const PROTOCOL_QUERY: &str = "protocol";

/// Whether the server still serves a client speaking `version`.
pub fn protocol_supported(version: u32) -> bool {
    version >= MIN_PROTOCOL_VERSION
}
