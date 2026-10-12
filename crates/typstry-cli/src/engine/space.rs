//! The part of a session that does not care what the space holds: the
//! state directory, the doc, the group and the connection. A folder
//! [`Session`](super::Session) adds a worktree on top; a headless space
//! (see [`StateDir::open_headless_waiting`]) is just this.

use anyhow::Context;
use loro::{ExportMode, LoroDoc, VersionVector};
use typstry_doc::directory;
use typstry_wire::crypto::LinkSecret;
use typstry_wire::mls::{LocalIdentity, SpaceGroup};

use crate::api::{Api, ShareInfo};
use crate::state::{Config, StateDir};

use super::remote::Conn;
use super::{Identity, SyncError, random_peer};

/// The log of updates next to the cached snapshot is folded into a new
/// snapshot once it outgrows the snapshot, or this, whichever is larger.
const COMPACT_LOG_BYTES: u64 = 1024 * 1024;

/// What differs between kinds of space in how their doc is handled. Both
/// run on whatever the doc holds, so they must not assume it is complete.
#[derive(Clone, Copy)]
pub struct DocKind {
    /// Refuses a doc written by a newer client than this one.
    pub ensure: fn(&LoroDoc) -> Result<(), SyncError>,
    /// Upgrades an older layout in place; true if it changed anything.
    pub migrate: fn(&LoroDoc) -> loro::LoroResult<bool>,
    /// The per-instance settings, applied before the first local commit.
    pub configure: fn(&LoroDoc),
    /// Whether the space is one of the person's projects, so the directory
    /// lists it and learns what happens to it. The directory and other
    /// spaces of the person are not.
    pub listed: bool,
}

impl DocKind {
    /// A project: the layout `typstry-doc` defines.
    pub const PROJECT: Self = Self {
        ensure: |doc| {
            typstry_doc::ensure_supported(doc).map_err(|e| match e {
                typstry_doc::Unsupported::TooNew(e) => SyncError::from(e),
                typstry_doc::Unsupported::ForeignKind(e) => SyncError::from(e),
            })
        },
        migrate: typstry_doc::migrate,
        configure: typstry_doc::configure,
        listed: true,
    };

    /// The person's directory of projects, kept in a space of its own.
    pub const DIRECTORY: Self = Self {
        ensure: |doc| directory::ensure_supported(doc).map_err(SyncError::from),
        migrate: |_| Ok(false),
        configure: directory::configure,
        listed: false,
    };
}

/// An open space: its state, doc and group, and (once connected) the
/// WebSocket.
pub struct SpaceCore {
    pub(super) state: StateDir,
    pub config: Config,
    pub(super) kind: DocKind,
    pub(super) doc: LoroDoc,
    /// Our seat in the space's group. It holds the doc keys and the key
    /// that signs records. None until the first connect has joined the
    /// group.
    pub(super) group: Option<SpaceGroup>,
    pub(super) api: Api,
    /// What the link resolved to a moment ago, for the next connect.
    pub(super) resolved: Option<ShareInfo>,
    pub(super) identity: Identity,
    /// This device's key and person graph, read once per run and replaced
    /// by what each save of the graph hands back. None while the machine is
    /// not a person yet, or its files could not be read; whoever needs one
    /// then reads them again and gets the error.
    pub(super) local: Option<LocalIdentity>,
    pub(super) conn: Option<Conn>,
    /// One warning about undecryptable records is enough per run.
    pub(super) warned_unreadable: bool,
    /// Problems the connection ran into that did not stop it. The session
    /// never prints: a running sync may be working for another command,
    /// whose terminal they belong in. See [`Self::take_warnings`].
    pub(super) warnings: Vec<String>,
    /// The server refused a compaction snapshot; it would refuse the next
    /// one for the same reason.
    pub(super) compaction_refused: bool,
    /// What is on disk in the state dir, as far as this run knows.
    /// Exporting a snapshot costs as much as the doc is big, so an
    /// unchanged doc is not written again, and a changed one only gets the
    /// new ops appended to the log next to the snapshot until that log
    /// grows too long.
    saved_vv: Option<VersionVector>,
    snapshot_bytes: u64,
    log_bytes: u64,
    /// An append failed and may have left a torn entry behind, after which
    /// further entries would never be read.
    log_broken: bool,
}

impl SpaceCore {
    /// Opens the space whose state is in `state`.
    pub fn open(
        state: StateDir,
        kind: DocKind,
        name: Option<&str>,
        api: Option<Api>,
    ) -> anyhow::Result<Self> {
        let config = state.load_config()?;
        let (doc, note) = state.load_doc()?;
        // Checked here so read-only commands refuse too: they would
        // misread a layout this build does not know.
        (kind.ensure)(&doc)?;
        let (group, group_note) = state.load_mls()?;
        let mut core = Self::assemble(state, config, kind, doc, group, name, api)?;
        core.warnings.extend(note);
        core.warnings.extend(group_note);
        core.saved_vv = Some(core.doc.oplog_vv());
        (core.snapshot_bytes, core.log_bytes) = core.state.doc_sizes();
        Ok(core)
    }

    pub(super) fn assemble(
        state: StateDir,
        config: Config,
        kind: DocKind,
        doc: LoroDoc,
        group: Option<SpaceGroup>,
        name: Option<&str>,
        api: Option<Api>,
    ) -> anyhow::Result<Self> {
        LinkSecret::from_base64url(&config.key)
            .context("reading the link secret in .typstry/config.json")?;
        let api = match api {
            Some(api) => api,
            None => Api::new(&config.server)?,
        };
        // Best effort: a damaged graph only costs the person's profile here,
        // and what needs the identity itself reads it again to report why.
        let local = crate::user::load_identity().ok().flatten();
        let identity = Identity::resolve(
            name,
            config.name.as_deref(),
            local.as_ref().and_then(|l| l.graph.profile()),
            state.root(),
        );
        // A fresh peer per run: two runs can never share one, which Loro
        // requires, and nothing needs to be remembered between runs.
        doc.set_peer_id(random_peer())?;
        (kind.configure)(&doc);
        Ok(Self {
            state,
            config,
            kind,
            doc,
            group,
            api,
            resolved: None,
            identity,
            local,
            conn: None,
            warned_unreadable: false,
            warnings: Vec::new(),
            compaction_refused: false,
            saved_vv: None,
            snapshot_bytes: 0,
            log_bytes: 0,
            log_broken: false,
        })
    }

    pub fn root(&self) -> &std::path::Path {
        self.state.root()
    }

    pub fn state(&self) -> &StateDir {
        &self.state
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    /// The local copy of the doc. Edits made through it go out with the
    /// next push, like any other local ops.
    pub fn doc(&self) -> &LoroDoc {
        &self.doc
    }

    /// An edit token alone is not enough: other clients only accept
    /// records signed with the key an edit secret carries.
    pub fn can_write(&self) -> bool {
        self.config.permission.can_write() && self.config.can_sign()
    }

    pub fn is_connected(&self) -> bool {
        self.conn.is_some()
    }

    pub fn save_config(&self) -> anyhow::Result<()> {
        self.state.save_config(&self.config)
    }

    /// Warnings collected since the last call. Each is meant to be printed
    /// as `warning: ...`.
    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    /// Folds the log into a fresh snapshot, for the end of a long run.
    pub fn compact_doc(&mut self) -> anyhow::Result<()> {
        if self.log_bytes > 0 || self.log_broken {
            self.write_snapshot()?;
        }
        Ok(())
    }

    /// Persists the doc if it changed since this run last saved it.
    pub fn save_doc(&mut self) -> anyhow::Result<()> {
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
}
