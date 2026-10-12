//! Pausing for git and holding back outgoing changes after a branch
//! switch.

use std::path::PathBuf;
use std::time::Instant;

use crate::commands::{Output, track_branch};
use crate::engine::Scope;
use crate::git::{GitMark, Head};
use crate::state::remove_if_exists;
use crate::watch::GitState;

use super::{ANNOUNCE_BUSY_AFTER, Live, Notice, Outbound};

/// Present in `.typstry/` while local changes are held back after a branch
/// switch, so a restarted sync keeps holding them.
const HOLD_MARKER: &str = "hold";

pub(super) struct Pause {
    /// Some other branch was checked out at some point during the pause,
    /// so the folder may now hold anything.
    pub(super) left_branch: bool,
    /// What git was up to on the last poll; [`GitState::Clear`] while
    /// waiting for it to settle.
    pub(super) git: GitState,
    /// Where HEAD was when the pause began.
    start: Option<GitMark>,
    /// Where HEAD was on the last poll that found git done, if the one
    /// before found it busy or elsewhere.
    settled: Option<GitMark>,
    since: Instant,
    /// The last pause line printed, to print again only on news. Also
    /// says whether the pause was announced at all.
    shown: Option<String>,
}

impl Pause {
    fn new(left_branch: bool, git: GitState, start: Option<GitMark>, since: Instant) -> Self {
        Pause {
            left_branch,
            git,
            start,
            settled: None,
            since,
            shown: None,
        }
    }
}

impl Live {
    pub(super) async fn poll_git(&mut self) {
        let (repo, head) = match track_branch(&mut self.session, &mut Output::terminal()) {
            Ok(found) => found.unzip(),
            Err(err) => {
                self.error(&err);
                return;
            }
        };
        let state = GitState::of(
            repo.as_ref().zip(head),
            self.session.config.branch.as_deref(),
        );
        let Some(reason) = state.reason() else {
            if let Some(pause) = &mut self.pause {
                pause.git = GitState::Clear;
                if let Some(repo) = &repo {
                    // git checkout drops index.lock a moment before it
                    // moves HEAD, so one look can still show the old
                    // branch. Two looks in a row have to agree.
                    let mark = repo.mark();
                    if pause.settled.as_ref() != Some(&mark) {
                        pause.settled = Some(mark);
                        return;
                    }
                    if pause
                        .start
                        .as_ref()
                        .is_some_and(|start| repo.switched_since(start))
                    {
                        pause.left_branch = true;
                    }
                }
                if let Some(pause) = self.pause.take() {
                    self.resume(pause).await;
                }
            }
            return;
        };
        let now = Instant::now();
        let fresh = self.pause.is_none();
        let elsewhere = matches!(state, GitState::Elsewhere { .. });
        let mut line = format!("sync: paused, {reason}");
        if let GitState::Elsewhere {
            head: Head::Detached,
            tracked: None,
        } = &state
        {
            line.push_str("; check out a branch or use typstry track");
        }
        let pause = self.pause.get_or_insert_with(|| {
            Pause::new(
                elsewhere,
                state.clone(),
                repo.as_ref().map(|r| r.mark()),
                now,
            )
        });
        pause.git = state;
        pause.settled = None;
        if elsewhere {
            pause.left_branch = true;
            if pause.shown.as_deref() != Some(line.as_str()) {
                say!("{line}");
                pause.shown = Some(line);
            }
            // Edits made before the switch that were still waiting belong
            // to the tracked branch; they are part of what the check on
            // return looks at.
            self.local.clear();
        } else if pause.shown.is_none() && now >= pause.since + ANNOUNCE_BUSY_AFTER {
            say!("{line}");
            pause.shown = Some(line);
        }
        if fresh {
            self.notify(Notice::Paused);
        }
    }

    pub(super) async fn resume(&mut self, pause: Pause) {
        if pause.shown.is_some() {
            say!("sync: resumed");
        }
        self.notify(Notice::Resumed);
        if pause.left_branch {
            // Another switch after publishing needs its own check.
            if self.outbound == Outbound::Published {
                self.outbound = Outbound::Open;
            }
            self.local.clear();
            self.check_tree().await;
            if !self.holding() {
                // The tree matches the base, but a rescan is cheap and
                // catches anything the watcher could not attribute.
                self.local.rescan_now();
            }
        }
    }

    /// After a checkout, a folder that differs from the last sync may lack
    /// remote edits that were pulled while a draft was checked out. Pushing
    /// it would revert them, so outbound changes wait for an explicit
    /// publish.
    pub(super) async fn check_tree(&mut self) {
        if !self.session.can_write() {
            return;
        }
        match self.session.status(&Scope::Full).await {
            Ok(status) if status.local.is_empty() => {}
            Ok(status) => {
                self.hold(status.local.len());
                say!(
                    "sync: {} file(s) differ from the last sync after a branch switch or reset; holding back outgoing changes:",
                    status.local.len()
                );
                for (path, kind) in &status.local {
                    say!("  {} {path}", kind.symbol());
                }
                say!(
                    "sync: review them, then {} here to publish (or stop sync and run typstry push --force)",
                    self.publish_hint
                );
            }
            Err(err) => {
                let count = match self.outbound {
                    Outbound::Holding { count } => count,
                    _ => 0,
                };
                self.hold(count);
                say_err!(
                    "sync: cannot compare the folder with the last sync ({err:#}); holding back outgoing changes until you {}",
                    self.publish_hint
                );
            }
        }
    }

    /// Holds back outgoing changes; `count` files differ from the last
    /// sync.
    fn hold(&mut self, count: usize) {
        self.outbound = Outbound::Holding { count };
        let marker = self.hold_marker();
        if let Err(err) = std::fs::write(&marker, b"") {
            say_err!("warning: cannot write {}: {err}", marker.display());
        }
        self.notify(Notice::Holding);
    }

    pub(super) fn release(&mut self) {
        self.outbound = Outbound::Open;
        self.blocked = None;
        if let Err(err) = remove_if_exists(&self.hold_marker()) {
            say_err!("warning: {err:#}");
        }
        self.notify(Notice::Released);
    }

    pub(super) fn publish(&mut self) {
        if !self.holding() {
            say!("sync: nothing is held back");
            return;
        }
        if self.pause.is_some() {
            say!("sync: paused; publish once the tracked branch is checked out again");
            return;
        }
        say!("sync: publishing held changes");
        self.release();
        self.outbound = Outbound::Published;
        self.local.rescan_now();
    }

    /// While holding, every folder change is checked against the base: once
    /// the folder matches it again (the user restored the files), there is
    /// nothing left that could revert anything and the hold ends.
    pub(super) async fn recheck_hold(&mut self) {
        match self.session.status(&Scope::Full).await {
            Ok(status) if status.local.is_empty() => {
                say!("sync: the folder matches the last sync again; resuming outgoing changes");
                self.release();
            }
            Ok(status) => {
                let count = status.local.len();
                if self.outbound != (Outbound::Holding { count }) {
                    self.outbound = Outbound::Holding { count };
                    say!(
                        "sync: holding back {count} changed file(s); {} to publish",
                        self.publish_hint
                    );
                }
            }
            Err(err) => self.error(&err),
        }
    }

    pub(super) fn hold_marker(&self) -> PathBuf {
        self.session.state().dir().join(HOLD_MARKER)
    }
}
