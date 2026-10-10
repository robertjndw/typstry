use crate::engine::{Conflicts, Mode, Scope};
use crate::mailbox::Request;

use super::{Ctx, Output, guard_branch, print_report};

/// Write remote changes to the folder.
///
/// Files that changed both locally and remotely are left alone and listed,
/// and the command fails; everything else is pulled. `typstry push` merges
/// such files instead.
///
/// While `typstry sync` runs in the folder there is nothing to do: it
/// pulls remote changes as they come in. pull then only says so.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Sync even when git is not on the tracked branch.
    #[arg(long)]
    pub force: bool,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let Some(mut session) = ctx.open_or_ask(Request::Pull).await? else {
        return Ok(());
    };
    guard_branch(&mut session, args.force)?;
    session.connect().await?;
    let report = session.reconcile(&Scope::Full, Mode::Pull).await?;
    session.disconnect().await;
    print_report(&mut Output::terminal(), &report);
    if !report.conflicts.is_empty() {
        return Err(Conflicts {
            paths: report.conflicts,
        }
        .into());
    }
    if report.written.is_empty() && report.deleted.is_empty() {
        println!("Already up to date.");
    }
    if !report.status.local.is_empty() {
        println!(
            "{} local change(s) not pushed yet; see typstry status",
            report.status.local.len()
        );
    }
    Ok(())
}
