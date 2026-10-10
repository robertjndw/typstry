use std::fs;
use std::path::PathBuf;

use anyhow::{Context, bail};
use typstry_doc::materialize::{materialize, materialize_at};

use super::clone::check_empty;
use super::init::absolute;
use super::version::{find_version, format_ms};
use super::{Ctx, Fetch, Output};
use crate::worktree::{Worktree, case_clashes};

/// Write the project's files, now or at a named version, to a new folder.
///
/// The folder is a plain copy, not linked to the project; handy for
/// `git diff --no-index old/ .` against an earlier version.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// A named version: its name, or `#N` with the number from
    /// `typstry version list`. Defaults to the current state.
    #[arg(long, value_name = "VERSION")]
    pub at: Option<String>,
    #[command(flatten)]
    pub fetch: Fetch,
    /// Where to write the files; must be new or empty.
    pub dir: PathBuf,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let target = ctx.dir.join(&args.dir);
    check_empty(&target)?;
    let mut session = ctx.open()?;
    let abs_target = absolute(&target)?;
    if let Some(rel) = session.worktree().relative(&abs_target)
        && !session.worktree().is_ignored(&rel, true)
    {
        bail!(
            "{} is inside the project folder, so the next push would upload the export; pick a folder outside it or ignore it in .typstryignore",
            target.display()
        );
    }

    args.fetch
        .refresh(&mut session, &mut Output::terminal())
        .await?;
    let (files, label) = match &args.at {
        Some(at) => {
            let version = find_version(session.doc(), at)?;
            let files = materialize_at(session.doc(), &version.frontiers)
                .context("the cached project lacks the history of this version")?;
            let label = format!(
                "version #{} {:?} ({})",
                version.index,
                version.name,
                format_ms(version.created_at)
            );
            (files, label)
        }
        None => (materialize(session.doc()), "the current state".to_owned()),
    };

    let created = !target.exists();
    fs::create_dir_all(&target).with_context(|| format!("creating {}", target.display()))?;
    let out = Worktree::new(abs_target.clone());
    let clashes = if out.case_insensitive() {
        case_clashes(files.iter().map(|f| f.path.as_str()), |_| false)
    } else {
        Vec::new()
    };
    let dropped: Vec<String> = clashes
        .into_iter()
        .map(|(kept, dropped)| {
            eprintln!("warning: {dropped} differs from {kept} only in case; not writing it");
            dropped
        })
        .collect();
    let files: Vec<_> = files
        .iter()
        .filter(|f| !dropped.contains(&f.path))
        .collect();
    let mut written = 0;
    let result: anyhow::Result<()> = async {
        if !args.fetch.offline {
            let assets: Vec<&str> = files
                .iter()
                .filter_map(|f| f.content.asset_hash())
                .collect();
            session.prefetch_assets(&assets).await?;
        }
        for file in files {
            let bytes = if args.fetch.offline {
                session.cached_content_bytes(&file.content)?
            } else {
                session.content_bytes(&file.content).await?
            };
            out.write(&file.path, &bytes)?;
            written += 1;
        }
        Ok(())
    }
    .await;
    if let Err(err) = result {
        // A half-written export is worse than none: it looks complete.
        if created {
            let _ = fs::remove_dir_all(&target);
        }
        return Err(err);
    }
    println!(
        "Exported {written} file(s) of {label} to {}",
        target.display()
    );
    Ok(())
}
