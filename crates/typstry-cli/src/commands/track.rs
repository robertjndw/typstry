use super::Ctx;
use crate::git::Repo;

/// Set the git branch typstry syncs on.
///
/// On any other branch, pull and push refuse to run, so branches work as
/// private drafts and merging into the tracked branch publishes them.
/// Stop `typstry sync` first; it does not change branches while running.
#[derive(Debug, clap::Args)]
pub struct Args {
    pub branch: String,
}

pub fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let mut session = ctx.open()?;
    if Repo::discover(session.root()).is_none() {
        eprintln!("warning: this folder is not in a git repository, so the branch has no effect");
    }
    session.config.branch = Some(args.branch.clone());
    session.save_config()?;
    println!("tracking git branch {}", args.branch);
    Ok(())
}
