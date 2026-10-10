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

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use loro::{ExportMode, IdSpan, LoroDoc, VersionVector};
use loro_protocol::{BatchId, EloHeader, EloRecordKind, UpdateStatusCode, decode_elo_container};
use typstry_doc::apply::{ApplyReport, apply_files};
use typstry_doc::configure;
use typstry_doc::materialize::{FileContent, MaterializedFile, materialize};
use typstry_doc::peers::set_peer;
use typstry_wire::crypto::{BLOB_CONTEXT, CryptoError, ProjectKey};
use typstry_wire::elo::{encode_container, pack, parse_peer_id};

use crate::api::{Api, Permission, ShareInfo};
use crate::client::{Client, Event};
use crate::git::Repo;
use crate::link::{ShareLink, ws_url};
use crate::state::{Base, Config, StateDir, decode_frontiers, encode_frontiers};
use crate::worktree::{LocalFile, MAX_ASSET_BYTES, Skipped, Worktree, case_clashes, mime_for};

/// Same as the adaptor's `CONTAINER_BUDGET`: one container per send stays
/// well under the server's limit for a reassembled update.
const CONTAINER_BUDGET: usize = 1024 * 1024;

/// Commit message of the changes a push makes, so history can tell them
/// from browser edits.
const PUSH_MESSAGE: &str = "cli push";

/// Upload a compaction snapshot once the server holds this many deltas.
const COMPACT_AFTER_DELTAS: u64 = 200;

/// Delay before resending what the server refused for a passing reason.
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// How long a one-shot command waits for the server without any progress.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// The browser's avatar palette (`PALETTE` in presence/identity.ts).
const PALETTE: [&str; 10] = [
    "#c2410c", "#b91c1c", "#be185d", "#7e22ce", "#4338ca", "#1d4ed8", "#0e7490", "#047857",
    "#4d7c0f", "#a16207",
];

/// The longest display name the browser accepts.
const MAX_NAME_CHARS: usize = 40;

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
        let name: String = name
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(MAX_NAME_CHARS)
            .collect();
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
}

/// What a local path holds as far as a reconcile is concerned.
#[derive(Debug, Clone)]
enum Local {
    File(LocalFile),
    /// Exists on disk but is not synced (ignored, a symlink, unreadable)
    /// or was not looked at: treated as unchanged since the base.
    AsBase,
}

/// An open project folder.
pub struct Session {
    state: StateDir,
    pub config: Config,
    pub base: Base,
    pub doc: LoroDoc,
    key: ProjectKey,
    worktree: Worktree,
    api: Api,
    identity: Identity,
    conn: Option<Conn>,
    /// One warning about undecryptable records is enough per run.
    warned_unreadable: bool,
    /// The server refused a compaction snapshot; it would refuse the next
    /// one for the same reason.
    compaction_refused: bool,
    /// Runs right before a file is written, for tests that need to change
    /// it at exactly that moment.
    #[doc(hidden)]
    pub before_write: Option<WriteHook>,
}

/// Per-connection sync state, the adaptor's fields.
struct Conn {
    client: Client,
    /// Per peer, the end of the op range we believe the server stores.
    server: HashMap<u64, u64>,
    /// The server's coverage at join; caught up means covering it.
    target: VersionVector,
    deltas: u64,
    snapshot_sent: bool,
    /// Sent containers awaiting their ack, for rewinding on refusal.
    in_flight: HashMap<BatchId, Vec<u8>>,
    retry_at: Option<Instant>,
    /// Per peer, the end of every op range the server sent us, including
    /// records we could not decrypt.
    seen: HashMap<u64, u64>,
    /// Records that did not decrypt, and the key id of the last one that
    /// was under another key.
    unreadable: u64,
    mismatched_key: Option<String>,
    decrypted: u64,
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
        let state = StateDir::discover(start)?;
        let config = state.load_config()?;
        let base = state.load_base()?;
        let doc = state.load_doc()?;
        Self::assemble(state, config, base, doc, name)
    }

    /// Links `root` to a project: writes `.typstry/` with an empty doc and
    /// base. Nothing is fetched yet.
    pub fn create(
        root: &Path,
        link: &ShareLink,
        share: &ShareInfo,
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
        Self::assemble(state, config, Base::default(), LoroDoc::new(), name)
    }

    fn assemble(
        state: StateDir,
        config: Config,
        base: Base,
        doc: LoroDoc,
        name: Option<&str>,
    ) -> anyhow::Result<Self> {
        let key = ProjectKey::from_base64url(&config.key)
            .context("the project key in .typstry/config.json is malformed")?;
        let api = Api::new(&config.server)?;
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
            identity,
            conn: None,
            warned_unreadable: false,
            compaction_refused: false,
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

    pub fn can_write(&self) -> bool {
        self.config.permission.can_write()
    }

    pub fn is_connected(&self) -> bool {
        self.conn.is_some()
    }

    /// Persists the doc and the base. The doc goes first: a base pointing
    /// at ops the cached doc lacks would be unusable.
    pub fn save(&self) -> anyhow::Result<()> {
        self.state.save_doc(&self.doc)?;
        self.state.save_base(&self.base)?;
        Ok(())
    }

    pub fn save_config(&self) -> anyhow::Result<()> {
        self.state.save_config(&self.config)
    }

    /// Connects and catches up: resolves the link (refreshing the cached
    /// permission and view token), joins, imports the backfill until the
    /// doc covers what the server had, then sends ops the server lacks,
    /// e.g. from an earlier run that went offline.
    pub async fn connect(&mut self) -> anyhow::Result<()> {
        self.disconnect().await;
        let share = self.api.resolve_share(&self.config.token).await?;
        if share.project_id != self.config.project_id {
            bail!(
                "this link now points at project {}, not {}",
                share.project_id,
                self.config.project_id
            );
        }
        if share.permission != self.config.permission || share.view_token.is_some() {
            self.config.permission = share.permission;
            if share.view_token.is_some() {
                self.config.view_token = share.view_token;
            }
            self.save_config()?;
        }

        let mut client =
            Client::connect(&ws_url(&self.config.server)?, &self.config.project_id).await?;
        let joined = client
            .join(&self.config.token, &self.doc.oplog_vv())
            .await?;
        let permission = match joined.permission {
            loro_protocol::Permission::Write => Permission::Write,
            loro_protocol::Permission::Read => Permission::Read,
        };
        if permission != self.config.permission {
            self.config.permission = permission;
            self.save_config()?;
        }
        self.conn = Some(Conn {
            client,
            server: joined
                .version
                .iter()
                .map(|(&peer, &counter)| (peer, counter.max(0) as u64))
                .collect(),
            target: joined.version,
            deltas: joined.deltas,
            snapshot_sent: false,
            in_flight: HashMap::new(),
            retry_at: None,
            seen: HashMap::new(),
            unreadable: 0,
            mismatched_key: None,
            decrypted: 0,
        });

        while !self.caught_up() {
            match tokio::time::timeout(STALL_TIMEOUT, self.next_remote()).await {
                Ok(result) => {
                    result?;
                }
                Err(_) => bail!("the server stopped sending the project before it was complete"),
            }
        }
        // One bad record is skipped, but nothing readable at all means the
        // key in the link is not the project's.
        let conn = self.conn.as_ref().context("not connected")?;
        if let Some(id) = conn.mismatched_key.clone()
            && conn.decrypted == 0
            && self.doc.oplog_vv().iter().next().is_none()
        {
            self.disconnect().await;
            bail!(
                "the project is encrypted with key {id}, but this folder has key {}; is the link complete?",
                self.key.key_id()
            );
        }
        if self.can_write() {
            self.push_local().await?;
        }
        Ok(())
    }

    /// Fetches what changed remotely into the cached doc, for commands that
    /// only read the project. The base does not move: nothing was written
    /// to the folder.
    pub async fn refresh(&mut self) -> anyhow::Result<()> {
        self.connect().await?;
        self.disconnect().await;
        self.state.save_doc(&self.doc)
    }

    pub async fn disconnect(&mut self) {
        if let Some(conn) = self.conn.take() {
            conn.client.close().await;
        }
    }

    fn conn(&mut self) -> anyhow::Result<&mut Conn> {
        self.conn.as_mut().context("not connected")
    }

    /// Whether the doc holds everything the server had when we joined.
    /// Once a record failed to decrypt, its ops (and any that build on
    /// them) can never arrive, so having been sent everything counts too.
    pub fn caught_up(&self) -> bool {
        self.conn.as_ref().is_some_and(|conn| {
            let have = self.doc.oplog_vv();
            if covers(&have, &conn.target) {
                return true;
            }
            conn.unreadable > 0
                && conn.target.iter().all(|(peer, &end)| {
                    let have = have.get(peer).copied().unwrap_or(0).max(0) as u64;
                    let seen = conn.seen.get(peer).copied().unwrap_or(0);
                    have.max(seen) >= end.max(0) as u64
                })
        })
    }

    /// Waits for the next thing from the server and handles it: imports
    /// updates, settles acks, resends refused spans when their retry is
    /// due. Fails when the connection is gone; reconnecting is up to the
    /// caller. Cancel safe.
    pub async fn next_remote(&mut self) -> anyhow::Result<RemoteEvent> {
        let retry_at = self.conn()?.retry_at;
        let event = {
            let conn = self.conn.as_mut().expect("checked above");
            match retry_at {
                Some(at) => tokio::select! {
                    event = conn.client.next_event() => Some(event?),
                    () = tokio::time::sleep_until(at.into()) => None,
                },
                None => Some(conn.client.next_event().await?),
            }
        };
        let Some(event) = event else {
            self.conn()?.retry_at = None;
            self.send_missing().await?;
            return Ok(RemoteEvent::Progress);
        };
        match event {
            Event::Update(container) => {
                let imported = self.import_container(&container)?;
                Ok(if imported {
                    RemoteEvent::Imported
                } else {
                    RemoteEvent::Progress
                })
            }
            Event::Ack { batch, status } => {
                self.on_ack(batch, status)?;
                Ok(RemoteEvent::Progress)
            }
            Event::Closed(reason) => {
                self.conn = None;
                bail!(
                    "lost the connection to the server{}",
                    reason.map(|r| format!(" ({r})")).unwrap_or_default()
                )
            }
        }
    }

    /// Decrypts and imports one container. Returns whether the doc gained
    /// ops. A record that does not decrypt (under another key, or
    /// tampered with) is skipped like the browser does, so one bad record
    /// cannot block the project.
    pub fn import_container(&mut self, container: &[u8]) -> anyhow::Result<bool> {
        let records = decode_elo_container(container).map_err(anyhow::Error::msg)?;
        let mut plaintexts = Vec::with_capacity(records.len());
        let mut received: HashMap<u64, u64> = HashMap::new();
        let mut seen: HashMap<u64, u64> = HashMap::new();
        let mut unreadable = 0;
        let mut mismatched_key = None;
        for record in records {
            if let Ok(parsed) = loro_protocol::parse_elo_record_header(record) {
                cover(&parsed.header, &mut seen);
            }
            let out = match self.key.decrypt_record(record) {
                Ok(out) => out,
                Err(err) => {
                    unreadable += 1;
                    if let CryptoError::KeyMismatch(id) = &err {
                        mismatched_key = Some(id.clone());
                    }
                    if !self.warned_unreadable {
                        self.warned_unreadable = true;
                        eprintln!(
                            "warning: skipping changes that do not decrypt with this folder's key ({err}); the browser skips them too"
                        );
                    }
                    continue;
                }
            };
            cover(&out.header, &mut received);
            plaintexts.push(out.plaintext);
        }
        if let Some(conn) = self.conn.as_mut() {
            for (peer, end) in seen {
                raise(&mut conn.seen, peer, end);
            }
            conn.unreadable += unreadable;
            conn.decrypted += plaintexts.len() as u64;
            if mismatched_key.is_some() {
                conn.mismatched_key = mismatched_key;
            }
        }
        if plaintexts.is_empty() {
            return Ok(false);
        }
        let before = self.doc.oplog_vv();
        self.doc
            .import_batch(&plaintexts)
            .context("importing remote changes")?;
        if let Some(conn) = self.conn.as_mut() {
            for (peer, end) in received {
                raise(&mut conn.server, peer, end);
            }
        }
        Ok(self.doc.oplog_vv() != before)
    }

    fn on_ack(&mut self, batch: BatchId, status: UpdateStatusCode) -> anyhow::Result<()> {
        let conn = self.conn()?;
        let Some(container) = conn.in_flight.remove(&batch) else {
            return Ok(());
        };
        match status {
            UpdateStatusCode::Ok => {
                conn.deltas += delta_count(&container) as u64;
                Ok(())
            }
            UpdateStatusCode::RateLimited
            | UpdateStatusCode::FragmentTimeout
            | UpdateStatusCode::Unknown => {
                // The ops are still in the doc; forget that the server has
                // them so the retry sends them again.
                for record in decode_elo_container(&container).unwrap_or_default() {
                    if let Ok(parsed) = loro_protocol::parse_elo_record_header(record)
                        && let EloHeader::Delta(delta) = parsed.header
                        && let Some(peer) = parse_peer_id(&delta.peer_id)
                    {
                        let known = conn.server.entry(peer).or_default();
                        if delta.start < *known {
                            *known = delta.start;
                        }
                    }
                }
                conn.retry_at
                    .get_or_insert_with(|| Instant::now() + RETRY_DELAY);
                Ok(())
            }
            UpdateStatusCode::PermissionDenied => {
                bail!("the server refused the changes: this link is view-only")
            }
            other if is_snapshot(&container) => {
                // Every delta the snapshot would replace is stored, so
                // only the compaction is lost; trying again would hit the
                // same limit.
                self.compaction_refused = true;
                eprintln!(
                    "warning: the server refused to compact the project's log ({other:?}); it keeps the uncompacted log"
                );
                Ok(())
            }
            other => bail!("the server refused the changes ({other:?})"),
        }
    }

    /// Sends every op the server does not have yet, as delta records
    /// packed into containers of at most [`CONTAINER_BUDGET`].
    async fn send_missing(&mut self) -> anyhow::Result<()> {
        if !self.can_write() {
            return Ok(());
        }
        let vv = self.doc.oplog_vv();
        let conn = self.conn.as_mut().context("not connected")?;
        let mut spans: Vec<(u64, u64, u64)> = vv
            .iter()
            .filter_map(|(&peer, &end)| {
                let end = end.max(0) as u64;
                let start = conn.server.get(&peer).copied().unwrap_or(0);
                (end > start).then_some((peer, start, end))
            })
            .collect();
        spans.sort_unstable();
        let mut records = Vec::new();
        for (peer, start, end) in spans {
            encrypt_span(&self.doc, &self.key, peer, start, end, &mut records)?;
            raise(&mut conn.server, peer, end);
        }
        let records: Vec<&[u8]> = records.iter().map(Vec::as_slice).collect();
        for container in pack(&records, CONTAINER_BUDGET) {
            let id = conn.client.send_update(&container).await?;
            conn.in_flight.insert(id, container);
        }
        Ok(())
    }

    /// Sends local ops the server lacks and waits until every batch is
    /// acked, resending refused ones. Then compacts when due.
    pub async fn push_local(&mut self) -> anyhow::Result<()> {
        if !self.can_write() {
            return Ok(());
        }
        self.send_missing().await?;
        self.wait_for_acks().await?;
        self.maybe_compact().await
    }

    async fn wait_for_acks(&mut self) -> anyhow::Result<()> {
        loop {
            let conn = self.conn()?;
            if conn.in_flight.is_empty() && conn.retry_at.is_none() {
                return Ok(());
            }
            match tokio::time::timeout(STALL_TIMEOUT, self.next_remote()).await {
                Ok(result) => {
                    result?;
                }
                Err(_) => bail!("the server did not confirm the changes in time"),
            }
        }
    }

    /// The server cannot compact what it cannot read, so writers replace
    /// its deltas with an encrypted snapshot now and then. It only accepts
    /// one that covers everything it holds, hence the push right before.
    async fn maybe_compact(&mut self) -> anyhow::Result<()> {
        let wanted = self.can_write() && !self.compaction_refused;
        let conn = self.conn()?;
        if !wanted || conn.snapshot_sent || conn.deltas < COMPACT_AFTER_DELTAS {
            return Ok(());
        }
        conn.snapshot_sent = true;
        let vv: Vec<(u64, u64)> = self
            .doc
            .oplog_vv()
            .iter()
            .map(|(&peer, &counter)| (peer, counter.max(0) as u64))
            .collect();
        let snapshot = self
            .doc
            .export(ExportMode::Snapshot)
            .context("exporting a snapshot")?;
        let record = self.key.encrypt_snapshot(&vv, &snapshot);
        let container = encode_container(&[&record]);
        let conn = self.conn()?;
        let id = conn.client.send_update(&container).await?;
        conn.in_flight.insert(id, container);
        conn.deltas = 0;
        self.wait_for_acks().await
    }

    /// The plaintext of the asset with ciphertext `hash`, from the cache or
    /// the server. Records its digest in the base's asset map.
    pub async fn asset_bytes(&mut self, hash: &str) -> anyhow::Result<Vec<u8>> {
        if let Some(bytes) = self.state.read_blob(hash) {
            let digest = crate::worktree::digest(&bytes);
            self.base.assets.insert(hash.to_owned(), digest);
            return Ok(bytes);
        }
        let sealed = self.api.get_blob(&self.config.token, hash).await?;
        let bytes = self
            .key
            .open(&sealed, BLOB_CONTEXT)
            .with_context(|| format!("asset {hash} does not decrypt with this project's key"))?;
        self.state.write_blob(hash, &bytes)?;
        self.base
            .assets
            .insert(hash.to_owned(), crate::worktree::digest(&bytes));
        Ok(bytes)
    }

    /// The bytes a doc entry stands for on disk.
    pub async fn content_bytes(&mut self, content: &FileContent) -> anyhow::Result<Vec<u8>> {
        match content {
            FileContent::Text(text) => Ok(text.as_bytes().to_vec()),
            FileContent::Asset { hash, .. } => self.asset_bytes(hash).await,
        }
    }

    /// `sha256:<hex>` of the plaintext a doc entry stands for.
    async fn content_digest(&mut self, content: &FileContent) -> anyhow::Result<String> {
        match content {
            FileContent::Text(text) => Ok(crate::worktree::digest(text.as_bytes())),
            FileContent::Asset { hash, .. } => {
                if let Some(digest) = self.base.assets.get(hash) {
                    return Ok(digest.clone());
                }
                self.asset_bytes(hash).await?;
                Ok(self.base.assets[hash].clone())
            }
        }
    }

    async fn same_content(&mut self, a: &FileContent, b: &FileContent) -> anyhow::Result<bool> {
        if a == b {
            return Ok(true);
        }
        Ok(self.content_digest(a).await? == self.content_digest(b).await?)
    }

    /// Encrypts and uploads a local file, or reuses a blob we already know
    /// with the same plaintext.
    async fn upload_asset(&mut self, path: &str, file: &LocalFile) -> anyhow::Result<FileContent> {
        let known = self
            .base
            .assets
            .iter()
            .find(|(_, digest)| **digest == file.digest)
            .map(|(hash, _)| hash.clone());
        let hash = match known {
            Some(hash) => hash,
            None => {
                let bytes = self
                    .worktree
                    .read_bytes(path)?
                    .with_context(|| format!("{path} disappeared while syncing"))?;
                if crate::worktree::digest(&bytes) != file.digest {
                    bail!("{path} changed while syncing; run the command again");
                }
                if bytes.len() > MAX_ASSET_BYTES {
                    bail!("{path} is too large to upload");
                }
                let sealed = self.key.seal(&bytes, BLOB_CONTEXT);
                let stored = self.api.upload_blob(&self.config.token, sealed).await?;
                self.state.write_blob(&stored.hash, &bytes)?;
                self.base
                    .assets
                    .insert(stored.hash.clone(), file.digest.clone());
                stored.hash
            }
        };
        Ok(FileContent::Asset {
            hash,
            size: file.size,
            mime: mime_for(path).to_owned(),
        })
    }

    /// The files at the base: what the folder held after the last sync,
    /// each file as of the doc state its copy on disk matches.
    pub fn base_files(&self) -> anyhow::Result<Files> {
        let mut files = if self.base.frontiers()? == self.doc.oplog_frontiers() {
            self.remote_files()
        } else {
            to_map(materialize(&self.fork_base()?))
        };
        let mut pinned: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (path, state) in &self.base.pins {
            pinned.entry(state).or_default().push(path);
        }
        for (state, paths) in pinned {
            let then = to_map(materialize(&self.fork_at(state)?));
            for path in paths {
                match then.get(path) {
                    Some(content) => files.insert(path.to_owned(), content.clone()),
                    None => files.remove(path),
                };
            }
        }
        Ok(files)
    }

    /// A doc at the base state that can be edited without touching ours.
    pub fn fork_base(&self) -> anyhow::Result<LoroDoc> {
        self.fork_at(&self.base.frontiers)
    }

    /// A doc at an encoded state from the base, see [`Base::state_of`].
    fn fork_at(&self, state: &str) -> anyhow::Result<LoroDoc> {
        let frontiers = decode_frontiers(state)?;
        // Forking at the empty version makes Loro walk back every op, which
        // takes seconds on big projects, for a result we know is empty.
        if frontiers.is_empty() {
            return Ok(LoroDoc::new());
        }
        self.doc.fork_at(&frontiers).context(
            "the cached doc does not contain the last synced state; clone the project again",
        )
    }

    /// Whether git moved HEAD to another branch, or reset it, since the
    /// folder last matched the base. Files may then differ from it without
    /// anyone having edited them.
    pub fn git_switched(&self) -> bool {
        let Some(then) = &self.base.git else {
            return false;
        };
        Repo::discover(self.root()).is_some_and(|repo| repo.switched_since(then))
    }

    /// The files in the doc as it is now.
    pub fn remote_files(&self) -> Files {
        to_map(materialize(&self.doc))
    }

    /// Reads the local side: every file for [`Scope::Full`], else the
    /// listed paths plus `extra`, with everything else taken as base.
    fn read_local(
        &self,
        scope: &Scope,
        base: &Files,
        extra: &BTreeSet<String>,
    ) -> anyhow::Result<(BTreeMap<String, Local>, Vec<Skipped>)> {
        let mut local: BTreeMap<String, Local> = BTreeMap::new();
        let mut skipped = Vec::new();
        match scope {
            Scope::Full => {
                let scan = self.worktree.scan()?;
                for (path, file) in scan.files {
                    local.insert(path, Local::File(file));
                }
                skipped = scan.skipped;
                // A synced file that the scan did not return but that is
                // still on disk was ignored or turned into something we do
                // not sync. Either way the user did not delete it. An
                // ignored one that is gone was never ours to delete, e.g. a
                // .gitignore uploaded in the browser that was never written.
                for path in base.keys() {
                    if !local.contains_key(path)
                        && (self.worktree.exists(path) || self.worktree.is_ignored(path, false))
                    {
                        local.insert(path.clone(), Local::AsBase);
                    }
                }
            }
            Scope::Paths(paths) => {
                for path in base.keys() {
                    local.insert(path.clone(), Local::AsBase);
                }
                for path in paths.iter().chain(extra) {
                    let under = format!("{path}/");
                    // A listed folder covers the base files inside it.
                    let inside: Vec<String> = base
                        .keys()
                        .filter(|p| p.starts_with(&under))
                        .cloned()
                        .collect();
                    for p in inside.iter().chain(std::iter::once(path)) {
                        self.read_one(p, base, &mut local)?;
                    }
                }
            }
        }
        Ok((local, skipped))
    }

    fn read_one(
        &self,
        path: &str,
        base: &Files,
        local: &mut BTreeMap<String, Local>,
    ) -> anyhow::Result<()> {
        local.remove(path);
        if self.worktree.is_ignored(path, false) {
            if base.contains_key(path) {
                local.insert(path.to_owned(), Local::AsBase);
            }
            return Ok(());
        }
        match self.worktree.read(path)? {
            Some(file) => {
                local.insert(path.to_owned(), Local::File(file));
            }
            None if self.worktree.exists(path) && base.contains_key(path) => {
                local.insert(path.to_owned(), Local::AsBase);
            }
            None => {}
        }
        Ok(())
    }

    /// Whether the local file holds `content`.
    async fn local_is(&mut self, file: &LocalFile, content: &FileContent) -> anyhow::Result<bool> {
        if let FileContent::Text(text) = content
            && let Some(local) = &file.text
        {
            return Ok(local == text);
        }
        Ok(self.content_digest(content).await? == file.digest)
    }

    async fn local_changes(
        &mut self,
        base: &Files,
        local: &BTreeMap<String, Local>,
    ) -> anyhow::Result<BTreeMap<String, ChangeKind>> {
        let mut changes = BTreeMap::new();
        for (path, content) in base {
            match local.get(path) {
                None => {
                    changes.insert(path.clone(), ChangeKind::Deleted);
                }
                Some(Local::File(file)) => {
                    if !self.local_is(file, content).await? {
                        changes.insert(path.clone(), ChangeKind::Modified);
                    }
                }
                Some(Local::AsBase) => {}
            }
        }
        for (path, entry) in local {
            if matches!(entry, Local::File(_)) && !base.contains_key(path) {
                changes.insert(path.clone(), ChangeKind::Added);
            }
        }
        Ok(changes)
    }

    async fn remote_changes(
        &mut self,
        base: &Files,
        remote: &Files,
    ) -> anyhow::Result<BTreeMap<String, ChangeKind>> {
        let mut changes = BTreeMap::new();
        for (path, before) in base {
            match remote.get(path) {
                None => {
                    changes.insert(path.clone(), ChangeKind::Deleted);
                }
                Some(after) => {
                    if !self.same_content(before, after).await? {
                        changes.insert(path.clone(), ChangeKind::Modified);
                    }
                }
            }
        }
        for path in remote.keys() {
            if !base.contains_key(path) {
                changes.insert(path.clone(), ChangeKind::Added);
            }
        }
        Ok(changes)
    }

    /// Local and remote changes since the base, without touching anything.
    pub async fn status(&mut self, scope: &Scope) -> anyhow::Result<Status> {
        let base = self.base_files()?;
        let remote = self.remote_files();
        let remote_changes = self.remote_changes(&base, &remote).await?;
        let extra = remote_changes.keys().cloned().collect();
        let (local, skipped) = self.read_local(scope, &base, &extra)?;
        let local_changes = self.local_changes(&base, &local).await?;
        Ok(Status {
            local: local_changes,
            remote: remote_changes,
            skipped,
        })
    }

    /// One sync step between the folder and the doc; see [`Mode`]. Push
    /// mode sends the result and waits for the server to confirm it, so
    /// it needs a connection when there is anything to send. The base and
    /// the cached doc are saved at the end.
    pub async fn reconcile(&mut self, scope: &Scope, mode: Mode) -> anyhow::Result<Report> {
        self.reconcile_with(scope, mode, true).await
    }

    /// [`Self::reconcile`] for callers that send and save on their own
    /// schedule, like the live mode, which keeps editing while offline and
    /// throttles writes of the cached doc. New ops only land in the doc and
    /// go out with the next push or connect.
    pub async fn reconcile_live(&mut self, scope: &Scope, mode: Mode) -> anyhow::Result<Report> {
        self.reconcile_with(scope, mode, false).await
    }

    /// `flush`: in push mode, send new ops and wait for the acks, then
    /// persist the doc and the base.
    async fn reconcile_with(
        &mut self,
        scope: &Scope,
        mode: Mode,
        flush: bool,
    ) -> anyhow::Result<Report> {
        // Taken before the folder is read: a checkout during the reconcile
        // must not be vouched for.
        let git = Repo::discover(self.root()).map(|repo| repo.mark());
        let base = self.base_files()?;
        let remote = self.remote_files();
        let remote_changes = self.remote_changes(&base, &remote).await?;
        let extra = remote_changes.keys().cloned().collect();
        let (mut local, skipped) = self.read_local(scope, &base, &extra)?;
        let dropped = self.case_dropped(&base, &remote, &local);
        for path in &dropped {
            // Reading it would read its case variant's bytes. Taken as
            // unchanged, it is neither published, deleted nor written.
            local.insert(path.clone(), Local::AsBase);
        }
        let mut local_changes = self.local_changes(&base, &local).await?;

        // A local file that already equals the remote one is the remote
        // change on disk (an interrupted pull, a co-author's identical fix),
        // not an edit of ours. Applying it again would duplicate it.
        let mut same_on_both = BTreeSet::new();
        for path in local_changes.keys() {
            let same = match (local.get(path), remote.get(path)) {
                (Some(Local::File(file)), Some(content)) => self.local_is(file, content).await?,
                (None, None) => true,
                _ => false,
            };
            if same && remote_changes.contains_key(path) {
                same_on_both.insert(path.clone());
            }
        }
        local_changes.retain(|path, _| !same_on_both.contains(path));

        let mut report = Report {
            status: Status {
                local: local_changes.clone(),
                remote: remote_changes.clone(),
                skipped,
            },
            ..Report::default()
        };
        let both: Vec<String> = local_changes
            .keys()
            .filter(|path| remote_changes.contains_key(*path))
            .cloned()
            .collect();

        // The folder ends up matching this state, except for the files in
        // `kept`. Ops that arrive while we wait for acks are left for the
        // next run, which sees them as remote changes on top of this base.
        let (synced, kept) = match mode {
            Mode::Pull => {
                let targets: BTreeSet<String> = remote_changes
                    .keys()
                    .filter(|path| !both.contains(path))
                    .cloned()
                    .collect();
                let frontiers = self.doc.oplog_frontiers();
                let mut kept = self
                    .write_back(
                        &remote,
                        &base,
                        &local,
                        &local_changes,
                        Some(&targets),
                        &dropped,
                        &mut report,
                    )
                    .await?;
                kept.extend(both.iter().cloned());
                report.conflicts = both;
                (frontiers, kept)
            }
            Mode::Push => {
                if !local_changes.is_empty() {
                    if !self.can_write() {
                        bail!(
                            "this folder is linked with a view-only link, so its {} local change(s) cannot be pushed",
                            local_changes.len()
                        );
                    }
                    // Whatever can fail before the local changes are in the
                    // doc fails here, so a retry starts from scratch.
                    for path in remote_changes.keys() {
                        let writable = match local.get(path) {
                            Some(Local::File(_)) => true,
                            Some(Local::AsBase) => false,
                            None => !self.worktree.exists(path),
                        };
                        if writable && remote.contains_key(path) && !dropped.contains(path) {
                            self.worktree.check_writable(path)?;
                        }
                    }
                    let contents = self.local_contents(&base, &local, &local_changes).await?;
                    report.applied = self.apply_local(contents)?;
                    if report.applied.changed {
                        // The base now says the folder holds the local
                        // changes. Saved before anything goes out or gets
                        // written, a failure from here on can never make a
                        // later run apply the same edits a second time.
                        self.save()?;
                    }
                }
                let merged = self.remote_files();
                let frontiers = self.doc.oplog_frontiers();
                if report.applied.changed && flush {
                    self.push_local().await?;
                }
                report.merged = both;
                let kept = self
                    .write_back(
                        &merged,
                        &base,
                        &local,
                        &local_changes,
                        None,
                        &dropped,
                        &mut report,
                    )
                    .await?;
                (frontiers, kept)
            }
        };

        let synced = encode_frontiers(&synced);
        self.base.pins = kept
            .iter()
            .map(|path| (path.clone(), self.base.state_of(path).to_owned()))
            .filter(|(_, state)| *state != synced)
            .collect();
        self.base.frontiers = synced;
        self.base.touch();
        // A pull that leaves local changes behind does not vouch for them,
        // so a branch switch before it is still noticed afterwards.
        if mode == Mode::Push || report.status.local.is_empty() {
            self.base.git = git;
        }
        if flush {
            self.save()?;
        }
        Ok(report)
    }

    /// Paths that only differ in case from another path of the project.
    /// A case-insensitive file system holds one file for all of them, so
    /// only one is synced: the one on disk under its exact name, if any.
    fn case_dropped(
        &self,
        base: &Files,
        remote: &Files,
        local: &BTreeMap<String, Local>,
    ) -> BTreeSet<String> {
        if !self.worktree.case_insensitive() {
            return BTreeSet::new();
        }
        let paths: BTreeSet<&str> = base
            .keys()
            .chain(remote.keys())
            .chain(local.keys())
            .map(String::as_str)
            .collect();
        case_clashes(paths, |path| self.worktree.exists_exact(path))
            .into_iter()
            .map(|(_, dropped)| dropped)
            .collect()
    }

    /// What each locally changed path should hold in the doc; None for
    /// deleted files. Uploads new assets.
    async fn local_contents(
        &mut self,
        base: &Files,
        local: &BTreeMap<String, Local>,
        changes: &BTreeMap<String, ChangeKind>,
    ) -> anyhow::Result<BTreeMap<String, Option<FileContent>>> {
        let mut out = BTreeMap::new();
        for path in changes.keys() {
            let Some(Local::File(file)) = local.get(path) else {
                out.insert(path.clone(), None);
                continue;
            };
            // An existing file keeps its kind as long as its content allows,
            // so an SVG uploaded as an asset does not turn into text.
            let as_text = match base.get(path) {
                Some(FileContent::Asset { .. }) => None,
                _ => file.text.clone(),
            };
            let content = match as_text {
                Some(text) => FileContent::Text(text),
                None => self.upload_asset(path, file).await?,
            };
            out.insert(path.clone(), Some(content));
        }
        Ok(out)
    }

    /// Applies local changes to forks of the doc states the files on disk
    /// match, imports the resulting ops into the doc, where they merge with
    /// whatever happened remotely, and moves the base to the states that
    /// now include them.
    fn apply_local(
        &mut self,
        changes: BTreeMap<String, Option<FileContent>>,
    ) -> anyhow::Result<ApplyReport> {
        let mut groups: BTreeMap<String, BTreeMap<String, Option<FileContent>>> = BTreeMap::new();
        for (path, content) in changes {
            groups
                .entry(self.base.state_of(&path).to_owned())
                .or_default()
                .insert(path, content);
        }
        let main = self.base.frontiers.clone();
        let mut report = ApplyReport::default();
        for (state, changes) in groups {
            let pinned = state != main;
            let fork = self.fork_at(&state)?;
            if pinned {
                // Our peer's counters are ahead of this older state, so it
                // gets a peer of its own.
                fork.set_peer_id(random_peer())?;
            } else {
                // Ops continue our peer's counters only if the fork has all
                // of them; otherwise it would reuse ids the doc already holds.
                let peer = self.doc.peer_id();
                let ours = |vv: &VersionVector| vv.get(&peer).copied().unwrap_or(0);
                if ours(&fork.oplog_vv()) != ours(&self.doc.oplog_vv()) {
                    self.doc.set_peer_id(random_peer())?;
                }
                fork.set_peer_id(self.doc.peer_id())?;
            }
            configure(&fork);
            let mut files = to_map(materialize(&fork));
            for (path, content) in &changes {
                match content {
                    Some(content) => files.insert(path.clone(), content.clone()),
                    None => files.remove(path),
                };
            }
            let desired: Vec<MaterializedFile> = files
                .into_iter()
                .map(|(path, content)| MaterializedFile { path, content })
                .collect();
            let applied = apply_files(&fork, &desired, PUSH_MESSAGE)?;
            if applied.changed {
                set_peer_info(&fork, &self.identity)?;
                let updates = fork
                    .export(ExportMode::updates(&self.doc.oplog_vv()))
                    .context("exporting local changes")?;
                self.doc.import(&updates).context("merging local changes")?;
                let now = encode_frontiers(&fork.oplog_frontiers());
                if pinned {
                    for path in changes.keys() {
                        self.base.pins.insert(path.clone(), now.clone());
                    }
                } else {
                    self.base.frontiers = now;
                }
            }
            report.extend(applied);
        }
        Ok(report)
    }

    /// Makes the folder match `fin`. `targets` limits which paths may be
    /// written (a pull only writes remote changes). Never writes over a
    /// file that is not in the base, never deletes one, and keeps a locally
    /// edited file that was deleted remotely. Returns the paths it left
    /// alone because they changed on disk since they were read.
    #[allow(clippy::too_many_arguments)]
    async fn write_back(
        &mut self,
        fin: &Files,
        base: &Files,
        local: &BTreeMap<String, Local>,
        local_changes: &BTreeMap<String, ChangeKind>,
        targets: Option<&BTreeSet<String>>,
        dropped: &BTreeSet<String>,
        report: &mut Report,
    ) -> anyhow::Result<BTreeSet<String>> {
        let paths: BTreeSet<String> = fin
            .keys()
            .chain(base.keys())
            .chain(local.keys())
            .filter(|p| targets.is_none_or(|t| t.contains(*p)))
            .cloned()
            .collect();

        let mut writes = Vec::new();
        let mut deletes = Vec::new();
        for path in paths {
            if dropped.contains(&path) {
                let changed = match (base.get(&path), fin.get(&path)) {
                    (Some(before), Some(after)) => !self.same_content(before, after).await?,
                    (before, after) => before.is_some() != after.is_some(),
                };
                if changed {
                    report.warnings.push(format!(
                        "{path} differs from another file of the project only in case, which this file system cannot tell apart; not syncing it"
                    ));
                }
                continue;
            }
            match (fin.get(&path), local.get(&path)) {
                (Some(content), Some(Local::File(file))) => {
                    if !self.local_is(file, content).await? {
                        writes.push((path, content.clone()));
                    }
                }
                (Some(content), None) => {
                    // Something this folder does not sync, or a name that
                    // only differs in case, which is the same file here.
                    if self.worktree.is_ignored(&path, false) {
                        report.warnings.push(format!(
                            "{path} is in the project but ignored here; not writing it"
                        ));
                    } else if self.worktree.exists(&path) {
                        report.warnings.push(format!(
                            "{path} is new in the project, but a file that is not synced (ignored, too large, a symlink, or the same name in other case) is in its place; not writing it"
                        ));
                    } else {
                        writes.push((path, content.clone()));
                    }
                }
                (Some(content), Some(Local::AsBase)) => {
                    let unchanged = match base.get(&path) {
                        Some(before) => self.same_content(before, content).await?,
                        None => false,
                    };
                    if !unchanged {
                        report.warnings.push(format!(
                            "{path} changed remotely but is ignored or not a regular file here; not writing it"
                        ));
                    }
                }
                (None, Some(Local::File(_))) if base.contains_key(&path) => {
                    if local_changes.contains_key(&path) {
                        report.warnings.push(format!(
                            "{path} was deleted remotely but has local edits; kept it"
                        ));
                    } else {
                        deletes.push(path);
                    }
                }
                (None, _) => {}
            }
        }

        for (path, _) in &writes {
            self.worktree.check_writable(path)?;
        }
        let mut kept = BTreeSet::new();
        for path in deletes {
            if self.changed_on_disk(&path, local) {
                report.warnings.push(format!(
                    "{path} was deleted remotely but changed on disk meanwhile; kept it"
                ));
                kept.insert(path);
                continue;
            }
            self.worktree.remove(&path)?;
            report.deleted.push(path);
        }
        for (path, content) in writes {
            let bytes = self.content_bytes(&content).await?;
            if let Some(hook) = &mut self.before_write {
                hook(&path);
            }
            // A one-shot push read the folder before it waited for the
            // server, and an editor may have saved since. Writing the merge
            // now would throw that save away.
            if self.changed_on_disk(&path, local) {
                report.warnings.push(format!(
                    "{path} changed on disk while syncing; left it as it is, the next sync merges it"
                ));
                kept.insert(path);
                continue;
            }
            self.worktree.write(&path, &bytes)?;
            report.written.push(path);
        }
        Ok(kept)
    }

    /// Whether `path` on disk is no longer what [`Self::read_local`] saw.
    fn changed_on_disk(&self, path: &str, local: &BTreeMap<String, Local>) -> bool {
        let then = match local.get(path) {
            Some(Local::File(file)) => Some(file.digest.as_str()),
            _ => None,
        };
        match self.worktree.read_bytes(path) {
            Ok(now) => now.map(|bytes| crate::worktree::digest(&bytes)).as_deref() != then,
            Err(_) => true,
        }
    }
}

/// Writes our name and color into `peers` under the doc's peer id, so the
/// history panel can say who made an edit.
pub fn set_peer_info(doc: &LoroDoc, identity: &Identity) -> anyhow::Result<()> {
    Ok(set_peer(doc, &identity.name, &identity.color)?)
}

/// Encrypts ops `[start, end)` of `peer` into delta records. A span whose
/// updates exceed the container budget is split in halves until each part
/// fits or is a single op, so a big initial import never produces one
/// update larger than the server accepts.
fn encrypt_span(
    doc: &LoroDoc,
    key: &ProjectKey,
    peer: u64,
    start: u64,
    end: u64,
    out: &mut Vec<Vec<u8>>,
) -> anyhow::Result<()> {
    let span = IdSpan::new(peer, start as i32, end as i32);
    let plaintext = doc
        .export(ExportMode::updates_in_range(vec![span]))
        .context("exporting local ops")?;
    if plaintext.len() > CONTAINER_BUDGET && end - start > 1 {
        let mid = start + (end - start) / 2;
        encrypt_span(doc, key, peer, start, mid, out)?;
        return encrypt_span(doc, key, peer, mid, end, out);
    }
    out.push(key.encrypt_delta(peer, start, end, &plaintext));
    Ok(())
}

/// Raises `map` to the op ranges a record header says it covers.
fn cover(header: &EloHeader, map: &mut HashMap<u64, u64>) {
    match header {
        EloHeader::Delta(delta) => {
            if let Some(peer) = parse_peer_id(&delta.peer_id) {
                raise(map, peer, delta.end);
            }
        }
        EloHeader::Snapshot(snapshot) => {
            for (peer, counter) in &snapshot.vv {
                if let Some(peer) = parse_peer_id(peer) {
                    raise(map, peer, *counter);
                }
            }
        }
    }
}

fn is_snapshot(container: &[u8]) -> bool {
    decode_elo_container(container)
        .unwrap_or_default()
        .into_iter()
        .any(|record| {
            loro_protocol::parse_elo_record_header(record)
                .is_ok_and(|parsed| matches!(parsed.header, EloHeader::Snapshot(_)))
        })
}

fn delta_count(container: &[u8]) -> usize {
    decode_elo_container(container)
        .unwrap_or_default()
        .into_iter()
        .filter(|record| record.first() == Some(&(EloRecordKind::DeltaSpan as u8)))
        .count()
}

fn raise(map: &mut HashMap<u64, u64>, peer: u64, end: u64) {
    let entry = map.entry(peer).or_default();
    *entry = (*entry).max(end);
}

fn covers(have: &VersionVector, target: &VersionVector) -> bool {
    target
        .iter()
        .all(|(peer, &end)| have.get(peer).copied().unwrap_or(0) >= end)
}

/// Loro reserves `u64::MAX`; JS clients also only ever see ids below 2^63.
fn random_peer() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    u64::from_le_bytes(bytes) >> 1
}

fn to_map(files: Vec<MaterializedFile>) -> Files {
    files.into_iter().map(|f| (f.path, f.content)).collect()
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
        assert_eq!(Identity::new(&"x".repeat(100)).name.len(), MAX_NAME_CHARS);
    }

    #[test]
    fn splits_large_spans() {
        let doc = LoroDoc::new();
        doc.set_peer_id(7).unwrap();
        let text = doc.get_text("t");
        // Random-ish text compresses badly, so the export stays large.
        let body: String = (0..1_100_000u64)
            .map(|i| char::from(b'a' + ((i * 7919 + i / 13) % 26) as u8))
            .collect();
        text.insert(0, &body).unwrap();
        doc.commit();
        let end = *doc.oplog_vv().get(&7).unwrap() as u64;
        let key =
            ProjectKey::from_base64url("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").unwrap();
        let mut records = Vec::new();
        encrypt_span(&doc, &key, 7, 0, end, &mut records).unwrap();
        assert!(records.len() > 1);

        let copy = LoroDoc::new();
        let plaintexts: Vec<Vec<u8>> = records
            .iter()
            .map(|r| key.decrypt_record(r).unwrap().plaintext)
            .collect();
        copy.import_batch(&plaintexts).unwrap();
        assert_eq!(copy.get_text("t").to_string(), body);
    }
}
