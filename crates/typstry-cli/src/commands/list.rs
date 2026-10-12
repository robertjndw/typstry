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

pub fn run(args: Args) -> anyhow::Result<()> {
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
        if args.missing && entry.dir.is_some() {
            continue;
        }
        shown += 1;
        match &entry.dir {
            Some(dir) => println!("{:>3}. {}\n       {}", i + 1, entry.title, dir.display()),
            None => println!(
                "{:>3}. {}\n       not on this device: typstry clone {}",
                i + 1,
                entry.title,
                i + 1
            ),
        }
    }
    if shown == 0 {
        println!("Every project is on this device.");
    }
    Ok(())
}
