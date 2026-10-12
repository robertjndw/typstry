use std::process::{Command, Stdio};

use anyhow::{Context, bail};

use super::Ctx;
use super::link::{Which, url};
use crate::state::StateDir;

/// Open the project in the browser.
///
/// Uses the edit link, or the view link with --view. Set TYPSTRY_BROWSER
/// to a command to use instead of the system default; it gets the URL as
/// its only argument.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Open the view-only link.
    #[arg(long)]
    pub view: bool,
    /// Only print the URL instead of opening it.
    #[arg(long)]
    pub print: bool,
}

pub fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let config = StateDir::peek_config(&ctx.dir)?;
    let which = if args.view { Which::View } else { Which::Edit };
    let url = url(&config, which)?;
    if args.print {
        println!("{url}");
        return Ok(());
    }
    // The URL carries the key, so it is not echoed by default: it would
    // end up in terminal scrollback and screen shares.
    println!(
        "Opening the {} link in the browser",
        if args.view { "view" } else { "edit" }
    );
    launch(&url, false)
}

/// Opens `url` in the browser without printing it. `quiet` keeps the
/// opener off the terminal, for interactive views it would scribble over.
pub fn launch(url: &str, quiet: bool) -> anyhow::Result<()> {
    let mut command = opener(url);
    if quiet {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }
    let status = command
        .status()
        .with_context(|| format!("cannot run {:?}", command.get_program()))?;
    if !status.success() {
        bail!(
            "{:?} failed ({status}); use typstry link to copy the URL instead",
            command.get_program()
        );
    }
    Ok(())
}

/// [`launch`] off the async runtime, for interactive views: the opener
/// may wait for the browser to exit, which must not freeze the view. A
/// failure is printed, so a capturing view shows it.
pub fn launch_in_background(url: String) {
    tokio::task::spawn_blocking(move || {
        if let Err(err) = launch(&url, true) {
            say_err!("Cannot open the browser: {err:#}");
        }
    });
}

fn opener(url: &str) -> Command {
    if let Some(browser) = std::env::var_os("TYPSTRY_BROWSER").filter(|b| !b.is_empty()) {
        let mut command = Command::new(browser);
        command.arg(url);
        return command;
    }
    if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else if cfg!(windows) {
        // start is a cmd builtin; its first quoted argument is the window
        // title, hence the empty one.
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    }
}
