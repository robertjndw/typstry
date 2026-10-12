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
mod membership;
mod reconcile;
mod remote;
mod space;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use loro::LoroDoc;
use loro_protocol::UpdateStatusCode;
use typstry_doc::apply::ApplyReport;
use typstry_doc::materialize::FileContent;
use typstry_doc::peers::{PALETTE, normalize_peer_name, set_peer};
use typstry_wire::mls::SpaceGroup;

use crate::api::{Api, ShareInfo};
use crate::git::Repo;
use crate::link::ShareLink;
use crate::state::{Base, Config, StateDir};
use crate::worktree::{Skipped, Worktree};

use self::reconcile::BaseFiles;
pub use self::space::{DocKind, SpaceCore};

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

    /// An explicit name, else the one in the config, else the person's
    /// profile (`person`, the bytes in their graph), else
    /// `git config user.name`, else "CLI". An explicit name only changes
    /// this run's leaf, never the person's profile.
    pub fn resolve(
        flag: Option<&str>,
        config: Option<&str>,
        person: Option<&[u8]>,
        dir: &Path,
    ) -> Self {
        if flag.is_none()
            && config.is_none()
            && let Some(identity) = person.and_then(crate::mls::profile_identity)
        {
            return identity;
        }
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

/// An open project folder: the space plus the worktree it is synced with.
pub struct Session {
    core: SpaceCore,
    base: Base,
    worktree: Worktree,
    /// The repo the folder is in, once found. A miss is looked up again
    /// next time, so a `git init` while sync runs is noticed.
    repo: Option<Repo>,
    /// The base files as of the last time they were needed.
    base_files: std::sync::Mutex<Option<BaseFiles>>,
    saved_base: Option<Base>,
    /// Runs right before a file is written, for tests that need to change
    /// it at exactly that moment.
    #[doc(hidden)]
    pub before_write: Option<WriteHook>,
}

impl std::ops::Deref for Session {
    type Target = SpaceCore;

    fn deref(&self) -> &SpaceCore {
        &self.core
    }
}

impl std::ops::DerefMut for Session {
    fn deref_mut(&mut self) -> &mut SpaceCore {
        &mut self.core
    }
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
    /// The link's secret opens nothing of the project's group.
    #[error("the link does not open this project's keys; is the link complete?")]
    WrongKey,
    #[error("the server refused this link; it may have been revoked")]
    LinkRefused,
    /// The group names another owner than the one this folder pinned, or
    /// does not verify.
    #[error("The project's member group now claims a different owner. Refusing to rejoin.")]
    OwnerChanged,
    /// The group was reset with a keyring that drops or changes what this
    /// folder knew, which only someone forging it would do.
    #[error(
        "The project's member group was reset with keys that do not match the ones this folder knew. Refusing to rejoin."
    )]
    GroupRewritten,
    /// The link was replaced by a rotation and the group did not hand this
    /// folder the new one.
    #[error(
        "this link was replaced by a newer one and this folder could not follow the change; ask an editor for the current link and clone again"
    )]
    LinkReplaced,
    /// An editor removed this folder from the project.
    #[error(
        "you were removed from this project; this folder can no longer sync. Your files here are untouched"
    )]
    Removed,
    /// The share endpoint does not know the token, where joining with a
    /// bad one gets [`Self::LinkRefused`].
    #[error("the server does not know this link; it may have been revoked")]
    UnknownLink,
    #[error(transparent)]
    SchemaTooNew(#[from] typstry_doc::SchemaTooNew),
    /// The link opened a doc that is not a project.
    #[error(transparent)]
    ForeignKind(#[from] typstry_doc::ForeignKind),
    /// The link opened a doc that is not the directory it should be.
    #[error(transparent)]
    Directory(#[from] typstry_doc::directory::Unsupported),
    /// The server answered 426: it no longer serves this protocol version.
    #[error("this typstry is too old for the server at {server}; upgrade typstry")]
    ProtocolTooOld { server: String },
}

impl SyncError {
    /// For a 426 from `url`, named by its host since the scheme and path
    /// differ between the HTTP and WebSocket endpoints of one server.
    pub fn protocol_too_old(url: &str) -> Self {
        let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
        let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        Self::ProtocolTooOld {
            server: host.to_owned(),
        }
    }

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
        let base = state.load_base()?;
        let core = SpaceCore::open(state, DocKind::PROJECT, name, api)?;
        let mut session = Self::wrap(core, base);
        session.saved_base = Some(session.base.clone());
        Ok(session)
    }

    /// Links `root` to a project: writes `.typstry/` with an empty doc and
    /// base. Nothing is fetched yet. `share` is taken as fresh, so the
    /// first [`Self::connect`] does not resolve the link again. `group` is
    /// the folder's seat in the project's group if it created the project;
    /// otherwise the first connect joins it.
    pub fn create(
        root: &Path,
        link: &ShareLink,
        share: &ShareInfo,
        group: Option<SpaceGroup>,
        name: Option<&str>,
    ) -> anyhow::Result<Self> {
        Self::create_with_api(root, link, share, Api::new(&link.origin)?, group, name)
    }

    /// [`Self::create`] with the client `share` was resolved with.
    pub fn create_with_api(
        root: &Path,
        link: &ShareLink,
        share: &ShareInfo,
        api: Api,
        group: Option<SpaceGroup>,
        name: Option<&str>,
    ) -> anyhow::Result<Self> {
        let state = StateDir::create(root)?;
        let config = Config::new(link, share, name, group.as_ref());
        state.save_config(&config)?;
        if let Some(group) = &group {
            state.save_mls(group)?;
        }
        let mut core = SpaceCore::assemble(
            state,
            config,
            DocKind::PROJECT,
            LoroDoc::new(),
            group,
            name,
            Some(api),
        )?;
        core.resolved = Some(share.clone());
        Ok(Self::wrap(core, Base::default()))
    }

    fn wrap(core: SpaceCore, base: Base) -> Self {
        Self {
            worktree: Worktree::new(core.state.root().to_path_buf()),
            core,
            base,
            repo: None,
            base_files: std::sync::Mutex::new(None),
            saved_base: None,
            before_write: None,
        }
    }

    pub fn worktree(&self) -> &Worktree {
        &self.worktree
    }

    /// Unix milliseconds of the last successful sync, if any.
    pub fn last_sync(&self) -> Option<u64> {
        self.base.last_sync
    }

    /// Records that the folder matches the doc as it is now, for a caller
    /// that only changed what is not a file, like project metadata.
    pub fn set_base_to_doc(&mut self) {
        self.base.frontiers = self.core.doc.oplog_frontiers();
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

    /// Persists the doc and the base, each only if it changed since this
    /// run last saved it. The doc goes first: a base pointing at ops the
    /// cached doc lacks would be unusable.
    pub fn save(&mut self) -> anyhow::Result<()> {
        self.core.save_doc()?;
        if self.saved_base.as_ref() != Some(&self.base) {
            self.core.state.save_base(&self.base)?;
            self.saved_base = Some(self.base.clone());
        }
        Ok(())
    }

    /// [`Self::save`], folding the log into a fresh snapshot, for the end
    /// of a long run.
    pub fn save_compacted(&mut self) -> anyhow::Result<()> {
        self.core.compact_doc()?;
        self.save()
    }

    /// The git repo the folder is in, if any.
    pub fn repo(&mut self) -> Option<&Repo> {
        cached_repo(&mut self.repo, self.core.state.root())
    }

    /// Whether git moved HEAD to another branch, or reset it, since the
    /// folder last matched the base. Files may then differ from it without
    /// anyone having edited them.
    pub fn git_switched(&mut self) -> bool {
        let Some(then) = &self.base.git else {
            return false;
        };
        cached_repo(&mut self.repo, self.core.state.root())
            .is_some_and(|repo| repo.switched_since(then))
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
pub(crate) fn random_peer() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    u64::from_le_bytes(bytes) >> 1
}

#[cfg(test)]
mod tests {
    use typstry_wire::crypto::LinkSecret;

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
    fn a_doc_from_a_newer_typstry_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        state
            .save_config(&crate::state::tests::test_config())
            .unwrap();
        let doc = LoroDoc::new();
        doc.get_map(typstry_doc::root::META)
            .insert(typstry_doc::meta::SCHEMA, 2.0)
            .unwrap();
        doc.commit();
        state.save_doc(&doc).unwrap();
        drop(state);

        let err = Session::open(dir.path(), None).err().unwrap();
        assert!(format!("{err:#}").contains("upgrade typstry"), "{err:#}");
        assert!(matches!(
            SyncError::fatal(&err),
            Some(SyncError::SchemaTooNew(_))
        ));
    }

    #[test]
    fn a_space_opens_headless() {
        let dir = tempfile::tempdir().unwrap();
        let space = dir.path().join("spaces/x");
        let state = StateDir::open_headless(&space).unwrap();
        let config = Config {
            key: LinkSecret::generate_edit().to_base64url().to_string(),
            ..crate::state::tests::test_config()
        };
        state.save_config(&config).unwrap();
        let doc = LoroDoc::new();
        doc.get_text("t").insert(0, "hi").unwrap();
        doc.commit();
        state.save_doc(&doc).unwrap();
        drop(state);

        let state = StateDir::open_headless(&space).unwrap();
        let mut core = SpaceCore::open(state, DocKind::PROJECT, Some("Ada"), None).unwrap();
        assert_eq!(core.doc().get_text("t").to_string(), "hi");
        assert_eq!(core.identity().name, "Ada");
        core.doc().get_text("t").insert(2, "!").unwrap();
        core.doc().commit();
        core.save_doc().unwrap();
        drop(core);

        let state = StateDir::open_headless(&space).unwrap();
        assert_eq!(state.load_doc().unwrap().0.get_text("t").to_string(), "hi!");
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
