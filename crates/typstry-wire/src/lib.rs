//! What typstry clients and the sync server put on the wire: `%ELO` record
//! containers, update fragmentation and, behind the `crypto` feature, the
//! end-to-end encryption the browser client uses.
//!
//! Everything here must stay byte-compatible with the web client, which
//! speaks the same protocol through the npm `loro-protocol` package.

#[cfg(feature = "crypto")]
pub mod crypto;
pub mod elo;
pub mod fragment;
