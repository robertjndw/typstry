use anyhow::{Context, bail};
use loro::LoroDoc;
use typstry_doc::peers::peer_name;
use typstry_doc::versions::MAX_VERSION_NAME_CHARS;
use typstry_doc::versions::{NamedVersion, named_versions, normalize_version_name, save_version};

use super::{
    Ctx, Fetch, Output, connected, guard_branch, guard_switch, print_report, print_warnings,
};
use crate::engine::{Flush, Mode, Report, Scope, Session, set_peer_info};
use crate::mailbox::Request;
use crate::state::now_ms;

/// List or save named versions of the project.
///
/// While `typstry sync` runs in the folder, the running sync lists and
/// saves them.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub command: VersionCommand,
}

#[derive(Debug, clap::Subcommand)]
pub enum VersionCommand {
    /// Named versions, newest first.
    List {
        #[command(flatten)]
        fetch: Fetch,
    },
    /// Push local changes, then name the project's current state.
    Save {
        // Not called `name`, which would collide with the global --name.
        #[arg(value_name = "NAME")]
        version_name: String,
        /// Sync even when git is not on the tracked branch, or after a
        /// branch switch left files that differ from the last sync (see
        /// `typstry push --help`).
        #[arg(long)]
        force: bool,
    },
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    match args.command {
        VersionCommand::List { fetch } => list(ctx, &fetch).await,
        VersionCommand::Save {
            version_name,
            force,
        } => save(ctx, &version_name, force).await,
    }
}

async fn list(ctx: &Ctx, fetch: &Fetch) -> anyhow::Result<()> {
    let Some((session, mut out)) = ctx.open_current(Request::VersionList, fetch).await? else {
        return Ok(());
    };
    print_versions(session.doc(), &mut out);
    Ok(())
}

/// Named versions, newest first.
pub fn print_versions(doc: &LoroDoc, out: &mut Output) {
    let mut versions = named_versions(doc);
    if versions.is_empty() {
        out.out("No named versions yet; save one with typstry version save <name>.");
        return;
    }
    versions.sort_by_key(|v| std::cmp::Reverse((v.created_at, v.index)));
    for version in &versions {
        out.out(format!(
            "#{:<3} {}  {}  ({})",
            version.index,
            format_ms(version.created_at),
            version.name,
            author_name(doc, &version.author)
        ));
    }
}

/// The name as it is stored, or why it cannot be.
pub fn valid_version_name(raw: &str) -> anyhow::Result<String> {
    match normalize_version_name(raw) {
        Some(name) => Ok(name.to_owned()),
        None => bail!("a version name must be 1 to {MAX_VERSION_NAME_CHARS} characters"),
    }
}

async fn save(ctx: &Ctx, raw_name: &str, force: bool) -> anyhow::Result<()> {
    let name = valid_version_name(raw_name)?;
    let request = Request::VersionSave {
        name: name.clone(),
        force,
    };
    let Some(mut session) = ctx.open_or_ask(request).await? else {
        return Ok(());
    };
    if !session.can_write() {
        bail!("{VIEW_ONLY_SAVE}");
    }
    let mut out = Output::terminal();
    guard_branch(&mut session, force, &mut out)?;
    guard_switch(&mut session, force).await?;
    let saved = connected(&mut session, async |session| {
        // The version is meant to be what is on disk now, so local edits
        // go out first.
        let report = session
            .reconcile(&Scope::Full, Mode::Push, Flush::Now)
            .await?;
        print_pre_save_push(&mut out, &report);
        let saved = name_current_state(session, &name)?;
        session.push_local().await?;
        Ok(saved)
    })
    .await?;
    print_warnings(&mut out, &mut session);
    // The base stays where the reconcile put it: remote edits may have
    // arrived while waiting for the ack, and those are not on disk.
    session.save()?;
    print_saved(&mut out, &saved);
    Ok(())
}

pub const VIEW_ONLY_SAVE: &str =
    "this folder is linked with a view-only link; saving a version needs the edit link";

/// What the push before saving a version did.
pub fn print_pre_save_push(out: &mut Output, report: &Report) {
    let pushed = report.applied.len();
    if pushed > 0 {
        out.out(format!("Pushed {pushed} local change(s)."));
    }
    print_report(out, report);
}

/// Adds the version to the doc; sending it is up to the caller.
pub fn name_current_state(session: &mut Session, name: &str) -> anyhow::Result<NamedVersion> {
    // The doc's peer is fresh for this run, so the history panel needs its
    // name before the version entry can show an author.
    set_peer_info(session.doc(), session.identity())?;
    save_version(session.doc(), name, now_ms() as i64).context("saving the version")
}

pub fn print_saved(out: &mut Output, saved: &NamedVersion) {
    out.out(format!("Saved version #{} {:?}.", saved.index, saved.name));
}

/// Resolves `--at`: `#N` is an index, otherwise an exact name, falling
/// back to an index for plain numbers.
pub fn find_version(doc: &LoroDoc, at: &str) -> anyhow::Result<NamedVersion> {
    let versions = named_versions(doc);
    let by_index = |index: usize| {
        versions
            .iter()
            .find(|v| v.index == index)
            .cloned()
            .with_context(|| format!("there is no version #{index}; see typstry version list"))
    };
    if let Some(index) = at.strip_prefix('#').and_then(|n| n.parse().ok()) {
        return by_index(index);
    }
    let name = at.trim();
    let named: Vec<&NamedVersion> = versions.iter().filter(|v| v.name == name).collect();
    match named.as_slice() {
        [one] => Ok((*one).clone()),
        [] => match name.parse() {
            Ok(index) => by_index(index),
            Err(_) => bail!("there is no version named {name:?}; see typstry version list"),
        },
        many => bail!(
            "{} versions are named {name:?}: {}; pick one with --at '#N'",
            many.len(),
            many.iter()
                .map(|v| format!("#{} ({})", v.index, format_ms(v.created_at)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// The name the author's browser (or CLI run) registered in `peers`, or
/// the bare peer id when there is none.
pub fn author_name(doc: &LoroDoc, peer: &str) -> String {
    peer_name(doc, peer).unwrap_or_else(|| format!("peer {peer}"))
}

/// `YYYY-MM-DD HH:MM UTC`. UTC because the CLI has no time zone database,
/// and an unlabeled local-looking time that is not local would mislead.
pub fn format_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02} UTC",
        rem / 3600,
        rem % 3600 / 60
    )
}

/// Howard Hinnant's days-to-civil algorithm for the proleptic Gregorian
/// calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_dates_in_utc() {
        assert_eq!(format_ms(0), "1970-01-01 00:00 UTC");
        assert_eq!(format_ms(1_700_000_000_123), "2023-11-14 22:13 UTC");
        assert_eq!(format_ms(951_782_400_000), "2000-02-29 00:00 UTC");
    }
}
