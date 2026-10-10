//! The sync engine: one [`Session`] per command run, holding the project
//! state, the doc and (once connected) the WebSocket.
//!
//! The network half mirrors `apps/web/src/sync/encrypted-doc-adaptor.ts`:
//! join with our oplog version, import the backfill until we cover what
//! the server had at join, send encrypted delta records for every op the
//! server lacks, and upload a compaction snapshot once the server holds
//! many deltas.
//!
//! The file half is a three-way merge between the base (the doc state the
//! folder last matched), the folder and the current doc. Local edits are
//! applied to a fork of the base, so text diffs are taken against what the
//! user started from and merge with concurrent remote edits as CRDT ops
//! instead of overwriting them.

mod assets;
mod reconcile;
mod remote;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use loro::{ExportMode, LoroDoc, VersionVector};
use loro_protocol::UpdateStatusCode;
use typstry_doc::apply::ApplyReport;
use typstry_doc::configure;
use typstry_doc::materialize::FileContent;
use typstry_doc::peers::{PALETTE, normalize_peer_name, set_peer};
use typstry_wire::crypto::ProjectKey;

use crate::api::{Api, ShareInfo};
use crate::git::Repo;
use crate::link::ShareLink;
use crate::state::{Base, Config, StateDir};
use crate::worktree::{Skipped, Worktree};

use self::reconcile::BaseFiles;
use self::remote::Conn;

/// The log of updates next to the cached snapshot is folded into a new
/// snapshot once it outgrows the snapshot, or this, whichever is larger.
const COMPACT_LOG_BYTES: u64 = 1024 * 1024;

/// How this run shows up in the history panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub color: String,
}

impl Identity {
    /// The color is derived from the name, so one person keeps one color
    /// across runs even though every run is a new Loro peer.
    pub fn new(name: &str) -> Self {
        let name = normalize_peer_name(name);
        let name = if name.is_empty() {
            "CLI".to_owned()
        } else {
            name
        };
        let hash = name
            .bytes()
            .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b)));
        Self {
            color: PALETTE[hash as usize % PALETTE.len()].to_owned(),
            name,
        }
    }

    /// An explicit name, else the one in the config, else
    /// `git config user.name`, else "CLI".
    pub fn resolve(flag: Option<&str>, config: Option<&str>, dir: &Path) -> Self {
        let name = flag
            .map(str::to_owned)
            .or_else(|| config.map(str::to_owned))
            .or_else(|| crate::git::user_name(dir))
            .unwrap_or_default();
        Self::new(&name)
    }
}

pub type Files = BTreeMap<String, FileContent>;

#[doc(hidden)]
pub type WriteHook = Box<dyn FnMut(&str) + Send>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

impl ChangeKind {
    pub fn symbol(self) -> char {
        match self {
            Self::Added => 'A',
            Self::Modified => 'M',
            Self::Deleted => 'D',
        }
    }
}

/// Which local files a reconcile looks at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Scan the whole folder.
    Full,
    /// Only re-read these paths (files or folders); every other path is
    /// taken to still match the base. For a watcher that knows what
    /// changed. Paths the remote side changed are always re-read too, so
    /// nothing is overwritten unseen.
    Paths(BTreeSet<String>),
}

/// Whether a reconcile sends and saves what it did before it returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flush {
    /// In push mode, send new ops and wait for the server to confirm them,
    /// which needs a connection when there is anything to send. Then save
    /// the base and the cached doc.
    Now,
    /// Leave both to the caller, like the live mode, which keeps editing
    /// while offline and throttles writes of the cached doc. New ops only
    /// land in the doc and go out with the next push or connect.
    Deferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Write remote changes to disk and leave local changes alone. Files
    /// that changed on both sides are not written and end up in
    /// [`Report::conflicts`].
    Pull,
    /// Merge local changes into the doc, send them, and write the merged
    /// result back.
    Push,
}

/// A pull left files alone that changed on both sides.
#[derive(Debug, Clone, thiserror::Error)]
#[error(
    "{} changed both here and remotely, so the remote changes to them were not pulled",
    .paths.join(", ")
)]
pub struct Conflicts {
    pub paths: Vec<String>,
}

/// The two sides of a three-way comparison against the base.
#[derive(Debug, Clone, Default)]
pub struct Status {
    pub local: BTreeMap<String, ChangeKind>,
    pub remote: BTreeMap<String, ChangeKind>,
    /// Files skipped by the scan (symlinks, too large, unreadable).
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, Default)]
pub struct Report {
    pub status: Status,
    /// What the local changes did to the doc; empty for pulls.
    pub applied: ApplyReport,
    /// Changed on both sides and merged; worth a look with git diff.
    pub merged: Vec<String>,
    /// Changed on both sides and left alone by a pull: the remote changes
    /// to these files wait for the next push to merge them.
    pub conflicts: Vec<String>,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    /// Problems that did not stop the run.
    pub warnings: Vec<String>,
    /// The files at the new base, as [`Session::base_files`] would return
    /// them, for callers that track what the folder holds.
    pub base: Arc<Files>,
}

/// What [`Session::reconcile_holding`] did.
#[derive(Debug)]
pub enum Reconciled {
    Done(Box<Report>),
    /// Nothing was touched, because these of the paths to hold changed
    /// remotely.
    Held(BTreeSet<String>),
}

/// An open project folder.
pub struct Session {
    state: StateDir,
    pub config: Config,
    base: Base,
    doc: LoroDoc,
    key: ProjectKey,
    worktree: Worktree,
    api: Api,
    /// What the link resolved to a moment ago, for the next connect.
    resolved: Option<ShareInfo>,
    identity: Identity,
    conn: Option<Conn>,
    /// One warning about undecryptable records is enough per run.
    warned_unreadable: bool,
    /// Problems the connection ran into that did not stop it. The session
    /// never prints: a running sync may be working for another command,
    /// whose terminal they belong in. See [`Self::take_warnings`].
    warnings: Vec<String>,
    /// The server refused a compaction snapshot; it would refuse the next
    /// one for the same reason.
    compaction_refused: bool,
    /// The repo the folder is in, once found. A miss is looked up again
    /// next time, so a `git init` while sync runs is noticed.
    repo: Option<Repo>,
    /// The base files as of the last time they were needed.
    base_files: std::sync::Mutex<Option<BaseFiles>>,
    /// What is on disk in `.typstry/`, as far as this run knows. Exporting
    /// a snapshot costs as much as the doc is big, so an unchanged doc is
    /// not written again, and a changed one only gets the new ops appended
    /// to the log next to the snapshot until that log grows too long.
    saved_vv: Option<VersionVector>,
    saved_base: Option<Base>,
    snapshot_bytes: u64,
    log_bytes: u64,
    /// An append failed and may have left a torn entry behind, after which
    /// further entries would never be read.
    log_broken: bool,
    /// Runs right before a file is written, for tests that need to change
    /// it at exactly that moment.
    #[doc(hidden)]
    pub before_write: Option<WriteHook>,
}

/// Why syncing stopped. Losing the connection is worth trying again; the
/// rest are answers that come out the same however often one asks.
#[derive(Debug, Clone, thiserror::Error)]
pub enum SyncError {
    #[error(
        "lost the connection to the server{}",
        .0.as_ref().map(|r| format!(" ({r})")).unwrap_or_default()
    )]
    Disconnected(Option<String>),
    #[error("the server refused the changes ({0:?})")]
    Refused(UpdateStatusCode),
    #[error("this link now points at project {now}, not {linked}")]
    WrongProject { now: String, linked: String },
    #[error(
        "the project is encrypted with key {project}, but this folder has key {folder}; is the link complete?"
    )]
    KeyMismatch { project: String, folder: String },
    #[error("the server refused this link; it may have been revoked")]
    LinkRefused,
    /// The share endpoint does not know the token, where joining with a
    /// bad one gets [`Self::LinkRefused`].
    #[error("the server does not know this link; it may have been revoked")]
    UnknownLink,
}

impl SyncError {
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Disconnected(_))
    }

    /// The error behind `err` if retrying cannot fix it. Anything that is
    /// not a [`SyncError`], like a network or disk problem, counts as
    /// passing.
    pub fn fatal(err: &anyhow::Error) -> Option<&Self> {
        err.chain()
            .find_map(|cause| cause.downcast_ref::<Self>())
            .filter(|cause| !cause.is_transient())
    }
}

/// What [`Session::next_remote`] saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteEvent {
    /// Remote ops were imported into the doc.
    Imported,
    /// An ack arrived or a retry was sent; nothing changed in the doc.
    Progress,
}

impl Session {
    /// Opens the project `start` is in and takes its lock.
    pub fn open(start: &Path, name: Option<&str>) -> anyhow::Result<Self> {
        Self::open_inner(start, name, None)
    }

    /// [`Self::open`] with an HTTP client for the project's server the
    /// caller already has.
    pub fn open_with_api(start: &Path, name: Option<&str>, api: Api) -> anyhow::Result<Self> {
        Self::open_inner(start, name, Some(api))
    }

    fn open_inner(start: &Path, name: Option<&str>, api: Option<Api>) -> anyhow::Result<Self> {
        let state = StateDir::discover(start)?;
        let config = state.load_config()?;
        let base = state.load_base()?;
        let doc = state.load_doc()?;
        let mut session = Self::assemble(state, config, base, doc, name, api)?;
        session.saved_vv = Some(session.doc.oplog_vv());
        session.saved_base = Some(session.base.clone());
        (session.snapshot_bytes, session.log_bytes) = session.state.doc_sizes();
        Ok(session)
    }

    /// Links `root` to a project: writes `.typstry/` with an empty doc and
    /// base. Nothing is fetched yet. `share` is taken as fresh, so the
    /// first [`Self::connect`] does not resolve the link again.
    pub fn create(
        root: &Path,
        link: &ShareLink,
        share: &ShareInfo,
        name: Option<&str>,
    ) -> anyhow::Result<Self> {
        Self::create_with_api(root, link, share, Api::new(&link.origin)?, name)
    }

    /// [`Self::create`] with the client `share` was resolved with.
    pub fn create_with_api(
        root: &Path,
        link: &ShareLink,
        share: &ShareInfo,
        api: Api,
        name: Option<&str>,
    ) -> anyhow::Result<Self> {
        let state = StateDir::create(root)?;
        let config = Config {
            server: link.origin.clone(),
            project_id: share.project_id.clone(),
            token: link.token.clone(),
            key: link.key.clone(),
            permission: share.permission,
            view_token: share.view_token.clone(),
            name: name.map(str::to_owned),
            branch: None,
        };
        state.save_config(&config)?;
        let mut session = Self::assemble(
            state,
            config,
            Base::default(),
            LoroDoc::new(),
            name,
            Some(api),
        )?;
        session.resolved = Some(share.clone());
        Ok(session)
    }

    fn assemble(
        state: StateDir,
        config: Config,
        base: Base,
        doc: LoroDoc,
        name: Option<&str>,
        api: Option<Api>,
    ) -> anyhow::Result<Self> {
        let key = ProjectKey::from_base64url(&config.key)
            .context("the project key in .typstry/config.json is malformed")?;
        let api = match api {
            Some(api) => api,
            None => Api::new(&config.server)?,
        };
        let identity = Identity::resolve(name, config.name.as_deref(), state.root());
        // A fresh peer per run: two runs can never share one, which Loro
        // requires, and nothing needs to be remembered between runs.
        doc.set_peer_id(random_peer())?;
        configure(&doc);
        Ok(Self {
            worktree: Worktree::new(state.root().to_path_buf()),
            state,
            config,
            base,
            doc,
            key,
            api,
            resolved: None,
            identity,
            conn: None,
            warned_unreadable: false,
            warnings: Vec::new(),
            compaction_refused: false,
            repo: None,
            base_files: std::sync::Mutex::new(None),
            saved_vv: None,
            saved_base: None,
            snapshot_bytes: 0,
            log_bytes: 0,
            log_broken: false,
            before_write: None,
        })
    }

    pub fn root(&self) -> &Path {
        self.state.root()
    }

    pub fn state(&self) -> &StateDir {
        &self.state
    }

    pub fn worktree(&self) -> &Worktree {
        &self.worktree
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    /// The local copy of the project. Edits made through it go out with
    /// the next push, like any other local ops.
    pub fn doc(&self) -> &LoroDoc {
        &self.doc
    }

    /// Unix milliseconds of the last successful sync, if any.
    pub fn last_sync(&self) -> Option<u64> {
        self.base.last_sync
    }

    /// Records that the folder matches the doc as it is now, for a caller
    /// that only changed what is not a file, like project metadata.
    pub fn set_base_to_doc(&mut self) {
        self.base.frontiers = self.doc.oplog_frontiers();
    }

    /// Whether the doc holds remote changes the folder does not have yet:
    /// ops past the base, or files still pinned to an earlier state.
    pub fn has_unwritten_remote(&self) -> bool {
        self.doc_past_base() || !self.base.pins.is_empty()
    }

    /// Files a reconcile left at an earlier doc state, see [`Base::pins`].
    pub fn pinned_paths(&self) -> impl Iterator<Item = &str> {
        self.base.pins.keys().map(String::as_str)
    }

    /// An edit token alone is not enough: other clients only accept
    /// records signed with the key an edit secret carries.
    pub fn can_write(&self) -> bool {
        self.config.permission.can_write() && self.key.can_sign()
    }

    pub fn is_connected(&self) -> bool {
        self.conn.is_some()
    }

    /// Persists the doc and the base, each only if it changed since this
    /// run last saved it. The doc goes first: a base pointing at ops the
    /// cached doc lacks would be unusable.
    pub fn save(&mut self) -> anyhow::Result<()> {
        self.save_doc()?;
        if self.saved_base.as_ref() != Some(&self.base) {
            self.state.save_base(&self.base)?;
            self.saved_base = Some(self.base.clone());
        }
        Ok(())
    }

    /// [`Self::save`], folding the log into a fresh snapshot, for the end
    /// of a long run.
    pub fn save_compacted(&mut self) -> anyhow::Result<()> {
        if self.log_bytes > 0 || self.log_broken {
            self.write_snapshot()?;
        }
        self.save()
    }

    fn save_doc(&mut self) -> anyhow::Result<()> {
        // Only imports and commits move the oplog version, and nothing
        // else ends up in the snapshot.
        let vv = self.doc.oplog_vv();
        let saved = match &self.saved_vv {
            Some(saved) if *saved == vv => return Ok(()),
            Some(saved)
                if !self.log_broken
                    && self.log_bytes <= self.snapshot_bytes.max(COMPACT_LOG_BYTES) =>
            {
                saved
            }
            _ => return self.write_snapshot(),
        };
        let update = self
            .doc
            .export(ExportMode::updates(saved))
            .context("exporting the doc")?;
        match self.state.append_doc(&update) {
            Ok(bytes) => {
                self.log_bytes += bytes;
                self.saved_vv = Some(vv);
                Ok(())
            }
            Err(err) => {
                self.log_broken = true;
                Err(err)
            }
        }
    }

    fn write_snapshot(&mut self) -> anyhow::Result<()> {
        let vv = self.doc.oplog_vv();
        self.snapshot_bytes = self.state.save_doc(&self.doc)?;
        self.log_bytes = 0;
        self.log_broken = false;
        self.saved_vv = Some(vv);
        Ok(())
    }

    /// The git repo the folder is in, if any.
    pub fn repo(&mut self) -> Option<&Repo> {
        cached_repo(&mut self.repo, self.state.root())
    }

    pub fn save_config(&self) -> anyhow::Result<()> {
        self.state.save_config(&self.config)
    }

    /// Warnings collected since the last call or reconcile, which hands
    /// them out in [`Report::warnings`] instead. Each is meant to be
    /// printed as `warning: ...`.
    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    /// Whether git moved HEAD to another branch, or reset it, since the
    /// folder last matched the base. Files may then differ from it without
    /// anyone having edited them.
    pub fn git_switched(&mut self) -> bool {
        let Some(then) = &self.base.git else {
            return false;
        };
        cached_repo(&mut self.repo, self.state.root()).is_some_and(|repo| repo.switched_since(then))
    }
}

/// Looks up the repo `root` is in unless `slot` already holds it. Checking
/// the cached one takes a stat or two where a lookup canonicalizes and
/// walks up the tree, which adds up when sync polls git several times a
/// second.
fn cached_repo<'a>(slot: &'a mut Option<Repo>, root: &Path) -> Option<&'a Repo> {
    let current = slot.as_ref().is_some_and(|repo| {
        // The nearest `.git` has to still be this repo's: one created
        // closer to the folder, as `clone --git` does inside another repo,
        // takes over, and a removed one gives way to whatever is left.
        repo.git_dir.exists()
            && root.ancestors().find(|dir| dir.join(".git").exists())
                == Some(repo.workdir.as_path())
    });
    if !current {
        *slot = Repo::discover(root);
    }
    slot.as_ref()
}

/// Writes our name and color into `peers` under the doc's peer id, so the
/// history panel can say who made an edit.
pub fn set_peer_info(doc: &LoroDoc, identity: &Identity) -> anyhow::Result<()> {
    Ok(set_peer(doc, &identity.name, &identity.color)?)
}

/// Loro reserves `u64::MAX`; JS clients also only ever see ids below 2^63.
fn random_peer() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    u64::from_le_bytes(bytes) >> 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_color_is_stable() {
        let a = Identity::new("  Ada   Lovelace ");
        assert_eq!(a.name, "Ada Lovelace");
        assert_eq!(a, Identity::new("Ada Lovelace"));
        assert!(PALETTE.contains(&a.color.as_str()));
        assert_eq!(Identity::new("").name, "CLI");
        assert_eq!(
            Identity::new(&"x".repeat(100)).name.len(),
            typstry_doc::peers::MAX_PEER_NAME_UTF16
        );
    }

    #[test]
    fn cached_repo_follows_repos_created_or_removed_later() {
        let fake_repo = |dir: &Path| {
            std::fs::create_dir_all(dir.join(".git")).unwrap();
            std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        };
        let outer = tempfile::tempdir().unwrap();
        let outer = outer.path().canonicalize().unwrap();
        let root = outer.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let mut slot = None;
        assert!(cached_repo(&mut slot, &root).is_none());

        fake_repo(&outer);
        assert_eq!(cached_repo(&mut slot, &root).unwrap().workdir, outer);
        fake_repo(&root);
        assert_eq!(cached_repo(&mut slot, &root).unwrap().workdir, root);
        std::fs::remove_dir_all(root.join(".git")).unwrap();
        assert_eq!(cached_repo(&mut slot, &root).unwrap().workdir, outer);
    }
}
