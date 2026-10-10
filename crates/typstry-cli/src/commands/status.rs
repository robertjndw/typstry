use std::collections::BTreeMap;

use crate::engine::{ChangeKind, Scope, Session};
use crate::mailbox::Request;
use crate::watch::GitState;

use super::{Ctx, Fetch, Output, print_list, track_branch, warn_skipped};

/// Show files changed locally and remotely since the last sync.
///
/// While `typstry sync` runs in the folder, the running sync answers.
#[derive(Debug, clap::Args)]
#[command(mut_arg("offline", |arg| {
    arg.help("Compare against the cached copy of the project instead of fetching")
}))]
pub struct Args {
    #[command(flatten)]
    pub fetch: Fetch,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let Some((mut session, mut out)) = ctx.open_current(Request::Status, &args.fetch).await? else {
        return Ok(());
    };
    track_branch(&mut session, &mut out)?;
    print_status(&mut session, &mut out).await
}

/// The status of an open folder, as of the doc the session holds.
pub async fn print_status(session: &mut Session, out: &mut Output) -> anyhow::Result<()> {
    let repo = session.repo().cloned();
    let found = repo.as_ref().map(|repo| (repo, repo.head()));
    if let Some(reason) = GitState::of(found, session.config.branch.as_deref()).reason() {
        out.out(format!("{reason}: pull and push are paused"));
    }
    let status = session.status(&Scope::Full).await?;
    let lines = |changes: &BTreeMap<String, ChangeKind>| {
        changes
            .iter()
            .map(|(path, kind)| format!("{} {path}", kind.symbol()))
            .collect::<Vec<_>>()
    };
    if status.local.is_empty() && status.remote.is_empty() {
        out.out("Everything up to date.");
    }
    print_list(
        out,
        "Local changes (typstry push to publish):",
        lines(&status.local),
    );
    print_list(
        out,
        "Remote changes (typstry pull to fetch):",
        lines(&status.remote),
    );
    if !status.local.is_empty() && session.git_switched() {
        out.out(
            "git switched branches or reset since the last sync, so some local changes may be dropped co-author edits; typstry push needs --force",
        );
    }
    for skipped in &status.skipped {
        warn_skipped(out, skipped);
    }
    Ok(())
}
