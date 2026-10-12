use typstry_doc::directory::State;

use crate::space::sync_bound;
use crate::user::catalog;

/// List your projects, including the ones other devices of yours have.
///
/// Projects that only exist on your other devices (handed over by
/// `typstry pair`) show a `typstry clone` shortcut. Pass its number or the
/// project title to `typstry clone` instead of the link.
#[derive(Debug, clap::Args)]
#[command(visible_alias = "ls")]
pub struct Args {
    /// Only the projects without a folder on this device.
    #[arg(long)]
    pub missing: bool,
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    // Before reading, so projects the person's other devices added show up.
    sync_bound().await;
    print_catalog(args.missing)
}

/// Prints the projects as `typstry list` does, from what is on disk.
pub fn print_catalog(missing: bool) -> anyhow::Result<()> {
    let entries = catalog()?;
    if entries.is_empty() {
        println!(
            "No projects yet. Create one with `typstry init`, or pair with a device of yours."
        );
        return Ok(());
    }
    // Numbers stay those of the full list, so `clone <n>` means the same
    // thing with and without --missing.
    let mut shown = 0;
    for (i, entry) in entries.iter().enumerate() {
        if missing && entry.dir.is_some() {
            continue;
        }
        shown += 1;
        let why = match entry.state {
            State::Removed => Some("you were removed from this project"),
            State::Gone => Some("the server no longer knows this project"),
            State::Listed | State::Forgotten => None,
        };
        match (&entry.dir, why) {
            (Some(dir), None) => {
                println!("{:>3}. {}\n       {}", i + 1, entry.title, dir.display())
            }
            (Some(dir), Some(why)) => println!(
                "{:>3}. {}\n       {}\n       unavailable: {why}",
                i + 1,
                entry.title,
                dir.display()
            ),
            (None, None) => println!(
                "{:>3}. {}\n       not on this device: typstry clone {}",
                i + 1,
                entry.title,
                i + 1
            ),
            (None, Some(why)) => {
                println!("{:>3}. {}\n       unavailable: {why}", i + 1, entry.title)
            }
        }
    }
    if shown == 0 {
        println!("Every project is on this device.");
    }
    Ok(())
}
