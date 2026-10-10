use std::collections::BTreeMap;

use typstry_doc::paths::build_path_index;

use super::version::format_ms;
use super::{Ctx, Output, track_branch};
use crate::engine::{ChangeKind, Scope, Session};
use crate::git::Repo;
use crate::mailbox::Request;

/// Show the project linked to this folder and its sync state.
///
/// While `typstry sync` runs in the folder, the running sync answers.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Use the cached copy of the project instead of fetching.
    #[arg(long)]
    pub offline: bool,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let request = Request::Info {
        offline: args.offline,
    };
    let Some(mut session) = ctx.open_or_ask(request).await? else {
        return Ok(());
    };
    track_branch(&mut session)?;
    if !args.offline {
        session.refresh().await?;
    }
    print_info(
        &mut session,
        args.offline,
        "not running",
        &mut Output::terminal(),
    )
    .await
}

/// What the folder is linked to and how it stands. `sync` describes
/// whether `typstry sync` runs; `offline` that the doc was not refreshed.
pub async fn print_info(
    session: &mut Session,
    offline: bool,
    sync: &str,
    out: &mut Output,
) -> anyhow::Result<()> {
    let head = Repo::discover(session.root()).map(|repo| repo.head());
    let doc = &session.doc;
    let config = &session.config;
    let main = typstry_doc::main_file(doc)
        .and_then(|id| build_path_index(doc).by_id.get(&id).map(|e| e.path.clone()));
    let versions = typstry_doc::named_versions(doc).len();

    out.out(format!(
        "Title:       {}",
        typstry_doc::title(doc).unwrap_or_else(|| "(untitled)".to_owned())
    ));
    out.out(format!("Folder:      {}", session.root().display()));
    out.out(format!("Server:      {}", config.server));
    out.out(format!("Project:     {}", config.project_id));
    out.out(format!(
        "Permission:  {}",
        if session.can_write() {
            "edit"
        } else {
            "view only"
        }
    ));
    out.out(format!(
        "Main file:   {}",
        main.as_deref().unwrap_or("(none)")
    ));
    let branch = match (&head, &config.branch) {
        (None, _) => "not a git repository".to_owned(),
        (Some(_), None) => "no branch tracked yet".to_owned(),
        (Some(head), Some(tracked)) if head.is_on(Some(tracked)) => {
            format!("tracks {tracked}")
        }
        (Some(head), Some(tracked)) => format!("tracks {tracked}, paused on {head}"),
    };
    out.out(format!("Git:         {branch}"));
    out.out(format!("Sync:        {sync}"));
    out.out(format!("Versions:    {versions} named"));
    out.out(format!(
        "Last sync:   {}{}",
        session
            .base
            .last_sync
            .map_or_else(|| "never".to_owned(), |ms| format_ms(ms as i64)),
        if offline { " (offline)" } else { "" }
    ));

    let status = session.status(&Scope::Full).await?;
    out.out(format!(
        "Local:       {}",
        counts(&status.local, "typstry push")
    ));
    out.out(format!(
        "Remote:      {}",
        counts(&status.remote, "typstry pull")
    ));
    Ok(())
}

fn counts(changes: &BTreeMap<String, ChangeKind>, hint: &str) -> String {
    if changes.is_empty() {
        return "up to date".to_owned();
    }
    let count = |kind| changes.values().filter(|k| **k == kind).count();
    format!(
        "{} change(s): {} added, {} modified, {} deleted ({hint})",
        changes.len(),
        count(ChangeKind::Added),
        count(ChangeKind::Modified),
        count(ChangeKind::Deleted)
    )
}
