//! `typstry sync`: the live loop, its timers and the two directions of
//! syncing. Git pauses and holds are in `git_pause`, requests from
//! other commands in `requests`.

mod git_pause;
mod requests;

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use anyhow::bail;
use loro::Frontiers;
use tokio::sync::mpsc;

use crate::engine::{Flush, Mode, Reconciled, RemoteEvent, Report, Scope, Session, SyncError};
use crate::mailbox::Mailbox;
use crate::watch::{Change, Seen, Synced, Watcher};

use super::{Ctx, Output, print_applied, print_report, print_warnings};

use self::git_pause::{Pause, remove_marker};

/// Remote changes are written this long after the first one arrives, so a
/// burst of keystrokes in the browser becomes one write.
const COALESCE: Duration = Duration::from_millis(200);

/// A file saved locally this recently gets no remote writes yet: the
/// editor that saved it may still be busy with it.
const HOT: Duration = Duration::from_secs(2);

/// How often `.git` is looked at. Polling covers worktrees whose git dir
/// lives elsewhere and needs no second watcher.
const GIT_POLL: Duration = Duration::from_millis(250);

/// How often the mailbox is looked at without the watcher saying a request
/// came in, in case it missed one.
const MAILBOX_POLL: Duration = Duration::from_secs(2);

/// Git takes `index.lock` for a moment in many read-only commands (shell
/// prompts run `git status` all the time), so short pauses stay quiet.
const ANNOUNCE_BUSY_AFTER: Duration = Duration::from_secs(1);

const SAVE_EVERY: Duration = Duration::from_secs(2);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const ERROR_RETRY: Duration = Duration::from_secs(5);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(10);

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
        if let Some(err) = live.fatal.take() {
            return live.abort(err).await;
        }
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
            event = session.next_remote(), if connected => live.on_remote(event).await,
            () = tokio::time::sleep_until(deadline.into()) => {}
        }
        live.step().await;
    }
    live.shutdown().await
}

/// Whether local changes go out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outbound {
    Open,
    /// Held back after a branch switch or reset until the user publishes.
    /// `count` is how many files differed from the last sync at the last
    /// look, to tell the user again only when it changes.
    Holding {
        count: usize,
    },
    /// The user published the folder as it is. Until a push records where
    /// HEAD is now, the base still remembers HEAD from before the switch,
    /// so `git_switched` would put the hold straight back.
    Published,
}

/// Locally changed paths waiting for a reconcile, and when it is due.
#[derive(Debug, Default)]
struct LocalQueue {
    paths: BTreeSet<String>,
    /// Only a scan of the whole folder can tell what changed.
    rescan: bool,
    due: Option<Instant>,
}

impl LocalQueue {
    /// Empties the queue for a reconcile: the paths, and whether it has to
    /// scan everything.
    fn take(&mut self) -> (BTreeSet<String>, bool) {
        self.due = None;
        (
            std::mem::take(&mut self.paths),
            std::mem::take(&mut self.rescan),
        )
    }

    /// Puts back what [`Self::take`] took, for another try at `due`.
    fn restore(&mut self, batch: BTreeSet<String>, full: bool, due: Instant) {
        self.paths.extend(batch);
        self.rescan |= full;
        self.due = Some(due);
    }

    fn rescan_now(&mut self) {
        self.rescan = true;
        self.due = Some(Instant::now());
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

/// Getting back online.
#[derive(Debug)]
struct Reconnect {
    /// When to try next, while offline.
    at: Option<Instant>,
    backoff: Duration,
    /// The last offline line printed, to print again only on news.
    shown: Option<String>,
}

impl Default for Reconnect {
    fn default() -> Self {
        Self {
            at: None,
            backoff: BACKOFF_MIN,
            shown: None,
        }
    }
}

impl Reconnect {
    /// A connection that worked went away: try again soon.
    fn lost(&mut self, line: String) {
        self.backoff = BACKOFF_MIN;
        self.at = Some(Instant::now() + self.backoff);
        self.shown = Some(line);
    }

    /// A try failed with `line`, as printed: back off.
    fn failed(&mut self, line: String) {
        self.shown = Some(line);
        self.at = Some(Instant::now() + self.backoff);
        self.backoff = (self.backoff * 2).min(BACKOFF_MAX);
    }
}

struct Live {
    session: Session,
    mailbox: Mailbox,
    notices: Option<mpsc::UnboundedSender<Notice>>,
    synced: Synced,
    local: LocalQueue,
    /// When paths were last saved locally, for the [`HOT`] hold.
    saved: HashMap<String, Instant>,
    remote_due: Option<Instant>,
    /// Remote changes that cannot be written while outbound is held, at
    /// this doc state. Retried once the doc or the folder changes.
    blocked: Option<Frontiers>,
    pause: Option<Pause>,
    outbound: Outbound,
    retry_at: Option<Instant>,
    last_error: Option<String>,
    reconnect: Reconnect,
    dirty: bool,
    last_save: Instant,
    next_git_poll: Instant,
    /// When to look for requests from other commands next. The watcher
    /// moves it up when one arrives.
    next_mailbox_poll: Instant,
    warned: BTreeSet<String>,
    /// Something retrying cannot fix; the loop stops with it.
    fatal: Option<SyncError>,
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
            local: LocalQueue::default(),
            saved: HashMap::new(),
            remote_due: None,
            blocked: None,
            pause: None,
            outbound: Outbound::Open,
            retry_at: None,
            last_error: None,
            reconnect: Reconnect::default(),
            dirty: false,
            last_save: now,
            next_git_poll: now,
            next_mailbox_poll: now,
            warned: BTreeSet::new(),
            fatal: None,
        }
    }

    fn notify(&self, notice: Notice) {
        if let Some(tx) = &self.notices {
            let _ = tx.send(notice);
        }
    }

    fn holding(&self) -> bool {
        matches!(self.outbound, Outbound::Holding { .. })
    }

    async fn start(&mut self, publish: bool) -> anyhow::Result<()> {
        self.synced.refresh(&self.session)?;
        self.reconnect().await;
        self.poll_git().await;
        let marker = self.hold_marker();
        if publish {
            remove_marker(&marker)?;
            self.outbound = Outbound::Published;
        }
        match &mut self.pause {
            // Whatever happened while sync was not running, the folder
            // gets the same check as after a branch switch on resume.
            Some(pause) => pause.left_branch = true,
            None => {
                // --publish is the go-ahead the check would ask for.
                if !publish && (marker.exists() || self.session.git_switched()) {
                    self.check_tree().await;
                    if !self.holding() {
                        remove_marker(&marker)?;
                    }
                }
                if !self.holding() {
                    self.local.rescan_now();
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
        let mut at = self.next_git_poll.min(self.next_mailbox_poll);
        let mut consider = |t: Option<Instant>| {
            if let Some(t) = t
                && t < at
            {
                at = t;
            }
        };
        consider(self.local.due);
        consider(self.remote_due);
        consider(self.retry_at);
        if !self.session.is_connected() {
            consider(self.reconnect.at);
        }
        if self.dirty {
            consider(Some(self.last_save + SAVE_EVERY));
        }
        at
    }

    fn on_change(&mut self, change: Change) {
        if matches!(change, Change::Requests) {
            self.next_mailbox_poll = Instant::now();
            return;
        }
        // Whatever a checkout of another branch does to the folder is
        // looked at as a whole when the tracked branch is back.
        if self.pause.as_ref().is_some_and(|p| p.left_branch) {
            return;
        }
        let now = Instant::now();
        let mut any = false;
        match change {
            Change::Rescan => {
                self.local.rescan = true;
                any = true;
            }
            Change::Requests => {}
            Change::Paths(paths) => {
                for abs in paths {
                    match self.synced.classify(self.session.worktree(), &abs) {
                        Seen::Changed(path) => {
                            self.saved.insert(path.clone(), now);
                            self.local.paths.insert(path);
                            any = true;
                        }
                        Seen::Folder => {
                            self.local.rescan = true;
                            any = true;
                        }
                        Seen::Nothing => {}
                    }
                }
            }
        }
        if any {
            self.local.due.get_or_insert(now);
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
        if self.stop_on(err) {
            return;
        }
        let line = format!("{err:#}");
        println!("sync: offline ({line}), reconnecting");
        self.reconnect.lost(line);
        self.notify(Notice::Offline);
    }

    async fn reconnect(&mut self) {
        let could_write = self.session.can_write();
        match self.session.connect().await {
            Ok(()) => {
                println!("sync: connected to {}", self.session.config.server);
                if could_write && !self.session.can_write() {
                    println!("sync: the link is view-only now, only receiving changes");
                }
                self.reconnect = Reconnect::default();
                // Edits made while offline went out in connect(); anything
                // that failed for lack of a connection can go again now.
                self.retry_at = None;
                self.blocked = None;
                self.dirty = true;
                self.notify(Notice::Connected);
            }
            Err(err) => {
                self.session.disconnect().await;
                if self.stop_on(&err) {
                    return;
                }
                let line = format!("{err:#}");
                if self.reconnect.shown.as_deref() != Some(line.as_str()) {
                    println!("sync: offline ({line}), retrying in the background");
                    self.notify(Notice::Offline);
                }
                self.reconnect.failed(line);
            }
        }
    }

    /// Does whatever is due. Called after every wakeup of the loop.
    async fn step(&mut self) {
        let now = Instant::now();
        if now >= self.next_git_poll {
            self.poll_git().await;
            self.next_git_poll = Instant::now() + GIT_POLL;
        }
        if now >= self.next_mailbox_poll {
            self.next_mailbox_poll = Instant::now() + MAILBOX_POLL;
            self.answer_requests().await;
        }
        if !self.session.is_connected() && self.reconnect.at.is_some_and(|t| t <= now) {
            self.reconnect().await;
        }
        let can_work = self.pause.is_none() && self.retry_at.is_none_or(|t| t <= now);
        if can_work {
            self.retry_at = None;
            if self.local.due.is_some_and(|t| t <= now) {
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

    /// Whether the doc holds remote changes the folder does not have yet,
    /// other than ones already found not to fit.
    fn remote_waiting(&self) -> bool {
        self.session.has_unwritten_remote()
            && self.blocked.as_ref() != Some(&self.session.doc().oplog_frontiers())
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

    /// Whether `err` ends the sync, which then stops after this step.
    fn stop_on(&mut self, err: &anyhow::Error) -> bool {
        match SyncError::fatal(err) {
            Some(fatal) => {
                self.fatal.get_or_insert_with(|| fatal.clone());
                true
            }
            None => false,
        }
    }

    fn error(&mut self, err: &anyhow::Error) {
        if self.stop_on(err) {
            return;
        }
        let line = format!("{err:#}");
        if self.last_error.as_deref() != Some(line.as_str()) {
            eprintln!("sync: {line}; retrying");
            self.last_error = Some(line);
        }
        self.retry_at = Some(Instant::now() + ERROR_RETRY);
    }

    async fn sync_local(&mut self) {
        let (batch, full) = self.local.take();
        if !self.session.can_write() {
            for path in batch {
                if self.warned.insert(path.clone()) {
                    eprintln!("warning: view-only link, not publishing {path}");
                }
            }
            return;
        }
        if self.holding() {
            self.recheck_hold().await;
            return;
        }
        // A `git reset --hard` or a quick checkout round trip can come and
        // go between two git polls without ever showing up as a pause. The
        // reconcile below records where HEAD is, so this only fires once.
        if self.outbound != Outbound::Published && self.session.git_switched() {
            self.check_tree().await;
            if self.holding() {
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
            .reconcile_holding(&scope, Mode::Push, &hot)
            .await
        {
            Ok(Reconciled::Done(mut report)) => {
                self.outbound = Outbound::Open;
                self.after(&mut report).await;
            }
            Ok(Reconciled::Held(paths)) => {
                let due = self.hot_until(&paths);
                self.local.restore(batch, full, due);
            }
            Err(err) => {
                self.local.restore(batch, full, Instant::now());
                self.error(&err);
            }
        }
    }

    async fn sync_remote(&mut self) {
        let hot = self.hot(&BTreeSet::new());
        let empty = Scope::Paths(BTreeSet::new());
        let outbound = self.session.can_write() && !self.holding();
        let mode = if outbound { Mode::Push } else { Mode::Pull };
        match self.session.reconcile_holding(&empty, mode, &hot).await {
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

    /// Takes the reconcile's base files for the watcher filter.
    async fn after(&mut self, report: &mut Report) {
        self.dirty = true;
        // Files the reconcile left alone only fit once the folder or the
        // doc changes again.
        self.blocked = self
            .session
            .pinned_paths()
            .next()
            .is_some()
            .then(|| self.session.doc().oplog_frontiers());
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
        // Without remote ops past the base, nothing can have changed
        // remotely under a fresh save.
        if !self.session.doc_past_base() {
            return BTreeSet::new();
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

    /// Stops after an error that reconnecting cannot fix, keeping what the
    /// run did so far. Edits not sent yet stay in the cached doc.
    async fn abort(mut self, err: SyncError) -> anyhow::Result<()> {
        eprintln!("sync: stopping, {err}");
        self.refuse_requests(&format!("typstry sync stopped: {err}"));
        print_warnings(&mut Output::terminal(), &mut self.session);
        self.session.save_compacted()?;
        self.session.disconnect().await;
        Err(err.into())
    }

    async fn shutdown(mut self) -> anyhow::Result<()> {
        println!("sync: stopping");
        self.refuse_requests("typstry sync is stopping; run the command again once it has");
        // After an unnoticed reset the folder may lack pulled edits; the
        // next run checks it before publishing anything.
        if self.pause.is_none()
            && !self.holding()
            && self.session.can_write()
            && (self.outbound == Outbound::Published || !self.session.git_switched())
        {
            // Covers edits the watcher has not reported yet.
            match self
                .session
                .reconcile(&Scope::Full, Mode::Push, Flush::Deferred)
                .await
            {
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
        self.session.save_compacted()?;
        self.session.disconnect().await;
        Ok(())
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
