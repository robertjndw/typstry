//! The three-way merge between the base, the folder and the doc.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::{Context, bail};
use loro::{ExportMode, Frontiers, LoroDoc, VersionVector};
use typstry_doc::apply::{ApplyReport, apply_changes};
use typstry_doc::configure;
use typstry_doc::materialize::{FileContent, MaterializedFile, materialize};
use typstry_doc::paths::entries_under;

use crate::git::{GitMark, Repo};
use crate::hash::Digest;
use crate::state::Base;
use crate::worktree::{LocalFile, Skipped, case_clashes};

use super::{
    ChangeKind, Files, Flush, Mode, Reconciled, Report, Scope, Session, Status, random_peer,
    set_peer_info,
};

/// Commit message of the changes a push makes, so history can tell them
/// from browser edits.
const PUSH_MESSAGE: &str = "cli push";

/// The inputs of a reconcile once both sides are read, for the steps that
/// write the result.
struct Plan {
    base: Arc<Files>,
    local: LocalSide,
    local_changes: BTreeMap<String, ChangeKind>,
    remote_changes: BTreeMap<String, ChangeKind>,
    /// Paths that only differ in case from another one, which this file
    /// system cannot hold both of; see [`Session::case_dropped`].
    dropped: BTreeSet<String>,
}

struct Sides {
    base: Arc<Files>,
    remote: Arc<Files>,
    local: LocalSide,
    skipped: Vec<Skipped>,
    remote_changes: BTreeMap<String, ChangeKind>,
}

/// What the base files are a function of: the doc state the folder
/// matches, and the earlier states of pinned files.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BaseKey {
    frontiers: Frontiers,
    pins: BTreeMap<String, Frontiers>,
}

impl BaseKey {
    fn of(base: &Base) -> Self {
        Self {
            frontiers: base.frontiers.clone(),
            pins: base.pins.clone(),
        }
    }

    fn is_of(&self, base: &Base) -> bool {
        self.frontiers == base.frontiers && self.pins == base.pins
    }

    fn state_of(&self, path: &str) -> &Frontiers {
        self.pins.get(path).unwrap_or(&self.frontiers)
    }
}

/// The base files for one [`BaseKey`]. History never changes, so they stay
/// right for as long as the base does, and materializing them takes a
/// fork of the doc as soon as remote ops are past the base.
#[derive(Debug)]
pub(super) struct BaseFiles {
    key: BaseKey,
    /// The files at `key.frontiers`, before putting in pinned ones.
    unpinned: Arc<Files>,
    files: Arc<Files>,
}

/// What a local path holds as far as a reconcile is concerned.
#[derive(Debug, Clone)]
enum Local {
    File(LocalFile),
    /// Exists on disk but is not synced (ignored, a symlink, unreadable)
    /// or was not looked at: treated as unchanged since the base.
    AsBase,
}

static AS_BASE: Local = Local::AsBase;

/// The folder as a reconcile read it.
#[derive(Debug)]
enum LocalSide {
    /// A scan: a path missing here is not on disk.
    Full(BTreeMap<String, Local>),
    /// Only the paths in `read` were looked at. Every other base file is
    /// taken as unchanged, without listing them all.
    Partial {
        files: BTreeMap<String, Local>,
        read: BTreeSet<String>,
    },
}

impl LocalSide {
    fn get<'a>(&'a self, path: &str, base: &Files) -> Option<&'a Local> {
        match self {
            Self::Full(files) => files.get(path),
            Self::Partial { files, read } => files
                .get(path)
                .or_else(|| (!read.contains(path) && base.contains_key(path)).then_some(&AS_BASE)),
        }
    }

    /// What was found on disk.
    fn files(&self) -> &BTreeMap<String, Local> {
        match self {
            Self::Full(files) | Self::Partial { files, .. } => files,
        }
    }

    fn insert(&mut self, path: String, local: Local) {
        match self {
            Self::Full(files) | Self::Partial { files, .. } => files.insert(path, local),
        };
    }

    /// The paths that may differ from the base: all of them after a scan,
    /// else the ones looked at.
    fn candidates<'a>(&'a self, base: &'a Files) -> BTreeSet<&'a str> {
        match self {
            Self::Full(files) => base
                .keys()
                .chain(files.keys())
                .map(String::as_str)
                .collect(),
            Self::Partial { files, read } => read
                .iter()
                .chain(files.keys())
                .map(String::as_str)
                .collect(),
        }
    }
}

impl Session {
    /// The files at the base: what the folder held after the last sync,
    /// each file as of the doc state its copy on disk matches.
    pub fn base_files(&self) -> anyhow::Result<Arc<Files>> {
        Ok(self.base_entry()?.1)
    }

    /// The files at the base's frontiers and the base files, from the
    /// cache when the base did not move since.
    fn base_entry(&self) -> anyhow::Result<(Arc<Files>, Arc<Files>)> {
        if let Some(cached) = self.base_files.lock().expect("never poisoned").as_ref()
            && cached.key.is_of(&self.base)
        {
            return Ok((Arc::clone(&cached.unpinned), Arc::clone(&cached.files)));
        }
        let unpinned = Arc::new(if !self.doc_past_base() {
            self.remote_files()
        } else {
            to_map(materialize(&self.fork_base()?))
        });
        let files = self.pin_files(Arc::clone(&unpinned), None)?;
        self.remember_base(Arc::clone(&unpinned), Arc::clone(&files));
        Ok((unpinned, files))
    }

    fn remember_base(&self, unpinned: Arc<Files>, files: Arc<Files>) {
        *self.base_files.lock().expect("never poisoned") = Some(BaseFiles {
            key: BaseKey::of(&self.base),
            unpinned,
            files,
        });
    }

    /// Whether the doc holds ops past the base's frontiers, i.e. remote
    /// changes beyond what the folder was last synced to.
    pub fn doc_past_base(&self) -> bool {
        self.base.frontiers != self.doc.oplog_frontiers()
    }

    /// Turns the files at the base's frontiers into the base files by
    /// putting in the pinned files as of their states. `known` is an
    /// earlier base and its files, which already hold the pinned files
    /// whose state did not change, so only the others take a fork.
    fn pin_files(
        &self,
        mut shared: Arc<Files>,
        known: Option<(&BaseKey, &Files)>,
    ) -> anyhow::Result<Arc<Files>> {
        if self.base.pins.is_empty() {
            return Ok(shared);
        }
        let files = Arc::make_mut(&mut shared);
        let mut to_fork = Vec::new();
        for (path, state) in &self.base.pins {
            if let Some((then, then_files)) = known
                && then.state_of(path) == state
            {
                match then_files.get(path) {
                    Some(content) => files.insert(path.clone(), content.clone()),
                    None => files.remove(path),
                };
            } else {
                to_fork.push((state, path.as_str()));
            }
        }
        for (state, paths) in group_by_state::<_, Vec<_>>(to_fork) {
            let then = to_map(materialize(&self.fork_at(state)?));
            for path in paths {
                match then.get(path) {
                    Some(content) => files.insert(path.to_owned(), content.clone()),
                    None => files.remove(path),
                };
            }
        }
        Ok(shared)
    }

    /// A doc at the base state that can be edited without touching ours.
    pub fn fork_base(&self) -> anyhow::Result<LoroDoc> {
        self.fork_at(&self.base.frontiers)
    }

    /// A doc at a state from the base, see [`Base::state_of`].
    fn fork_at(&self, frontiers: &Frontiers) -> anyhow::Result<LoroDoc> {
        // Forking at the empty version makes Loro walk back every op, which
        // takes seconds on big projects, for a result we know is empty.
        if frontiers.is_empty() {
            return Ok(LoroDoc::new());
        }
        self.doc.fork_at(frontiers).context(
            "the cached doc does not contain the last synced state; clone the project again",
        )
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
    ) -> anyhow::Result<(LocalSide, Vec<Skipped>)> {
        let mut local: BTreeMap<String, Local> = BTreeMap::new();
        let mut skipped = Vec::new();
        let side = match scope {
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
                LocalSide::Full(local)
            }
            Scope::Paths(paths) => {
                let mut read = BTreeSet::new();
                for path in paths.iter().chain(extra) {
                    // A listed folder covers the base files inside it.
                    let inside: Vec<String> =
                        entries_under(base, path).map(|(p, _)| p.clone()).collect();
                    for p in inside.iter().chain(std::iter::once(path)) {
                        self.read_one(p, base, &mut local)?;
                        read.insert(p.clone());
                    }
                }
                LocalSide::Partial { files: local, read }
            }
        };
        Ok((side, skipped))
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
        local: &LocalSide,
    ) -> anyhow::Result<BTreeMap<String, ChangeKind>> {
        let mut changes = BTreeMap::new();
        for path in local.candidates(base) {
            let kind = match (base.get(path), local.get(path, base)) {
                (Some(_), None) => ChangeKind::Deleted,
                (Some(content), Some(Local::File(file))) => {
                    if self.local_is(file, content).await? {
                        continue;
                    }
                    ChangeKind::Modified
                }
                (None, Some(Local::File(_))) => ChangeKind::Added,
                (_, Some(Local::AsBase)) | (None, None) => continue,
            };
            changes.insert(path.to_owned(), kind);
        }
        Ok(changes)
    }

    async fn remote_changes(
        &mut self,
        base: &Files,
        remote: &Files,
    ) -> anyhow::Result<BTreeMap<String, ChangeKind>> {
        let mut changes = BTreeMap::new();
        if !self.doc_past_base() {
            // The base is the doc, except for pinned files.
            for path in self.base.pins.keys().cloned().collect::<Vec<_>>() {
                let kind = match (base.get(&path), remote.get(&path)) {
                    (Some(_), None) => ChangeKind::Deleted,
                    (None, Some(_)) => ChangeKind::Added,
                    (Some(before), Some(after)) if !self.same_content(before, after).await? => {
                        ChangeKind::Modified
                    }
                    _ => continue,
                };
                changes.insert(path, kind);
            }
            return Ok(changes);
        }
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

    /// The base, the doc and the folder, plus what changed remotely since
    /// the base. Remotely changed paths are read even outside `scope`.
    async fn sides(&mut self, scope: &Scope) -> anyhow::Result<Sides> {
        let (unpinned, base) = self.base_entry()?;
        // Without remote ops past the base, the doc's files are the ones
        // at the base's frontiers.
        let remote = if !self.doc_past_base() {
            unpinned
        } else {
            Arc::new(self.remote_files())
        };
        let remote_changes = self.remote_changes(&base, &remote).await?;
        let extra = remote_changes.keys().cloned().collect();
        let (local, skipped) = self.read_local(scope, &base, &extra)?;
        Ok(Sides {
            base,
            remote,
            local,
            skipped,
            remote_changes,
        })
    }

    /// Local and remote changes since the base, without touching anything.
    pub async fn status(&mut self, scope: &Scope) -> anyhow::Result<Status> {
        let Sides {
            base,
            local,
            skipped,
            remote_changes,
            ..
        } = self.sides(scope).await?;
        let local_changes = self.local_changes(&base, &local).await?;
        Ok(Status {
            local: local_changes,
            remote: remote_changes,
            skipped,
        })
    }

    /// One sync step between the folder and the doc; see [`Mode`] and
    /// [`Flush`].
    pub async fn reconcile(
        &mut self,
        scope: &Scope,
        mode: Mode,
        flush: Flush,
    ) -> anyhow::Result<Report> {
        let (git, sides) = self.marked_sides(scope).await?;
        self.reconcile_sides(git, sides, mode, flush).await
    }

    /// [`Self::reconcile`] with [`Flush::Deferred`], for the live mode,
    /// unless any of `hold` changed remotely. Then nothing is touched and
    /// those paths are returned, so a caller can wait for the editor that
    /// just saved them without diffing twice.
    pub async fn reconcile_holding(
        &mut self,
        scope: &Scope,
        mode: Mode,
        hold: &BTreeSet<String>,
    ) -> anyhow::Result<Reconciled> {
        let (git, sides) = self.marked_sides(scope).await?;
        let held: BTreeSet<String> = hold
            .iter()
            .filter(|path| sides.remote_changes.contains_key(*path))
            .cloned()
            .collect();
        if !held.is_empty() {
            return Ok(Reconciled::Held(held));
        }
        let report = self
            .reconcile_sides(git, sides, mode, Flush::Deferred)
            .await?;
        Ok(Reconciled::Done(Box::new(report)))
    }

    /// [`Self::sides`], plus where HEAD was before the folder was read: a
    /// checkout during the reconcile must not be vouched for.
    async fn marked_sides(&mut self, scope: &Scope) -> anyhow::Result<(Option<GitMark>, Sides)> {
        let git = self.repo().map(Repo::mark);
        let sides = self.sides(scope).await?;
        Ok((git, sides))
    }

    async fn reconcile_sides(
        &mut self,
        git: Option<GitMark>,
        sides: Sides,
        mode: Mode,
        flush: Flush,
    ) -> anyhow::Result<Report> {
        let Sides {
            base,
            remote,
            mut local,
            skipped,
            remote_changes,
        } = sides;
        let then = BaseKey::of(&self.base);
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
            let same = match (local.get(path, &base), remote.get(path)) {
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
        let plan = Plan {
            base,
            local,
            local_changes,
            remote_changes,
            dropped,
        };

        // The folder ends up matching this state, except for the files in
        // `kept`. Ops that arrive while we wait for acks are left for the
        // next run, which sees them as remote changes on top of this base.
        let (synced, kept, fin) = match mode {
            Mode::Pull => {
                let targets: BTreeSet<String> = plan
                    .remote_changes
                    .keys()
                    .filter(|path| !both.contains(path))
                    .cloned()
                    .collect();
                let frontiers = self.doc.oplog_frontiers();
                let mut kept = self
                    .write_back(&plan, &remote, Some(&targets), &mut report)
                    .await?;
                kept.extend(both.iter().cloned());
                report.conflicts = both;
                (frontiers, kept, remote)
            }
            Mode::Push => {
                if !plan.local_changes.is_empty() {
                    if !self.can_write() {
                        bail!(
                            "this folder is linked with a view-only link, so its {} local change(s) cannot be pushed",
                            plan.local_changes.len()
                        );
                    }
                    // Whatever can fail before the local changes are in the
                    // doc fails here, so a retry starts from scratch.
                    for path in plan.remote_changes.keys() {
                        let writable = match plan.local.get(path, &plan.base) {
                            Some(Local::File(_)) => true,
                            Some(Local::AsBase) => false,
                            None => !self.worktree.exists(path),
                        };
                        if writable && remote.contains_key(path) && !plan.dropped.contains(path) {
                            self.worktree.check_writable(path)?;
                        }
                    }
                    let contents = self.local_contents(&plan).await?;
                    report.applied = self.apply_local(contents)?;
                    if report.applied.changed {
                        // The base now says the folder holds the local
                        // changes. Saved before anything goes out or gets
                        // written, a failure from here on can never make a
                        // later run apply the same edits a second time.
                        self.save()?;
                    }
                }
                let merged = if report.applied.changed {
                    Arc::new(self.remote_files())
                } else {
                    remote
                };
                let frontiers = self.doc.oplog_frontiers();
                if report.applied.changed && flush == Flush::Now {
                    self.push_local().await?;
                }
                report.merged = both;
                let kept = self.write_back(&plan, &merged, None, &mut report).await?;
                (frontiers, kept, merged)
            }
        };

        self.base.pins = kept
            .iter()
            .map(|path| (path.clone(), self.base.state_of(path).clone()))
            .filter(|(_, state)| *state != synced)
            .collect();
        self.base.frontiers = synced;
        self.base.touch();
        // A pull that leaves local changes behind does not vouch for them,
        // so a branch switch before it is still noticed afterwards.
        if mode == Mode::Push || report.status.local.is_empty() {
            self.base.git = git;
        }
        report.base = self.pin_files(Arc::clone(&fin), Some((&then, &plan.base)))?;
        self.remember_base(fin, Arc::clone(&report.base));
        if flush == Flush::Now {
            self.save()?;
        }
        report.warnings.append(&mut self.warnings);
        Ok(report)
    }

    /// Paths that only differ in case from another path of the project.
    /// A case-insensitive file system holds one file for all of them, so
    /// only one is synced: the one on disk under its exact name, if any.
    fn case_dropped(&self, base: &Files, remote: &Files, local: &LocalSide) -> BTreeSet<String> {
        if !self.worktree.case_insensitive() {
            return BTreeSet::new();
        }
        let paths: BTreeSet<&str> = base
            .keys()
            .chain(remote.keys())
            .chain(local.files().keys())
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
        plan: &Plan,
    ) -> anyhow::Result<BTreeMap<String, Option<FileContent>>> {
        let mut out = BTreeMap::new();
        let mut by_digest = None;
        for path in plan.local_changes.keys() {
            let Some(Local::File(file)) = plan.local.get(path, &plan.base) else {
                out.insert(path.clone(), None);
                continue;
            };
            // An existing file keeps its kind as long as its content allows,
            // so an SVG uploaded as an asset does not turn into text.
            let as_text = match plan.base.get(path) {
                Some(FileContent::Asset { .. }) => None,
                _ => file.text.clone(),
            };
            let content = match as_text {
                Some(text) => FileContent::Text(text),
                None => {
                    let by_digest = by_digest.get_or_insert_with(|| {
                        // Reversed so that, like a scan, the first hash wins.
                        self.base
                            .assets
                            .iter()
                            .rev()
                            .map(|(hash, digest)| (digest.clone(), hash.clone()))
                            .collect()
                    });
                    self.upload_asset(path, file, by_digest).await?
                }
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
        let groups: Vec<(Frontiers, BTreeMap<String, Option<FileContent>>)> = group_by_state(
            changes
                .into_iter()
                .map(|(path, content)| (self.base.state_of(&path), (path, content))),
        )
        .into_iter()
        .map(|(state, group)| (state.clone(), group))
        .collect();
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
            let applied = apply_changes(&fork, &changes, PUSH_MESSAGE)?;
            if applied.changed {
                set_peer_info(&fork, &self.identity)?;
                let updates = fork
                    .export(ExportMode::updates(&self.doc.oplog_vv()))
                    .context("exporting local changes")?;
                self.doc.import(&updates).context("merging local changes")?;
                let now = fork.oplog_frontiers();
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
    async fn write_back(
        &mut self,
        plan: &Plan,
        fin: &Files,
        targets: Option<&BTreeSet<String>>,
        report: &mut Report,
    ) -> anyhow::Result<BTreeSet<String>> {
        let Plan {
            base,
            local,
            local_changes,
            remote_changes,
            dropped,
        } = plan;
        let paths: BTreeSet<String> = match local {
            LocalSide::Full(files) => fin
                .keys()
                .chain(base.keys())
                .chain(files.keys())
                .filter(|p| targets.is_none_or(|t| t.contains(*p)))
                .cloned()
                .collect(),
            // A file nobody touched on either side is the same in `fin`
            // and the base, so only these can need anything. Paths that
            // exist on one side only are cheap to find and catch whatever
            // else merging the local changes moved.
            LocalSide::Partial { .. } => local
                .candidates(base)
                .into_iter()
                .chain(local_changes.keys().map(String::as_str))
                .chain(remote_changes.keys().map(String::as_str))
                .chain(dropped.iter().map(String::as_str))
                .chain(
                    fin.keys()
                        .filter(|p| !base.contains_key(*p))
                        .map(String::as_str),
                )
                .chain(
                    base.keys()
                        .filter(|p| !fin.contains_key(*p))
                        .map(String::as_str),
                )
                .filter(|p| targets.is_none_or(|t| t.contains(*p)))
                .map(str::to_owned)
                .collect(),
        };

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
            match (fin.get(&path), local.get(&path, base)) {
                (Some(content), Some(Local::File(file))) => {
                    if !self.local_is(file, content).await? {
                        writes.push((path, content));
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
                        writes.push((path, content));
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
        let assets: Vec<&str> = writes
            .iter()
            .filter_map(|(_, content)| content.asset_hash())
            .collect();
        self.prefetch_assets(&assets).await?;
        for (path, content) in writes {
            let bytes = self.content_bytes(content).await?;
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
    fn changed_on_disk(&self, path: &str, local: &LocalSide) -> bool {
        let then = match local.files().get(path) {
            Some(Local::File(file)) => {
                if self.worktree.unchanged_since_read(path, file) {
                    return false;
                }
                Some(&file.digest)
            }
            _ => None,
        };
        match self.worktree.read_bytes(path) {
            Ok(now) => now.map(|bytes| Digest::of(&bytes)).as_ref() != then,
            Err(_) => true,
        }
    }
}

fn to_map(files: Vec<MaterializedFile>) -> Files {
    files.into_iter().map(|f| (f.path, f.content)).collect()
}

/// Groups `items` by the doc state they belong to, in order of first
/// appearance. Frontiers have no order or hash, and there are only ever a
/// few distinct states, so a linear scan is all it takes.
fn group_by_state<'a, T, C: Default + Extend<T>>(
    items: impl IntoIterator<Item = (&'a Frontiers, T)>,
) -> Vec<(&'a Frontiers, C)> {
    let mut groups: Vec<(&Frontiers, C)> = Vec::new();
    for (state, item) in items {
        let at = match groups.iter().position(|(then, _)| *then == state) {
            Some(at) => at,
            None => {
                groups.push((state, C::default()));
                groups.len() - 1
            }
        };
        groups[at].1.extend([item]);
    }
    groups
}
