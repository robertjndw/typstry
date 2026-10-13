use super::init::confirmed;
use super::members::publish_rotation;
use super::{Ctx, Output};

/// Manage the project's share links.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Replace the links with new ones, for a link that leaked. The
    /// project owner only. Members keep their access and switch over the
    /// next time they sync; anyone who only has an old link loses access.
    Reset {
        /// Do not ask for confirmation. In a terminal you are asked before
        /// the links are replaced.
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let Action::Reset { yes } = args.action;
    let mut session = ctx.open()?;
    let mut out = Output::terminal();
    if !session.can_write() {
        anyhow::bail!(
            "only the project owner can reset the links, and this folder has a view-only link"
        );
    }
    if !confirmed(
        yes,
        "Replace the project's links? Members switch over on their next sync; \
         anyone with only an old link loses access.",
    )? {
        out.out("Nothing replaced.");
        return Ok(());
    }
    session.reset_links().await?;
    publish_rotation(&mut session, &mut out).await
}
