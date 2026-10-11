use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

use super::init::absolute;
use super::{Ctx, Output, print_report, print_warnings, track_branch};
use crate::api::Api;
use crate::engine::{Flush, Mode, Scope, Session};
use crate::git::{self, Repo};
use crate::link::ShareLink;
use crate::state::{STATE_DIR, StateDir};

/// Copy a project into a new folder and link the folder to it.
#[derive(Debug, clap::Args)]
#[command(after_long_help = "\
The link holds the project key. On the command line it ends up in your \
shell history and is visible to other users of the machine while clone \
runs, so on shared machines pass it on standard input instead:

  pbpaste | typstry clone - thesis

or in the environment, as TYPSTRY_LINK, with the link argument left out.")]
pub struct Args {
    /// The edit or view link from the share dialog, including the `#key`;
    /// `-` reads it from standard input. A number or a project title from
    /// `typstry list` works too.
    // The link holds the key, so --help must not echo it.
    #[arg(env = "TYPSTRY_LINK", hide_env_values = true)]
    pub link: Option<String>,
    /// Where to put the files; must be new or empty. Defaults to a folder
    /// named after the project title.
    pub dir: Option<PathBuf>,
    /// Also turn the folder into a git repository with one commit holding
    /// the project files.
    #[arg(long)]
    pub git: bool,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let link = read_link(args.link.as_deref())?;
    let link = ShareLink::parse(&resolve_listed(&link)?)?;
    let explicit = args.dir.map(|dir| ctx.dir.join(dir));
    // Everything that can fail without the network fails before it.
    let parent = match &explicit {
        Some(dir) => dir.parent().map(Path::to_path_buf).unwrap_or_default(),
        None => ctx.dir.clone(),
    };
    if args.git {
        if !git::available() {
            bail!("--git needs git, which is not installed or not on PATH");
        }
        let probe = explicit
            .as_deref()
            .filter(|d| d.exists())
            .unwrap_or(&parent);
        if let Some(repo) = Repo::discover(probe) {
            bail!(
                "{} is already inside the git repository {}; clone without --git to use that one",
                probe.display(),
                repo.workdir.display()
            );
        }
    }
    if let Some(dir) = &explicit {
        check_empty(dir)?;
    }
    // Same refusal as init: the outer project's scan would pick up the
    // clone's files and publish them into the other project.
    if let Ok(abs) = absolute(if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        &parent
    }) && let Some(outer) = StateDir::find_root(&abs)
    {
        bail!(
            "{} is inside the typstry project in {}; a nested project would be synced twice",
            abs.display(),
            outer.display()
        );
    }

    let api = Api::new(&link.origin)?;
    let share = api.resolve_share(&link.token).await?;
    if share.retired {
        bail!("this link was replaced by a newer one; ask an editor for the current link");
    }
    let staging = match &explicit {
        Some(dir) => dir.clone(),
        None => parent.join(format!(".typstry-clone-{}", share.project_id)),
    };
    check_empty(&staging)?;
    let created = !staging.exists();
    fs::create_dir_all(&staging).with_context(|| format!("creating {}", staging.display()))?;

    let title = match fetch(&staging, &link, &share, api.clone(), ctx).await {
        Ok(title) => title,
        Err(err) => {
            // Leaves the folder as it was: empty, or gone if we made it.
            let _ = fs::remove_dir_all(staging.join(STATE_DIR));
            if created {
                let _ = fs::remove_dir(&staging);
            }
            return Err(err);
        }
    };
    let root = match explicit {
        Some(dir) => dir,
        None => {
            let target = parent.join(folder_name(title.as_deref()));
            if target.exists() {
                let _ = fs::remove_dir_all(&staging);
                bail!(
                    "{} already exists; pass a folder name: typstry clone <link> <dir>",
                    target.display()
                );
            }
            fs::rename(&staging, &target)
                .with_context(|| format!("moving the clone to {}", target.display()))?;
            target
        }
    };

    let mut session = Session::open_with_api(&root, ctx.name.as_deref(), api)?;
    let report = session
        .reconcile(&Scope::Full, Mode::Pull, Flush::Now)
        .await?;
    let mut out = Output::terminal();
    print_report(&mut out, &report);
    session.remember_project();
    print_warnings(&mut out, &mut session);

    let title = title.unwrap_or_else(|| "untitled".to_owned());
    if args.git {
        init_repo(&root, &title)?;
    } else if let Some(repo) = Repo::discover(&root) {
        repo.exclude_state_dir()?;
    }
    track_branch(&mut session, &mut out)?;

    println!(
        "Cloned {title:?} into {} ({} file(s){})",
        root.display(),
        report.written.len(),
        if !session.can_write() {
            ", view-only"
        } else {
            ""
        }
    );
    Ok(())
}

/// Fetches the project into a fresh `.typstry/` in `dir` and returns its
/// title. Files are written later, once the folder has its final name.
async fn fetch(
    dir: &Path,
    link: &ShareLink,
    share: &crate::api::ShareInfo,
    api: Api,
    ctx: &Ctx,
) -> anyhow::Result<Option<String>> {
    let mut session = Session::create_with_api(dir, link, share, api, None, ctx.name.as_deref())?;
    session.connect().await?;
    session.disconnect().await;
    print_warnings(&mut Output::terminal(), &mut session);
    session.save()?;
    Ok(typstry_doc::title(session.doc()))
}

fn read_link(arg: Option<&str>) -> anyhow::Result<String> {
    // clap hands over a set but empty TYPSTRY_LINK as a value.
    match arg.filter(|link| !link.trim().is_empty()) {
        Some("-") => {
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .context("reading the link from standard input")?;
            if line.trim().is_empty() {
                bail!("expected the link on standard input");
            }
            Ok(line)
        }
        Some(link) => Ok(link.to_owned()),
        None => bail!("pass the link, `-` to read it from standard input, or set TYPSTRY_LINK"),
    }
}

/// Turns a number or title from `typstry list` into that project's link;
/// anything else is passed through as a link.
fn resolve_listed(input: &str) -> anyhow::Result<String> {
    let input = input.trim();
    if input.contains('#') || input.contains("://") {
        return Ok(input.to_owned());
    }
    let catalog = crate::user::catalog()?;
    let picked = match input.parse::<usize>() {
        Ok(n) => catalog.get(n.wrapping_sub(1)),
        Err(_) => {
            let matches: Vec<_> = catalog
                .iter()
                .filter(|e| e.title.eq_ignore_ascii_case(input))
                .collect();
            match matches.as_slice() {
                [one] => Some(*one),
                [] => None,
                _ => bail!("several projects are called {input:?}; pick one by number"),
            }
        }
    };
    match picked {
        Some(entry) => Ok(entry.link.clone()),
        None => bail!("{input:?} is neither a link nor a project in `typstry list`"),
    }
}

/// Accepts a folder that does not exist yet or is empty.
pub(super) fn check_empty(dir: &Path) -> anyhow::Result<()> {
    match fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                bail!("{} exists and is not empty", dir.display());
            }
            Ok(())
        }
        Err(_) if dir.exists() => bail!("{} is not a folder", dir.display()),
        Err(_) => Ok(()),
    }
}

/// A folder name for a project title: path separators, control
/// characters and leading dots go, whitespace becomes a hyphen.
fn folder_name(title: Option<&str>) -> String {
    let name: String = title
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_start_matches('.').trim_matches('-');
    if name.is_empty() {
        "typstry-project".to_owned()
    } else {
        name.chars().take(100).collect()
    }
}

/// `git init` plus one commit with every project file. The state folder is
/// excluded first, so the key never lands in the commit.
fn init_repo(root: &Path, title: &str) -> anyhow::Result<()> {
    git::run(root, &["init", "--quiet"])?;
    let repo = Repo::discover(root).context("git init did not create a repository")?;
    repo.exclude_state_dir()?;
    git::run(root, &["add", "-A"])?;
    let message = format!("import from typstry: {title}");
    let mut args = vec![];
    // Without a configured identity git refuses to commit at all; the
    // import commit is ours rather than the user's anyway.
    let configured = |key: &str| git::run(root, &["config", key]).is_ok();
    if !configured("user.name") || !configured("user.email") {
        args.extend([
            "-c",
            "user.name=typstry",
            "-c",
            "user.email=typstry@localhost",
        ]);
    }
    args.extend(["commit", "--quiet", "--allow-empty", "-m", &message]);
    git::run(root, &args)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_are_safe() {
        assert_eq!(folder_name(Some("My Thesis")), "My-Thesis");
        assert_eq!(folder_name(Some("../etc/passwd")), "etc-passwd");
        assert_eq!(folder_name(Some("  ")), "typstry-project");
        assert_eq!(folder_name(None), "typstry-project");
        assert_eq!(folder_name(Some(".hidden")), "hidden");
    }
}
