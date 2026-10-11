//! typstry-wire's encryption and MLS group for the browser.
//!
//! The web app runs the same Rust as the CLI, so there is one
//! implementation of the crypto, behind a synchronous API. Persistence,
//! locking and the sockets stay in TypeScript; nothing here does I/O.
//!
//! Failures reach JavaScript as `Error`s with a stable `kind` string (see
//! [`error`]), so callers branch on that and never on the message.

// openmls_rust_crypto still depends on getrandom 0.2. Naming the crate here
// keeps its `js` feature from being pruned from the build.
#[cfg(target_arch = "wasm32")]
use getrandom02 as _;

mod ds;
mod error;
mod group;
mod keys;
mod presence;
