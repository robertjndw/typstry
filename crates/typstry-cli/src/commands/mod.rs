//! The command line: one module per subcommand, each with its clap `Args`
//! and an async `run`.

pub mod clone;
pub mod devices;
pub mod export;
pub mod info;
pub mod init;
pub mod link;
pub mod list;
pub mod members;
pub mod open;
pub mod pair;
pub mod pull;
pub mod push;
pub mod share;
pub mod status;
pub mod sync;
pub mod track;
pub mod version;

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

use anyhow::bail;
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

use typstry_doc::apply::ApplyReport;

use crate::engine::{ChangeKind, Report, Scope, Session};
use crate::git::{Head, Repo};
use crate::mailbox::{self, Request};
use crate::state::SyncRunning;
use crate::watch::GitState;
use crate::worktree::Skipped;

#[derive(Debug, Parser)]
#[command(
    name = "typstry",
    version,
    about = "Sync a typstry project with a local folder",
    long_about = "Sync a typstry project with a local folder.\n\n\
        The folder can be a git repository you fully control: typstry only \
        moves files, end-to-end encrypted, and never commits, except for \
        the initial commit of `clone --git`."
)]
pub struct Cli {
    /// Run as if started in this folder.
    #[arg(short = 'C', global = true, value_name = "DIR")]
    pub cwd: Option<PathBuf>,
    /// Author name shown in the project history; defaults to
    /// `git config user.name`.
    #[arg(long, global = true, value_name = "NAME")]
    pub name: Option<String>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Clone(clone::Args),
    Status(status::Args),
    Pull(pull::Args),
    Push(push::Args),
    Sync(sync::Args),
    Track(track::Args),
    Init(init::Args),
    Link(link::Args),
    Members(members::Args),
    Share(share::Args),
    Open(open::Args),
    Pair(pair::Args),
    List(list::Args),
    Devices(devices::Args),
    Info(info::Args),
    Version(version::Args),
    Export(export::Args),
}

/// What every command gets besides its own arguments.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub dir: PathBuf,
    pub name: Option<String>,
}

impl Ctx {
    pub fn open(&self) -> anyhow::Result<Session> {
        Session::open(&self.dir, self.name.as_deref())
    }

    /// Opens the folder, or, while `typstry sync` holds it, has the running
    /// sync handle `request` and prints its answer. None then: the command
    /// is done.
    pub async fn open_or_ask(&self, request: Request) -> anyhow::Result<Option<Session>> {
        match self.open() {
            Ok(session) => Ok(Some(session)),
            Err(err) => match err.downcast::<SyncRunning>() {
                Ok(running) => {
                    mailbox::ask(&running, &request).await?;
                    Ok(None)
                }
                Err(err) => Err(err),
            },
        }
    }

    /// [`Self::open_or_ask`] for commands that only read the project, with
    /// the cached doc brought up to date unless `fetch` says not to.
    pub async fn open_current(
        &self,
        request: Request,
        fetch: &Fetch,
    ) -> anyhow::Result<Option<(Session, Output)>> {
        let Some(mut session) = self.open_or_ask(request).await? else {
            return Ok(None);
        };
        let mut out = Output::terminal();
        fetch.refresh(&mut session, &mut out).await?;
        Ok(Some((session, out)))
    }
}

/// `--offline`, for commands that read the project but can make do with
/// the cached copy.
#[derive(Debug, clap::Args)]
pub struct Fetch {
    /// Use the cached copy of the project instead of fetching.
    #[arg(long)]
    pub offline: bool,
}

impl Fetch {
    pub async fn refresh(&self, session: &mut Session, out: &mut Output) -> anyhow::Result<()> {
        if !self.offline {
            session.refresh().await?;
            print_warnings(out, session);
        }
        Ok(())
    }
}

/// Runs `body` connected, and disconnects afterwards whatever happened, so
/// the server sees a close frame rather than a dropped socket.
pub async fn connected<T>(
    session: &mut Session,
    body: impl AsyncFnOnce(&mut Session) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let result = match session.connect().await {
        Ok(()) => body(session).await,
        Err(err) => Err(err),
    };
    session.disconnect().await;
    result
}

pub async fn run(cli: Cli) -> anyhow::Result<()> {
    let ctx = Ctx {
        dir: cli.cwd.unwrap_or_else(|| PathBuf::from(".")),
        name: cli.name,
    };
    match cli.command {
        Command::Clone(args) => clone::run(&ctx, args).await,
        Command::Status(args) => status::run(&ctx, args).await,
        Command::Pull(args) => pull::run(&ctx, args).await,
        Command::Push(args) => push::run(&ctx, args).await,
        Command::Sync(args) => sync::run(&ctx, args).await,
        Command::Track(args) => track::run(&ctx, args),
        Command::Init(args) => init::run(&ctx, args).await,
        Command::Link(args) => link::run(&ctx, args),
        Command::Members(args) => members::run(&ctx, args).await,
        Command::Share(args) => share::run(&ctx, args).await,
        Command::Open(args) => open::run(&ctx, args),
        Command::Pair(args) => pair::run(&ctx, args).await,
        Command::List(args) => list::run(args),
        Command::Devices(args) => devices::run(&ctx, args).await,
        Command::Info(args) => info::run(&ctx, args).await,
        Command::Version(args) => version::run(&ctx, args).await,
        Command::Export(args) => export::run(&ctx, args).await,
    }
}

/// The repo the project lives in, after recording its current branch as
/// the tracked one if none is set yet.
pub fn track_branch(
    session: &mut Session,
    out: &mut Output,
) -> anyhow::Result<Option<(Repo, Head)>> {
    let Some(repo) = session.repo().cloned() else {
        return Ok(None);
    };
    let head = repo.head();
    if session.config.branch.is_none()
        && let Head::Branch(branch) = &head
    {
        session.config.branch = Some(branch.clone());
        session.save_config()?;
        out.out(format!("tracking git branch {branch}"));
    }
    Ok(Some((repo, head)))
}

/// Refuses to sync files while the checkout is not the tracked branch, or
/// while git is in the middle of rewriting them. Other branches are
/// private drafts; syncing there would publish them.
pub fn guard_branch(session: &mut Session, force: bool, out: &mut Output) -> anyhow::Result<()> {
    let (repo, head) = track_branch(session, out)?.unzip();
    let state = GitState::of(repo.as_ref().zip(head), session.config.branch.as_deref());
    let Some(reason) = state.reason() else {
        return Ok(());
    };
    // A repo that was only ever seen with a detached HEAD has no branch
    // to suggest going back to.
    let untracked = matches!(state, GitState::Elsewhere { tracked: None, .. });
    if !force {
        match state {
            GitState::Busy(_) => bail!("{reason}; finish it first (use --force to sync anyway)"),
            _ if untracked => bail!("{reason} (use `typstry track <branch>` or --force)"),
            _ => bail!("{reason} (use --force to sync anyway)"),
        }
    }
    if !untracked {
        out.err(format!("warning: {reason}; syncing anyway"));
    }
    Ok(())
}

/// Refuses to publish a folder that differs from the last sync after git
/// switched branches or reset since then: the differences may be edits
/// pulled from co-authors that the checkout dropped, and publishing would
/// revert them for everyone.
pub async fn guard_switch(session: &mut Session, force: bool) -> anyhow::Result<()> {
    if force || !session.can_write() || !session.git_switched() {
        return Ok(());
    }
    let status = session.status(&Scope::Full).await?;
    if status.local.is_empty() {
        return Ok(());
    }
    Err(switch_refusal(&status.local))
}

/// Why publishing after a branch switch needs --force, with the files.
fn switch_refusal(local: &BTreeMap<String, ChangeKind>) -> anyhow::Error {
    let mut list = String::new();
    for (path, kind) in local {
        let _ = write!(list, "\n  {} {path}", kind.symbol());
    }
    anyhow::anyhow!(
        "git switched branches or reset since the last sync, and {} file(s) differ from it:{list}\n\
         If the switch dropped edits pulled from co-authors, pushing would revert them for everyone. \
         Check with `typstry status` and `git diff`, then publish with --force.",
        local.len()
    )
}

/// Where a command's lines go: straight to the terminal, or collected so
/// a running `typstry sync` can send them to the command that asked it.
#[derive(Debug, Default)]
pub struct Output {
    collected: Option<Vec<Line>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "to", content = "text", rename_all = "lowercase")]
pub enum Line {
    Stdout(String),
    Stderr(String),
}

impl Line {
    pub fn print(&self) {
        match self {
            Self::Stdout(text) => println!("{text}"),
            Self::Stderr(text) => eprintln!("{text}"),
        }
    }
}

impl Output {
    pub fn terminal() -> Self {
        Self::default()
    }

    pub fn collect() -> Self {
        Self {
            collected: Some(Vec::new()),
        }
    }

    fn line(&mut self, line: Line) {
        match &mut self.collected {
            Some(lines) => lines.push(line),
            None => line.print(),
        }
    }

    pub fn out(&mut self, text: impl Into<String>) {
        self.line(Line::Stdout(text.into()));
    }

    pub fn err(&mut self, text: impl Into<String>) {
        self.line(Line::Stderr(text.into()));
    }

    pub fn into_lines(self) -> Vec<Line> {
        self.collected.unwrap_or_default()
    }
}

/// Prints `label` and the paths under it, if there are any.
/// Shortest fingerprint prefix taken as one, so a short device name is not
/// mistaken for the start of a fingerprint.
const MIN_PREFIX: usize = 4;

/// The one item of `items`, None if there is none, and the error from
/// `ambiguous` if there are several.
fn unique<T>(
    mut items: impl Iterator<Item = T>,
    ambiguous: impl FnOnce() -> anyhow::Error,
) -> anyhow::Result<Option<T>> {
    match (items.next(), items.next()) {
        (Some(_), Some(_)) => Err(ambiguous()),
        (first, _) => Ok(first),
    }
}

fn print_list(out: &mut Output, label: &str, items: impl IntoIterator<Item = String>) {
    let items: Vec<String> = items.into_iter().collect();
    if items.is_empty() {
        return;
    }
    out.out(label);
    for item in items {
        out.out(format!("  {item}"));
    }
}

/// Lines shared by pull and push: what was written, deleted, skipped.
fn print_report(out: &mut Output, report: &Report) {
    for path in &report.written {
        out.out(format!("\u{2193} {path}"));
    }
    for path in &report.deleted {
        out.out(format!("\u{2193} {path} (deleted)"));
    }
    for skipped in &report.status.skipped {
        warn_skipped(out, skipped);
    }
    print_report_warnings(out, report);
}

fn print_report_warnings(out: &mut Output, report: &Report) {
    for warning in &report.warnings {
        out.err(format!("warning: {warning}"));
    }
}

/// Lines shared by push and sync: what went out. `verb` says what was not
/// done to a skipped file, e.g. "pushing".
fn print_applied(out: &mut Output, applied: &ApplyReport, verb: &str) {
    for path in &applied.created {
        out.out(format!("\u{2191} {path} (new)"));
    }
    for path in &applied.modified {
        out.out(format!("\u{2191} {path}"));
    }
    for renamed in &applied.renamed {
        out.out(format!("\u{2191} {} -> {}", renamed.from, renamed.to));
    }
    for path in &applied.deleted {
        out.out(format!("\u{2191} {path} (deleted)"));
    }
    print_not_applied(out, applied, verb);
}

fn print_not_applied(out: &mut Output, applied: &ApplyReport, verb: &str) {
    for skipped in &applied.skipped {
        out.err(format!(
            "warning: not {verb} {}: {}",
            skipped.path, skipped.reason
        ));
    }
}

/// Warnings the session ran into outside a reconcile, whose report
/// carries its own.
fn print_warnings(out: &mut Output, session: &mut Session) {
    for warning in session.take_warnings() {
        out.err(format!("warning: {warning}"));
    }
}

fn warn_skipped(out: &mut Output, skipped: &Skipped) {
    if skipped.path.is_empty() {
        out.err(format!("warning: {}", skipped.reason));
    } else {
        out.err(format!("warning: skipped {skipped}"));
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;

    #[test]
    fn cli_is_well_formed() {
        Cli::command().debug_assert();
    }
}
