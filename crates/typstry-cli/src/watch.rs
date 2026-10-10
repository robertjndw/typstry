//! The local half of `typstry sync`: a debounced file watcher, the filter
//! that tells real edits from the echo of our own writes, and the git
//! checks that pause syncing while git rewrites the folder.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use typstry_doc::materialize::FileContent;

use crate::engine::{Files, Session};
use crate::git::{Head, Repo};
use crate::hash::Digest;
use crate::mailbox::MAILBOX;
use crate::state::STATE_DIR;
use crate::worktree::Worktree;
use anyhow::Context;
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use tokio::sync::mpsc;

/// Editors save in bursts (write, rename, chmod); one batch per save.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// What the watcher saw. One save reports the same path several times,
/// so paths are a set.
#[derive(Debug)]
pub enum Change {
    Paths(BTreeSet<PathBuf>),
    /// Events were lost or the OS gave up tracking details; only a full
    /// scan can tell what changed.
    Rescan,
    /// A command dropped a request into the mailbox, see
    /// [`crate::mailbox`].
    Requests,
}

/// Watches the project folder recursively. Events arrive on the returned
/// channel until the watcher is dropped.
pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl Watcher {
    pub fn start(root: &Path) -> anyhow::Result<(Self, mpsc::UnboundedReceiver<Change>)> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mailbox = root.join(STATE_DIR).join(MAILBOX);
        let mut debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            let change = match result {
                Ok(events) if events.iter().any(|e| e.need_rescan()) => {
                    let _ = tx.send(Change::Requests);
                    Change::Rescan
                }
                Ok(events) => {
                    let paths: BTreeSet<PathBuf> = events
                        .into_iter()
                        .flat_map(|event| event.event.paths)
                        .collect();
                    if paths.iter().any(|path| is_request(&mailbox, path)) {
                        let _ = tx.send(Change::Requests);
                    }
                    Change::Paths(paths)
                }
                Err(errors) => {
                    for error in errors {
                        tracing::warn!(%error, "file watcher error");
                    }
                    Change::Rescan
                }
            };
            let _ = tx.send(change);
        })
        .context("cannot start the file watcher")?;
        debouncer
            .watch(root, RecursiveMode::Recursive)
            .with_context(|| format!("cannot watch {}", root.display()))?;
        Ok((
            Self {
                _debouncer: debouncer,
            },
            rx,
        ))
    }
}

fn is_request(mailbox: &Path, path: &Path) -> bool {
    path.parent() == Some(mailbox) && path.extension().is_some_and(|ext| ext == "req")
}

/// What one watcher path means for syncing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// A synced path whose content differs from the base, or a new file.
    Changed(String),
    /// A folder appeared or changed; its files may never get events of
    /// their own (a folder moved in from elsewhere), so only a scan helps.
    Folder,
    /// Outside the project, ignored, state of git or typstry, or content
    /// that already matches the base, which includes our own writes.
    Nothing,
}

/// The digest of every file at the base, i.e. of what the folder held
/// right after the last reconcile, our own writes included. A watcher
/// event for a file that still has this content is an echo, or an edit
/// that was undone, and needs no reconcile.
#[derive(Debug, Default)]
pub struct Synced {
    /// The base files the digests were taken of.
    files: Files,
    digests: BTreeMap<String, Option<Known>>,
}

/// What a base file holds on disk, as far as it can be told without the
/// bytes of an asset we never had.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Known {
    digest: Digest,
    /// A file of another size is changed without reading it.
    size: u64,
}

fn size_of(content: &FileContent) -> u64 {
    match content {
        FileContent::Text(text) => text.len() as u64,
        FileContent::Asset { size, .. } => *size,
    }
}

impl Synced {
    /// Recomputes the map from the session's base.
    pub fn refresh(&mut self, session: &Session) -> anyhow::Result<()> {
        self.update(session, session.base_files()?);
        Ok(())
    }

    /// Takes `files` as the base, as a reconcile reports it. Hashing every
    /// file after every reconcile would cost more than the reconcile, so
    /// only files whose content differs from last time are hashed. Assets
    /// whose bytes we never saw have no digest; events for them always
    /// count as changes, which costs a reconcile but never loses an edit.
    pub fn update(&mut self, session: &Session, files: Files) {
        let mut before = std::mem::take(&mut self.digests);
        self.digests = files
            .iter()
            .map(|(path, content)| {
                let unchanged = match (self.files.get(path), before.remove(path)) {
                    (Some(then), Some(known)) if then == content => known,
                    _ => None,
                };
                let known = unchanged.or_else(|| {
                    Some(Known {
                        digest: session.known_digest(content)?,
                        size: size_of(content),
                    })
                });
                (path.clone(), known)
            })
            .collect();
        self.files = files;
    }

    fn contains_under(&self, path: &str) -> bool {
        let prefix = format!("{path}/");
        self.digests
            .range(prefix.clone()..)
            .next()
            .is_some_and(|(p, _)| p.starts_with(&prefix))
    }

    pub fn classify(&self, worktree: &Worktree, abs: &Path) -> Seen {
        let Some(path) = worktree.relative(abs) else {
            return Seen::Nothing;
        };
        let meta = std::fs::symlink_metadata(abs);
        let is_dir = meta.as_ref().is_ok_and(std::fs::Metadata::is_dir);
        if worktree.is_ignored(&path, is_dir) {
            return Seen::Nothing;
        }
        match meta {
            Ok(meta) if meta.is_dir() => Seen::Folder,
            Ok(meta) if meta.is_file() => {
                let Some(Some(known)) = self.digests.get(&path) else {
                    return Seen::Changed(path);
                };
                if meta.len() != known.size {
                    return Seen::Changed(path);
                }
                let current = worktree
                    .read_bytes(&path)
                    .ok()
                    .flatten()
                    .map(|bytes| Digest::of(&bytes));
                if current.as_ref() == Some(&known.digest) {
                    Seen::Nothing
                } else {
                    Seen::Changed(path)
                }
            }
            // A symlink or something else we do not sync: the reconcile
            // treats it as unchanged anyway.
            Ok(_) => Seen::Nothing,
            Err(_) => {
                if self.digests.contains_key(&path) || self.contains_under(&path) {
                    Seen::Changed(path)
                } else {
                    // Deleted before we looked: a temp file of an atomic
                    // save (ours or an editor's) or a short-lived build file.
                    Seen::Nothing
                }
            }
        }
    }
}

/// Whether git lets us sync right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitState {
    /// Not a git repo, or on the tracked branch with nothing in progress.
    Clear,
    /// A git command is rewriting files; syncing now would publish or
    /// overwrite half its work.
    Busy(&'static str),
    /// Checked out something other than the tracked branch.
    Elsewhere { head: Head, tracked: Option<String> },
}

impl GitState {
    /// `repo` comes with the HEAD the caller read from it, so HEAD is read
    /// once per look.
    pub fn of(repo: Option<(&Repo, Head)>, tracked: Option<&str>) -> Self {
        let Some((repo, head)) = repo else {
            return Self::Clear;
        };
        if !head.is_on(tracked) {
            return Self::Elsewhere {
                head,
                tracked: tracked.map(str::to_owned),
            };
        }
        match repo.operation_in_progress() {
            Some(op) => Self::Busy(op),
            None => Self::Clear,
        }
    }

    /// Why git keeps typstry from syncing, if it does, as the middle of a
    /// sentence: "git is in the middle of a merge", "on branch draft,
    /// typstry tracks main".
    pub fn reason(&self) -> Option<String> {
        match self {
            Self::Clear => None,
            Self::Busy(op) => Some(format!("git is in the middle of {op}")),
            Self::Elsewhere {
                head,
                tracked: Some(tracked),
            } => Some(format!("on {head}, typstry tracks {tracked}")),
            Self::Elsewhere {
                head,
                tracked: None,
            } => Some(format!(
                "on {head}, and typstry does not track a branch yet"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_state_follows_head_and_locks() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        assert_eq!(GitState::of(None, Some("main")), GitState::Clear);
        assert_eq!(
            GitState::of(Some((&repo, repo.head())), Some("main")),
            GitState::Clear
        );
        assert!(matches!(
            GitState::of(Some((&repo, repo.head())), Some("draft")),
            GitState::Elsewhere { .. }
        ));
        assert!(matches!(
            GitState::of(Some((&repo, repo.head())), None),
            GitState::Elsewhere { .. }
        ));
        std::fs::write(dir.path().join(".git/index.lock"), "").unwrap();
        assert!(matches!(
            GitState::of(Some((&repo, repo.head())), Some("main")),
            GitState::Busy(_)
        ));
    }
}
