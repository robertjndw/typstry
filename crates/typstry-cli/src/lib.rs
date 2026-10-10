//! The `typstry` command line client: mirrors a project into a local
//! folder (usually a git checkout) and syncs it with the server the way
//! the browser does, end-to-end encrypted.
//!
//! The binary is a thin wrapper around [`commands::run`]; everything is a
//! library so the integration tests can drive it in-process.

pub mod api;
pub mod client;
pub mod commands;
pub mod engine;
pub mod git;
pub mod link;
pub mod mailbox;
pub mod state;
pub mod watch;
pub mod worktree;
