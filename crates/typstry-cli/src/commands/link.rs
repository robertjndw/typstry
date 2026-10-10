use anyhow::bail;

use super::Ctx;
use crate::api::Permission;
use crate::state::{Config, StateDir};

/// Print the share links of the project in this folder.
///
/// Works offline. The view link of an edit clone is learned from the
/// server on clone and on every later connection.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Print only the edit link, for scripts.
    #[arg(long, conflicts_with = "view")]
    pub edit: bool,
    /// Print only the view-only link, for scripts.
    #[arg(long)]
    pub view: bool,
}

/// Which link a caller wants on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    Edit,
    View,
}

pub fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let config = StateDir::peek_config(&ctx.dir)?;
    let which = match (args.edit, args.view) {
        (true, _) => Some(Which::Edit),
        (_, true) => Some(Which::View),
        _ => None,
    };
    print_links(&config, which)
}

/// The URL for `which`, or a reason why this folder does not know it.
pub fn url(config: &Config, which: Which) -> anyhow::Result<String> {
    match which {
        Which::Edit if config.permission == Permission::Read => {
            bail!("this folder was cloned with a view-only link, so the edit link is not available")
        }
        Which::Edit => Ok(config.link().to_string()),
        Which::View => match config.view_link() {
            Some(link) => Ok(link.to_string()),
            None => bail!(
                "the view link is not known yet; run a command that connects, e.g. typstry status, then try again"
            ),
        },
    }
}

/// `Edit: ...` and `View: ...` lines, or a bare URL when `which` is set.
pub fn print_links(config: &Config, which: Option<Which>) -> anyhow::Result<()> {
    if let Some(which) = which {
        println!("{}", url(config, which)?);
        return Ok(());
    }
    match url(config, Which::Edit) {
        Ok(edit) => println!("Edit: {edit}"),
        Err(err) => eprintln!("note: {err}"),
    }
    match url(config, Which::View) {
        Ok(view) => println!("View: {view}"),
        Err(err) => eprintln!("note: {err}"),
    }
    Ok(())
}
