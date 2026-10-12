//! The `typstry` command line client: mirrors a project into a local
//! folder (usually a git checkout) and syncs it with the server the way
//! the browser does, end-to-end encrypted.
//!
//! The binary is a thin wrapper around [`commands::run`]; everything is a
//! library so the integration tests can drive it in-process.

/// `println!` and `eprintln!` through [`commands::Line`], so an interactive view can
/// place the text above itself instead of it landing on top of the view.
macro_rules! say {
    ($($arg:tt)*) => {
        $crate::commands::Line::Stdout(format!($($arg)*)).print()
    };
}

macro_rules! say_err {
    ($($arg:tt)*) => {
        $crate::commands::Line::Stderr(format!($($arg)*)).print()
    };
}

pub mod api;
pub mod client;
pub mod commands;
pub mod directory;
pub mod engine;
pub mod git;
pub mod hash;
pub mod link;
pub mod mailbox;
pub mod mls;
pub mod space;
pub mod state;
pub mod term;
pub mod tui;
pub mod user;
pub mod watch;
pub mod worktree;
