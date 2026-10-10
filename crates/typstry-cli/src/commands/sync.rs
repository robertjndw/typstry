use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::bail;
use loro::Frontiers;
use tokio::sync::mpsc;

use crate::engine::{Mode, Reconciled, RemoteEvent, Report, Scope, Session};
use crate::git::{GitMark, Head, Repo};
use crate::mailbox::{Mailbox, Request, Response};
use crate::watch::{Change, GitState, Seen, Synced, Watcher};

use super::{
    Ctx, Output, guard_switch, info, print_applied, print_report, print_warnings, push, status,
    switch_refusal, track_branch, version,
};

/// Remote changes are written this long after the first one arrives, so a
/// burst of keystrokes in the browser becomes one write.
const COALESCE: Duration = Duration::from_millis(200);

/// A file saved locally this recently gets no remote writes yet: the
/// editor that saved it may still be busy with it.
const HOT: Duration = Duration::from_secs(2);

/// How often `.git` is looked at. Polling covers worktrees whose git dir
/// lives elsewhere and needs no second watcher.
const GIT_POLL: Duration = Duration::from_millis(250);

/// Git takes `index.lock` for a moment in many read-only commands (shell
/// prompts run `git status` all the time), so short pauses stay quiet.
const ANNOUNCE_BUSY_AFTER: Duration = Duration::from_secs(1);

const SAVE_EVERY: Duration = Duration::from_secs(2);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const ERROR_RETRY: Duration = Duration::from_secs(5);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(10);

/// Present in `.typstry/` while local changes are held back after a branch
/// switch, so a restarted sync keeps holding them.
const HOLD_MARKER: &str = "hold";

/// Keep the folder and the project in sync, live, until Ctrl+C.
///
/// Local saves are published within a second and remote edits are written
/// to the folder as they come in. Edits on both sides of a file are merged,
/// never overwritten. With a view-only link only remote edits come in.
#[derive(Debug, Default, clap::Args)]
#[command(after_long_help = "\
Git: sync pauses in both directions while git is rewriting files (merge, \
rebase, index.lock) and while a branch other than the tracked one is \
checked out, so other branches stay private drafts. Merging a draft into \
the tracked branch publishes it.

Coming back to the tracked branch with files that differ from the last \
sync usually means a co-author's edits were pulled while you were on a \
draft and the checkout removed them again. Publishing that folder would \
revert those edits for everyone, so sync then holds back all outgoing \
changes and lists the files. Incoming changes still arrive, except for \
files that changed on both sides, which wait. Review the files, then \
publish them by typing `push` and Enter in the sync terminal, or by \
stopping sync and running `typstry push --force` or `typstry sync \
--publish`. Restoring the files so they match the last sync again lifts \
the hold too. The same check runs after a `git reset`, and when sync \
starts after a branch switch that happened while it was not running.

While sync runs it holds the folder's lock. `status`, `info`, `version \
list`, `version save` and `push` in the same folder then ask the running \
sync, which answers from its live copy of the project and publishes \
right away; `pull` only says that sync already pulls. `version save` and \
`push` refuse while sync is paused, and need --force to publish what it \
holds back. `track` and `export` refuse to start until sync stops.")]
pub struct Args {
    /// Publish local changes that an earlier sync held back after a branch
    /// switch.
    #[arg(long)]
    pub publish: bool,
}

/// Requests from outside the sync loop: the terminal or a test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    /// Publish the local changes held back after a branch switch.
    Publish,
    /// Flush and exit.
    Stop,
}

/// State changes, for tests that drive the loop in-process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    Ready,
    Connected,
    Offline,
    Paused,
    Resumed,
    Holding,
    Released,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let (tx, rx) = mpsc::unbounded_channel();
    let stdin_tx = tx.clone();
    // A plain thread rather than spawn_blocking: a blocked stdin read
    // would otherwise keep the runtime from shutting down at exit.
    std::thread::spawn(move || {
        for line in std::io::stdin().lines() {
            let Ok(line) = line else { break };
            if matches!(line.trim(), "push" | "p") && stdin_tx.send(Control::Publish).is_err() {
                break;
            }
        }
    });
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            let _ = tx.send(Control::Stop);
        }
        if tokio::signal::ctrl_c().await.is_ok() {
            eprintln!("sync: interrupted again, exiting without flushing");
            std::process::exit(130);
        }
    });
    run_with(ctx, args, rx, None).await
}

/// The sync loop, driven by `control` instead of the terminal.
pub async fn run_with(
    ctx: &Ctx,
    args: Args,
    mut control: mpsc::UnboundedReceiver<Control>,
    notices: Option<mpsc::UnboundedSender<Notice>>,
) -> anyhow::Result<()> {
    let session = ctx.open()?;
    // Before the announcement, so a command that sees sync in the lock
    // finds the mailbox too.
    let mailbox = Mailbox::open(session.state().dir())?;
    session
        .state()
        .announce(&format!("sync, pid {}", std::process::id()))?;
    // Watching starts before anything is read, so no edit falls between
    // the first reconcile and the first event.
    let (_watcher, mut changes) = Watcher::start(session.root())?;
    let mut live = Live::new(session, mailbox, notices);
    live.start(args.publish).await?;

    loop {
        let deadline = live.next_deadline();
        let connected = live.session.is_connected();
        let session = &mut live.session;
        tokio::select! {
            msg = control.recv() => match msg {
                Some(Control::Publish) => live.publish(),
                Some(Control::Stop) | None => break,
            },
            change = changes.recv() => match change {
                Some(change) => live.on_change(change),
                None => bail!("the file watcher stopped"),
            },
            event = async {
                if connected {
                    session.next_remote().await
                } else {
                    std::future::pending().await
                }
            } => live.on_remote(event).await,
            () = tokio::time::sleep_until(deadline.into()) => {}
        }
        live.step().await;
    }
    live.shutdown().await
}

struct Pause {
    /// Some other branch was checked out at some point during the pause,
    /// so the folder may now hold anything.
    left_branch: bool,
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
    fn new(left_branch: bool, start: Option<GitMark>, since: Instant) -> Self {
        Pause {
            left_branch,
            start,
            settled: None,
            since,
            shown: None,
        }
    }
}

struct Live {
    session: Session,
    mailbox: Mailbox,
    notices: Option<mpsc::UnboundedSender<Notice>>,
    synced: Synced,
    /// Locally changed paths waiting for a reconcile, and when it is due.
    pending: BTreeSet<String>,
    rescan: bool,
    local_at: Option<Instant>,
    /// When paths were last saved locally, for the [`HOT`] hold.
    saved: HashMap<String, Instant>,
    remote_due: Option<Instant>,
    /// Remote changes that cannot be written while outbound is held, at
    /// this doc state. Retried once the doc or the folder changes.
    blocked: Option<Frontiers>,
    pause: Option<Pause>,
    holding: bool,
    held_count: usize,
    retry_at: Option<Instant>,
    last_error: Option<String>,
    reconnect_at: Option<Instant>,
    backoff: Duration,
    offline_shown: Option<String>,
    dirty: bool,
    last_save: Instant,
    next_git_poll: Instant,
    warned: BTreeSet<String>,
}

impl Live {
    fn new(
        session: Session,
        mailbox: Mailbox,
        notices: Option<mpsc::UnboundedSender<Notice>>,
    ) -> Self {
        let now = Instant::now();
        Self {
            session,
            mailbox,
            notices,
            synced: Synced::default(),
            pending: BTreeSet::new(),
            rescan: false,
            local_at: None,
            saved: HashMap::new(),
            remote_due: None,
            blocked: None,
            pause: None,
            holding: false,
            held_count: 0,
            retry_at: None,
            last_error: None,
            reconnect_at: None,
            backoff: BACKOFF_MIN,
            offline_shown: None,
            dirty: false,
            last_save: now,
            next_git_poll: now,
            warned: BTreeSet::new(),
        }
    }

    fn notify(&self, notice: Notice) {
        if let Some(tx) = &self.notices {
            let _ = tx.send(notice);
        }
    }

    async fn start(&mut self, publish: bool) -> anyhow::Result<()> {
        self.synced.refresh(&self.session)?;
        self.reconnect().await;
        self.poll_git().await;
        let marker = self.hold_marker();
        if publish {
            remove_marker(&marker)?;
        }
        match &mut self.pause {
            // Whatever happened while sync was not running, the folder
            // gets the same check as after a branch switch on resume.
            Some(pause) => pause.left_branch = true,
            None => {
                // --publish is the go-ahead the check would ask for.
                if !publish && (marker.exists() || self.session.git_switched()) {
                    self.check_tree().await;
                    if !self.holding {
                        remove_marker(&marker)?;
                    }
                }
                if !self.holding {
                    self.queue_rescan();
                }
            }
        }
        if !self.session.can_write() {
            println!("sync: view-only link, only receiving changes");
        }
        self.notify(Notice::Ready);
        self.step().await;
        Ok(())
    }

    fn next_deadline(&self) -> Instant {
        let mut at = self.next_git_poll;
        let mut consider = |t: Option<Instant>| {
            if let Some(t) = t
                && t < at
            {
                at = t;
            }
        };
        consider(self.local_at);
        consider(self.remote_due);
        consider(self.retry_at);
        if !self.session.is_connected() {
            consider(self.reconnect_at);
        }
        if self.dirty {
            consider(Some(self.last_save + SAVE_EVERY));
        }
        at
    }

    fn on_change(&mut self, change: Change) {
        // Whatever a checkout of another branch does to the folder is
        // looked at as a whole when the tracked branch is back.
        if self.pause.as_ref().is_some_and(|p| p.left_branch) {
            return;
        }
        let now = Instant::now();
        let mut any = false;
        match change {
            Change::Rescan => {
                self.rescan = true;
                any = true;
            }
            Change::Paths(paths) => {
                for abs in paths {
                    match self.synced.classify(self.session.worktree(), &abs) {
                        Seen::Changed(path) => {
                            self.saved.insert(path.clone(), now);
                            self.pending.insert(path);
                            any = true;
                        }
                        Seen::Folder => {
                            self.rescan = true;
                            any = true;
                        }
                        Seen::Nothing => {}
                    }
                }
            }
        }
        if any {
            self.local_at.get_or_insert(now);
            // The folder changed, so remote changes that were stuck on a
            // conflict may fit now.
            self.blocked = None;
        }
    }

    async fn on_remote(&mut self, event: anyhow::Result<RemoteEvent>) {
        match event {
            Ok(RemoteEvent::Imported) => self.dirty = true,
            Ok(RemoteEvent::Progress) => {}
            Err(err) => self.went_offline(&err).await,
        }
    }

    async fn went_offline(&mut self, err: &anyhow::Error) {
        self.session.disconnect().await;
        self.backoff = BACKOFF_MIN;
        self.reconnect_at = Some(Instant::now() + self.backoff);
        let line = format!("{err:#}");
        println!("sync: offline ({line}), reconnecting");
        self.offline_shown = Some(line);
        self.notify(Notice::Offline);
    }

    async fn reconnect(&mut self) {
        match self.session.connect().await {
            Ok(()) => {
                println!("sync: connected to {}", self.session.config.server);
                self.offline_shown = None;
                self.reconnect_at = None;
                self.backoff = BACKOFF_MIN;
                // Edits made while offline went out in connect(); anything
                // that failed for lack of a connection can go again now.
                self.retry_at = None;
                self.blocked = None;
                self.dirty = true;
                self.notify(Notice::Connected);
            }
            Err(err) => {
                self.session.disconnect().await;
                let line = format!("{err:#}");
                if self.offline_shown.as_deref() != Some(line.as_str()) {
                    println!("sync: offline ({line}), retrying in the background");
                    self.notify(Notice::Offline);
                }
                self.offline_shown = Some(line);
                self.reconnect_at = Some(Instant::now() + self.backoff);
                self.backoff = (self.backoff * 2).min(BACKOFF_MAX);
            }
        }
    }

    /// Does whatever is due. Called after every wakeup of the loop.
    async fn step(&mut self) {
        let now = Instant::now();
        if now >= self.next_git_poll {
            self.poll_git().await;
            self.next_git_poll = Instant::now() + GIT_POLL;
            self.answer_requests().await;
        }
        if !self.session.is_connected() && self.reconnect_at.is_some_and(|t| t <= now) {
            self.reconnect().await;
        }
        let can_work = self.pause.is_none() && self.retry_at.is_none_or(|t| t <= now);
        if can_work {
            self.retry_at = None;
            if self.local_at.is_some_and(|t| t <= now) {
                self.sync_local().await;
            }
        }
        if self.remote_waiting() {
            let due = *self.remote_due.get_or_insert(now + COALESCE);
            if can_work && due <= Instant::now() && self.retry_at.is_none() {
                self.remote_due = None;
                self.sync_remote().await;
            }
        } else {
            self.remote_due = None;
        }
        if self.dirty && Instant::now() >= self.last_save + SAVE_EVERY {
            self.save();
        }
        print_warnings(&mut Output::terminal(), &mut self.session);
    }

    /// Whether the doc holds remote changes the folder does not have yet.
    fn remote_waiting(&self) -> bool {
        let doc = self.session.doc.oplog_frontiers();
        let base = self.session.base.frontiers().unwrap_or_default();
        (doc != base || !self.session.base.pins.is_empty()) && self.blocked.as_ref() != Some(&doc)
    }

    fn save(&mut self) {
        match self.session.save() {
            Ok(()) => {
                self.dirty = false;
                self.last_save = Instant::now();
            }
            Err(err) => self.error(&err),
        }
    }

    fn error(&mut self, err: &anyhow::Error) {
        let line = format!("{err:#}");
        if self.last_error.as_deref() != Some(line.as_str()) {
            eprintln!("sync: {line}; retrying");
            self.last_error = Some(line);
        }
        self.retry_at = Some(Instant::now() + ERROR_RETRY);
    }

    async fn poll_git(&mut self) {
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
        let now = Instant::now();
        match state {
            GitState::Clear => {
                if let Some(pause) = &mut self.pause {
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
            }
            GitState::Busy(op) => {
                let fresh = self.pause.is_none();
                let pause = self
                    .pause
                    .get_or_insert_with(|| Pause::new(false, repo.as_ref().map(|r| r.mark()), now));
                pause.settled = None;
                if pause.shown.is_none() && now >= pause.since + ANNOUNCE_BUSY_AFTER {
                    let line = format!("sync: paused, git is in the middle of {op}");
                    println!("{line}");
                    pause.shown = Some(line);
                }
                if fresh {
                    self.notify(Notice::Paused);
                }
            }
            GitState::Elsewhere { head, tracked } => {
                let fresh = self.pause.is_none();
                let pause = self
                    .pause
                    .get_or_insert_with(|| Pause::new(true, repo.as_ref().map(|r| r.mark()), now));
                pause.left_branch = true;
                pause.settled = None;
                let line = match (&head, tracked) {
                    (_, Some(tracked)) => format!("sync: paused, on {head} (tracks {tracked})"),
                    (Head::Detached, None) => "sync: paused, on a detached HEAD and no branch is tracked yet; check out a branch or use typstry track".to_owned(),
                    (Head::Branch(_), None) => format!("sync: paused, on {head}"),
                };
                if pause.shown.as_deref() != Some(line.as_str()) {
                    println!("{line}");
                    pause.shown = Some(line);
                }
                // Edits made before the switch that were still waiting
                // belong to the tracked branch; they are part of what the
                // check on return looks at.
                self.clear_local_queue();
                if fresh {
                    self.notify(Notice::Paused);
                }
            }
        }
    }

    async fn resume(&mut self, pause: Pause) {
        if pause.shown.is_some() {
            println!("sync: resumed");
        }
        self.notify(Notice::Resumed);
        if pause.left_branch {
            self.clear_local_queue();
            self.check_tree().await;
            if !self.holding {
                // The tree matches the base, but a rescan is cheap and
                // catches anything the watcher could not attribute.
                self.queue_rescan();
            }
        }
    }

    /// After a checkout, a folder that differs from the last sync may lack
    /// remote edits that were pulled while a draft was checked out. Pushing
    /// it would revert them, so outbound changes wait for an explicit
    /// publish.
    async fn check_tree(&mut self) {
        if !self.session.can_write() {
            return;
        }
        match self.session.status(&Scope::Full).await {
            Ok(status) if status.local.is_empty() => {}
            Ok(status) => {
                self.hold();
                println!(
                    "sync: {} file(s) differ from the last sync after a branch switch or reset; holding back outgoing changes:",
                    status.local.len()
                );
                for (path, kind) in &status.local {
                    println!("  {} {path}", kind.symbol());
                }
                println!(
                    "sync: review them, then type `push` and Enter here to publish (or stop sync and run typstry push --force)"
                );
                self.held_count = status.local.len();
            }
            Err(err) => {
                self.hold();
                eprintln!(
                    "sync: cannot compare the folder with the last sync ({err:#}); holding back outgoing changes until you type `push`"
                );
            }
        }
    }

    fn hold(&mut self) {
        self.holding = true;
        let marker = self.hold_marker();
        if let Err(err) = std::fs::write(&marker, b"") {
            eprintln!("warning: cannot write {}: {err}", marker.display());
        }
        self.notify(Notice::Holding);
    }

    fn release(&mut self) {
        self.holding = false;
        self.held_count = 0;
        self.blocked = None;
        if let Err(err) = remove_marker(&self.hold_marker()) {
            eprintln!("warning: {err:#}");
        }
        self.notify(Notice::Released);
    }

    fn publish(&mut self) {
        if !self.holding {
            println!("sync: nothing is held back");
            return;
        }
        if self.pause.is_some() {
            println!("sync: paused; publish once the tracked branch is checked out again");
            return;
        }
        println!("sync: publishing held changes");
        self.release();
        self.queue_rescan();
    }

    async fn sync_local(&mut self) {
        self.local_at = None;
        let batch = std::mem::take(&mut self.pending);
        let full = std::mem::take(&mut self.rescan);
        if !self.session.can_write() {
            for path in batch {
                if self.warned.insert(path.clone()) {
                    eprintln!("warning: view-only link, not publishing {path}");
                }
            }
            return;
        }
        if self.holding {
            self.recheck_hold().await;
            return;
        }
        // A `git reset --hard` or a quick checkout round trip can come and
        // go between two git polls without ever showing up as a pause. The
        // reconcile below records where HEAD is, so this only fires once.
        if self.session.git_switched() {
            self.check_tree().await;
            if self.holding {
                return;
            }
        }
        let hot = self.hot(&batch);
        let scope = if full {
            Scope::Full
        } else {
            Scope::Paths(batch.clone())
        };
        match self
            .session
            .reconcile_live_holding(&scope, Mode::Push, &hot)
            .await
        {
            Ok(Reconciled::Done(mut report)) => self.after(&mut report).await,
            Ok(Reconciled::Held(paths)) => {
                self.pending.extend(batch);
                self.rescan |= full;
                self.local_at = Some(self.hot_until(&paths));
            }
            Err(err) => {
                self.pending.extend(batch);
                self.rescan |= full;
                self.local_at = Some(Instant::now());
                self.error(&err);
            }
        }
    }

    /// While holding, every folder change is checked against the base: once
    /// the folder matches it again (the user restored the files), there is
    /// nothing left that could revert anything and the hold ends.
    async fn recheck_hold(&mut self) {
        match self.session.status(&Scope::Full).await {
            Ok(status) if status.local.is_empty() => {
                println!("sync: the folder matches the last sync again; resuming outgoing changes");
                self.release();
            }
            Ok(status) => {
                if status.local.len() != self.held_count {
                    self.held_count = status.local.len();
                    println!(
                        "sync: holding back {} changed file(s); type `push` and Enter to publish",
                        self.held_count
                    );
                }
            }
            Err(err) => self.error(&err),
        }
    }

    async fn sync_remote(&mut self) {
        let hot = self.hot(&BTreeSet::new());
        let empty = Scope::Paths(BTreeSet::new());
        let outbound = self.session.can_write() && !self.holding;
        let mode = if outbound { Mode::Push } else { Mode::Pull };
        match self
            .session
            .reconcile_live_holding(&empty, mode, &hot)
            .await
        {
            Ok(Reconciled::Held(paths)) => self.remote_due = Some(self.hot_until(&paths)),
            Ok(Reconciled::Done(mut report)) => {
                if !report.conflicts.is_empty() {
                    println!(
                        "sync: remote changes to {} wait until the local changes to them are published or undone",
                        report.conflicts.join(", ")
                    );
                }
                self.after(&mut report).await;
            }
            Err(err) => self.error(&err),
        }
    }

    fn queue_rescan(&mut self) {
        self.rescan = true;
        self.local_at = Some(Instant::now());
    }

    fn clear_local_queue(&mut self) {
        self.pending.clear();
        self.rescan = false;
        self.local_at = None;
    }

    fn hold_marker(&self) -> PathBuf {
        self.session.state().dir().join(HOLD_MARKER)
    }

    /// Takes the reconcile's base files for the watcher filter.
    async fn after(&mut self, report: &mut Report) {
        self.dirty = true;
        // Files the reconcile left alone only fit once the folder or the
        // doc changes again.
        self.blocked =
            (!self.session.base.pins.is_empty()).then(|| self.session.doc.oplog_frontiers());
        self.last_error = None;
        print_lines(report);
        self.synced
            .update(&self.session, std::mem::take(&mut report.base));
        if report.applied.changed
            && self.session.is_connected()
            && let Err(err) = self.session.push_local().await
        {
            self.went_offline(&err).await;
        }
    }

    /// Paths saved locally a moment ago: a reconcile waits for [`HOT`] if
    /// any of them changed remotely. `except` are the paths about to be
    /// reconciled anyway: their local version goes in first.
    fn hot(&mut self, except: &BTreeSet<String>) -> BTreeSet<String> {
        let now = Instant::now();
        self.saved.retain(|_, at| *at + HOT > now);
        match self.session.base.frontiers() {
            // Without remote ops past the base, nothing can have changed
            // remotely under a fresh save.
            Ok(base) if base != self.session.doc.oplog_frontiers() => {}
            _ => return BTreeSet::new(),
        }
        self.saved
            .keys()
            .filter(|path| !except.contains(*path))
            .cloned()
            .collect()
    }

    /// When the [`HOT`] hold ends for `held`.
    fn hot_until(&self, held: &BTreeSet<String>) -> Instant {
        held.iter()
            .filter_map(|path| self.saved.get(path))
            .map(|at| *at + HOT)
            .max()
            .unwrap_or_else(Instant::now)
    }

    /// Answers what other typstry commands in the folder asked for; see
    /// [`crate::mailbox`]. Runs between steps, so requests see the same
    /// state as the loop.
    async fn answer_requests(&mut self) {
        // Whatever the loop ran into so far is its own news, not part of
        // the answer to whoever asks next.
        print_warnings(&mut Output::terminal(), &mut self.session);
        let waiting = match self.mailbox.take() {
            Ok(waiting) => waiting,
            Err(err) => {
                let line = format!("{err:#}");
                if self.warned.insert(line.clone()) {
                    eprintln!("sync: cannot read requests from other commands: {line}");
                }
                return;
            }
        };
        for (id, request) in waiting {
            let mut out = Output::collect();
            let result = match request {
                Ok(request) => self.handle(request, &mut out).await,
                Err(err) => Err(err),
            };
            print_warnings(&mut out, &mut self.session);
            let response = Response {
                lines: out.into_lines(),
                error: result.err().map(|err| format!("{err:#}")),
            };
            self.mailbox.answer(&id, &response);
        }
    }

    async fn handle(&mut self, request: Request, out: &mut Output) -> anyhow::Result<()> {
        match request {
            Request::Status => {
                if let Some(line) = self.state_line() {
                    out.out(format!("sync: {line}"));
                }
                status::print_status(&mut self.session, out).await
            }
            // The live doc is as fresh as a fetch would make it; "offline"
            // means the same as for the standalone command.
            Request::Info => {
                let sync = self.describe();
                let offline = !self.session.is_connected();
                info::print_info(&mut self.session, offline, &sync, out).await
            }
            Request::VersionList => {
                version::print_versions(&self.session.doc, out);
                Ok(())
            }
            Request::VersionSave { name, force } => self.save_version(&name, force, out).await,
            Request::Push { force } => self.push_now(force, out).await,
            Request::Pull => {
                self.describe_pull(out);
                Ok(())
            }
        }
    }

    /// Why sync is not syncing the folder right now, if it is not.
    fn pause_reason(&self) -> Option<String> {
        self.pause.as_ref()?;
        let repo = Repo::discover(self.session.root());
        let found = repo.as_ref().map(|repo| (repo, repo.head()));
        Some(
            match GitState::of(found, self.session.config.branch.as_deref()) {
                GitState::Busy(op) => format!("git is in the middle of {op}"),
                GitState::Elsewhere {
                    head,
                    tracked: Some(tracked),
                } => format!("on {head}, typstry tracks {tracked}"),
                GitState::Elsewhere {
                    head,
                    tracked: None,
                } => format!("on {head}, and no branch is tracked yet"),
                GitState::Clear => "waiting for git to settle".to_owned(),
            },
        )
    }

    /// Anything unusual about sync, for `typstry status`.
    fn state_line(&self) -> Option<String> {
        if let Some(reason) = self.pause_reason() {
            return Some(format!("paused, {reason}"));
        }
        if self.holding {
            return Some(
                "holding back outgoing changes after a branch switch; publish them with typstry push --force"
                    .to_owned(),
            );
        }
        (!self.session.is_connected()).then(|| "offline, retrying in the background".to_owned())
    }

    /// The `Sync:` line of `typstry info`.
    fn describe(&self) -> String {
        let mut line = format!("running (pid {})", std::process::id());
        if let Some(reason) = self.pause_reason() {
            line.push_str(&format!(", paused: {reason}"));
        } else if self.holding {
            line.push_str(", holding back outgoing changes after a branch switch");
        }
        if !self.session.is_connected() {
            line.push_str(", offline");
        }
        line
    }

    fn describe_pull(&self, out: &mut Output) {
        out.out("typstry sync is running and already pulls remote changes.");
        if let Some(reason) = self.pause_reason() {
            out.out(format!(
                "It is paused right now ({reason}); remote changes arrive once it resumes."
            ));
        } else if !self.session.is_connected() {
            out.out("It is offline right now and pulls once it is connected again.");
        }
        if self.holding {
            out.out("Outgoing changes are held back after a branch switch; see typstry status.");
        }
        let pinned: Vec<&str> = self.session.base.pins.keys().map(String::as_str).collect();
        if !pinned.is_empty() {
            out.out(format!(
                "Remote changes wait because these files changed here too: {}",
                pinned.join(", ")
            ));
        }
    }

    fn refuse_while_paused(&self, what: &str) -> anyhow::Result<()> {
        if let Some(reason) = self.pause_reason() {
            bail!(
                "typstry sync is paused ({reason}); {what} once the tracked branch is checked out and git is done"
            );
        }
        Ok(())
    }

    /// Ends a hold for a command that publishes. Like the one-shot
    /// commands, that takes --force while the folder still differs from
    /// the last sync. Returns what the flush after it has to scan: nothing
    /// once the check found that the folder matches the last sync.
    async fn release_for(&mut self, force: bool, out: &mut Output) -> anyhow::Result<Scope> {
        if !self.holding {
            return Ok(Scope::Full);
        }
        let mut scope = Scope::Full;
        if !force {
            let status = self.session.status(&Scope::Full).await?;
            if !status.local.is_empty() {
                return Err(switch_refusal(&status.local));
            }
            scope = Scope::Paths(BTreeSet::new());
        }
        out.out("sync: publishing held changes");
        self.release();
        Ok(scope)
    }

    /// Publishes what is on disk now rather than when the watcher reports
    /// it, so a command right after a save already includes the save.
    async fn flush(&mut self, scope: &Scope) -> anyhow::Result<Report> {
        let mut report = self.session.reconcile_live(scope, Mode::Push).await?;
        // The scan covered whatever the watcher had queued, be it this one
        // or the one in release_for.
        self.clear_local_queue();
        self.after(&mut report).await;
        Ok(report)
    }

    async fn push_now(&mut self, force: bool, out: &mut Output) -> anyhow::Result<()> {
        self.refuse_while_paused("push")?;
        guard_switch(&mut self.session, force).await?;
        let scope = self.release_for(force, out).await?;
        let report = self.flush(&scope).await?;
        push::print_pushed(out, &report);
        if !self.session.is_connected() {
            out.out("typstry sync is offline; the changes go out once it is connected again.");
        }
        Ok(())
    }

    async fn save_version(
        &mut self,
        name: &str,
        force: bool,
        out: &mut Output,
    ) -> anyhow::Result<()> {
        if !self.session.can_write() {
            bail!("{}", version::VIEW_ONLY_SAVE);
        }
        self.refuse_while_paused("save the version")?;
        if !self.session.is_connected() {
            bail!("typstry sync is offline; save the version once it is connected again");
        }
        guard_switch(&mut self.session, force).await?;
        let scope = self.release_for(force, out).await?;
        let report = self.flush(&scope).await?;
        version::print_pushed(out, &report);
        let saved = version::name_current_state(&mut self.session, name)?;
        self.dirty = true;
        let sent = if self.session.is_connected() {
            tokio::time::timeout(FLUSH_TIMEOUT, self.session.push_local())
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("the server did not confirm it in time")))
        } else {
            Err(anyhow::anyhow!("lost the connection"))
        };
        if let Err(err) = sent {
            bail!(
                "saved version #{} {:?}, but it has not reached the server yet ({err:#}); sync sends it once it is connected again",
                saved.index,
                saved.name
            );
        }
        version::print_saved(out, &saved);
        Ok(())
    }

    async fn shutdown(mut self) -> anyhow::Result<()> {
        println!("sync: stopping");
        for (id, _) in self.mailbox.take().unwrap_or_default() {
            let response = Response {
                lines: Vec::new(),
                error: Some("typstry sync is stopping; run the command again once it has".into()),
            };
            self.mailbox.answer(&id, &response);
        }
        // After an unnoticed reset the folder may lack pulled edits; the
        // next run checks it before publishing anything.
        if self.pause.is_none()
            && !self.holding
            && self.session.can_write()
            && !self.session.git_switched()
        {
            // Covers edits the watcher has not reported yet.
            match self.session.reconcile_live(&Scope::Full, Mode::Push).await {
                Ok(report) => print_lines(&report),
                Err(err) => eprintln!("sync: final sync failed: {err:#}"),
            }
            if self.session.is_connected()
                && tokio::time::timeout(FLUSH_TIMEOUT, self.session.push_local())
                    .await
                    .map_or(true, |r| r.is_err())
            {
                eprintln!(
                    "sync: some changes were not confirmed by the server; they go out with the next sync or push"
                );
            }
        }
        print_warnings(&mut Output::terminal(), &mut self.session);
        self.session.save()?;
        self.session.disconnect().await;
        Ok(())
    }
}

fn remove_marker(path: &std::path::Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context(format!("removing {}", path.display()))),
    }
}

/// One line per synced file: `↑` went out, `↓` came in.
fn print_lines(report: &Report) {
    let out = &mut Output::terminal();
    print_applied(out, &report.applied, "publishing");
    print_report(out, report);
    for path in &report.merged {
        out.out(format!("  {path} changed on both sides and was merged"));
    }
}
