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
    let branch = args.branch.trim();
    // An empty name matches no HEAD, so sync would stay paused for good.
    if branch.is_empty() {
        anyhow::bail!("the branch name must not be empty");
    }
    let mut session = ctx.open()?;
    match Repo::discover(session.root()) {
        None => eprintln!(
            "warning: this folder is not in a git repository, so the branch has no effect"
        ),
        // An unborn branch has no ref yet but is checked out.
        Some(repo) if !repo.branch_exists(branch) && !repo.head().is_on(Some(branch)) => {
            eprintln!(
                "warning: there is no branch {branch} in this repository (yet); \
                 sync pauses until it is checked out"
            );
        }
        Some(_) => {}
    }
    session.config.branch = Some(branch.to_owned());
    session.save_config()?;
    println!("tracking git branch {branch}");
    Ok(())
}
