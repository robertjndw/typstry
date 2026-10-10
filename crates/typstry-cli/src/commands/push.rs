use crate::engine::{Flush, Mode, Report, Scope};
use crate::mailbox::Request;

use super::{
    Ctx, Output, connected, guard_branch, guard_switch, print_applied, print_list, print_report,
};

/// Publish local changes, merged with whatever changed remotely.
///
/// Local edits are diffed against the last sync, so concurrent edits to the
/// same file merge instead of overwriting each other. The merged result is
/// written back to the folder.
#[derive(Debug, clap::Args)]
#[command(after_long_help = "\
After a branch switch or `git reset` since the last sync, files that \
differ from it may be co-author edits the checkout dropped rather than \
your own. push then lists them and stops; publish them with --force once \
you have checked them.

While `typstry sync` runs in the folder, push has it publish right away \
instead. Changes sync holds back after a branch switch go out with \
--force, like typing `push` in the sync terminal.")]
pub struct Args {
    /// Sync even when git is not on the tracked branch, or after a branch
    /// switch left files that differ from the last sync.
    #[arg(long)]
    pub force: bool,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let request = Request::Push { force: args.force };
    let Some(mut session) = ctx.open_or_ask(request).await? else {
        return Ok(());
    };
    let mut out = Output::terminal();
    guard_branch(&mut session, args.force, &mut out)?;
    guard_switch(&mut session, args.force).await?;
    let report = connected(&mut session, async |session| {
        session
            .reconcile(&Scope::Full, Mode::Push, Flush::Now)
            .await
    })
    .await?;
    print_pushed(&mut out, &report);
    Ok(())
}

pub fn print_pushed(out: &mut Output, report: &Report) {
    let applied = &report.applied;
    print_applied(out, applied, "pushing");
    print_report(out, report);
    print_list(
        out,
        "Changed on both sides and merged, review with git diff:",
        report.merged.iter().cloned(),
    );
    if !applied.changed && report.written.is_empty() && report.deleted.is_empty() {
        out.out("Everything up to date.");
    }
}
