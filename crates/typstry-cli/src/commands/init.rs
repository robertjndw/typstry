use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use typstry_doc::init::{DEFAULT_MAIN_FILE, init_bare_project, set_main_file, starter_content};
use typstry_doc::names::validate_path;
use typstry_doc::paths::build_path_index;
use typstry_wire::crypto::LinkSecret;

use super::{
    Ctx, Output, link::print_links, print_not_applied, print_report_warnings, print_warnings,
    track_branch,
};
use crate::api::{Api, Permission, ShareInfo};
use crate::engine::{Flush, Identity, Mode, Scope, Session, set_peer_info};
use crate::git::{self, Head, Repo};
use crate::link::{ShareLink, ws_url};
use crate::mls::create_group;
use crate::state::{STATE_DIR, StateDir};
use crate::worktree::{GIT_FILE_REASON, LocalFile, Skipped, Worktree, case_clashes};

/// Files and folders that are common in repositories but rarely matter to
/// co-authors of a document.
const REPO_CLUTTER: &[&str] = &[
    "README",
    "LICENSE",
    "LICENCE",
    "CHANGELOG",
    "CONTRIBUTING",
    "CODE_OF_CONDUCT",
    ".gitlab",
    ".gitlab-ci.yml",
    ".editorconfig",
    ".vscode",
    ".idea",
];

/// Turn a folder into a new typstry project and link it.
///
/// Uploads the files git would see (honouring `.gitignore` and
/// `.typstryignore`) as they are on disk, after showing a preview. git's
/// own files (`.gitignore`, `.gitattributes`, `.gitmodules`, `.github/`)
/// and `.typstryignore` stay local unless `.typstryignore` re-includes
/// them with a `!pattern`. Works in a git repository or a subfolder of
/// one, which keeps working with git as before.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// The folder to share; defaults to the current one.
    pub dir: Option<PathBuf>,
    /// Project title; defaults to the folder name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file to compile; defaults to main.typ, or the only .typ file at
    /// the top level.
    #[arg(long, value_name = "FILE")]
    pub main: Option<String>,
    /// The typstry server, e.g. https://typst.example.org.
    #[arg(long, value_name = "URL", env = "TYPSTRY_SERVER")]
    pub server: Option<String>,
    /// Show what would be uploaded and stop.
    #[arg(long)]
    pub dry_run: bool,
    /// Do not ask for confirmation.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

/// What init would upload, worked out before anything leaves the machine.
struct Plan {
    root: PathBuf,
    title: String,
    /// The paths to upload, in sorted order.
    files: Vec<(String, LocalFile)>,
    skipped: Vec<Skipped>,
    main: Option<String>,
    /// Seed the starter `main.typ`, for a folder with nothing in it.
    starter: bool,
    repo: Option<(Repo, Head)>,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let root = match &args.dir {
        Some(dir) => ctx.dir.join(dir),
        None => ctx.dir.clone(),
    };
    // clap hands over a set but empty TYPSTRY_SERVER as a value; it means
    // no server, like leaving it unset.
    let server = args
        .server
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_owned());
    match &server {
        Some(server) => {
            ws_url(server).context("--server must be an http(s) URL")?;
        }
        // A dry run never talks to a server, so it may as well work
        // without one.
        None if args.dry_run => {}
        None => {
            bail!("no server given; pass --server https://your-typstry-host or set TYPSTRY_SERVER")
        }
    }

    let plan = plan(&root, &args)?;
    print_preview(&plan, server.as_deref());
    let Some(server) = server.filter(|_| !args.dry_run) else {
        println!("Dry run: nothing was uploaded.");
        return Ok(());
    };
    if !args.yes && !confirm(&format!("Create the project on {server} and upload it?"))? {
        bail!("cancelled; nothing was uploaded");
    }

    if !plan.root.exists() {
        fs::create_dir_all(&plan.root)
            .with_context(|| format!("creating {}", plan.root.display()))?;
    }
    let root = plan.root.canonicalize()?;
    let starter_path = root.join(DEFAULT_MAIN_FILE);
    match create(ctx, &plan, &root, &server).await {
        Ok(session) => {
            println!(
                "Created {:?} with {} file(s).",
                plan.title,
                if plan.starter { 1 } else { plan.files.len() }
            );
            print_links(&session.config, None)?;
            Ok(())
        }
        Err(err) => {
            // Leaves the folder as it was, so init can simply run again. The
            // project created on the server stays behind, unreachable
            // without the key that is gone now.
            let _ = fs::remove_dir_all(root.join(STATE_DIR));
            if plan.starter {
                let _ = fs::remove_file(&starter_path);
            }
            Err(err)
        }
    }
}

fn plan(root: &Path, args: &Args) -> anyhow::Result<Plan> {
    if root.exists() && !root.is_dir() {
        bail!("{} is not a folder", root.display());
    }
    let root = absolute(root)?;
    // A folder that does not exist yet is an empty project, like with git
    // init; its git repo is the one of the nearest folder that exists.
    let existing = root
        .ancestors()
        .find(|dir| dir.exists())
        .context("no part of the path exists")?;
    if root.join(STATE_DIR).exists() {
        bail!(
            "{} is already linked to a typstry project ({STATE_DIR}/ exists)",
            root.display()
        );
    }
    if let Some(outer) = root.parent().and_then(StateDir::find_root) {
        bail!(
            "{} is inside the typstry project in {}; a nested project would be synced twice",
            root.display(),
            outer.display()
        );
    }

    let title = match &args.title {
        Some(title) => title.trim().to_owned(),
        None => root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("untitled")
            .to_owned(),
    };
    if title.is_empty() {
        bail!("the title must not be empty");
    }

    let worktree = Worktree::new(root.clone());
    let scan = if root.exists() {
        worktree.scan()?
    } else {
        Default::default()
    };
    let mut skipped = scan.skipped;
    skipped.extend(scan.git_files.into_iter().map(|path| Skipped {
        path,
        reason: GIT_FILE_REASON.to_owned(),
    }));
    let mut files = Vec::new();
    for (path, file) in scan.files {
        if let Err(invalid) = validate_path(&path) {
            let reason = format!("not a valid name: {}", invalid.error);
            skipped.push(Skipped { path, reason });
        } else {
            files.push((path, file));
        }
    }
    // The browser could hold both, but every clone on macOS or Windows
    // would end up with only one of them on disk.
    let dropped: BTreeSet<String> = case_clashes(files.iter().map(|(p, _)| p.as_str()), |_| false)
        .into_iter()
        .map(|(kept, dropped)| {
            skipped.push(Skipped {
                reason: format!("differs from {kept} only in case"),
                path: dropped.clone(),
            });
            dropped
        })
        .collect();
    files.retain(|(path, _)| !dropped.contains(path));
    skipped.sort_by(|a, b| a.path.cmp(&b.path));

    // An ignored main.typ is still a file the user has; the starter would
    // overwrite it.
    let starter = files.is_empty() && !worktree.exists(DEFAULT_MAIN_FILE);
    let is_text = |path: &str| {
        files
            .iter()
            .any(|(p, file)| p == path && file.text.is_some())
    };
    let main = match &args.main {
        Some(main) => {
            let main = main.trim_start_matches("./").replace('\\', "/");
            if !is_text(&main) && !(starter && main == DEFAULT_MAIN_FILE) {
                bail!("--main {main}: not a text file that would be uploaded");
            }
            Some(main)
        }
        None if starter || is_text(DEFAULT_MAIN_FILE) => Some(DEFAULT_MAIN_FILE.to_owned()),
        None => {
            let top: Vec<&String> = files
                .iter()
                .filter(|(p, file)| !p.contains('/') && p.ends_with(".typ") && file.text.is_some())
                .map(|(p, _)| p)
                .collect();
            match top.as_slice() {
                [only] => Some((*only).clone()),
                _ => None,
            }
        }
    };

    let repo = Repo::discover(existing).map(|repo| {
        let head = repo.head();
        (repo, head)
    });
    Ok(Plan {
        root,
        title,
        files,
        skipped,
        main,
        starter,
        repo,
    })
}

fn print_preview(plan: &Plan, server: Option<&str>) {
    println!("New project {:?} from {}", plan.title, plan.root.display());
    if let Some(server) = server {
        println!("  server:  {server}");
    }
    match &plan.repo {
        Some((repo, Head::Branch(branch))) => println!(
            "  git:     tracks branch {branch} of {}",
            repo.workdir.display()
        ),
        Some((repo, Head::Detached)) => println!(
            "  git:     {} has a detached HEAD, so no branch is tracked yet",
            repo.workdir.display()
        ),
        None => println!("  git:     not a git repository"),
    }
    if plan.starter {
        println!("  files:   none yet; a starter {DEFAULT_MAIN_FILE} will be created");
    } else {
        let text = plan.files.iter().filter(|(_, f)| f.text.is_some()).count();
        let size: u64 = plan.files.iter().map(|(_, f)| f.size).sum();
        println!(
            "  files:   {} ({text} text, {} asset(s)), {}",
            plan.files.len(),
            plan.files.len() - text,
            human_size(size)
        );
    }
    match &plan.main {
        Some(main) => println!("  main:    {main}"),
        None => {
            println!("  main:    none");
            eprintln!(
                "warning: no main file: there is no {DEFAULT_MAIN_FILE} and not exactly one .typ file at the top; pass --main or pick one in the browser"
            );
        }
    }
    if !plan.skipped.is_empty() {
        println!("Skipped:");
        for skipped in &plan.skipped {
            println!("  {skipped}");
        }
    }
    if let Some(dirty) = plan.repo.as_ref().and_then(|_| dirty_count(&plan.root))
        && dirty > 0
    {
        eprintln!(
            "warning: {dirty} uncommitted change(s) in this folder; files are uploaded as they are on disk"
        );
    }
    let clutter: Vec<String> = clutter(plan.files.iter().map(|(p, _)| p.as_str()));
    if !clutter.is_empty() {
        println!(
            "hint: co-authors may not need {}; list them in .typstryignore to leave them out",
            clutter.join(", ")
        );
    }
}

/// Top-level entries that look like repository housekeeping.
fn clutter<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out = BTreeSet::new();
    for path in paths {
        let (top, is_dir) = match path.split_once('/') {
            Some((top, _)) => (top, true),
            None => (path, false),
        };
        let stem = top.split('.').next().unwrap_or(top);
        let matches = REPO_CLUTTER.iter().any(|c| {
            top.eq_ignore_ascii_case(c) || (!c.starts_with('.') && stem.eq_ignore_ascii_case(c))
        });
        if matches {
            out.insert(if is_dir {
                format!("{top}/")
            } else {
                top.to_owned()
            });
        }
    }
    out.into_iter().collect()
}

/// Uncommitted changes under `dir`, from a read-only `git status`. None
/// when git is not installed or fails.
fn dirty_count(dir: &Path) -> Option<usize> {
    if !dir.exists() {
        return None;
    }
    // --no-optional-locks keeps status from refreshing the index, so this
    // never writes to .git, even while an editor's git plugin is busy.
    git::run(
        dir,
        &["--no-optional-locks", "status", "--porcelain", "--", "."],
    )
    .ok()
    .map(|out| out.lines().count())
}

pub(super) fn confirm(question: &str) -> anyhow::Result<bool> {
    if !std::io::stdin().is_terminal() {
        bail!("not asking for confirmation without a terminal; check the preview and pass --yes");
    }
    print!("{question} [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "Yes"))
}

async fn create(ctx: &Ctx, plan: &Plan, root: &Path, server: &str) -> anyhow::Result<Session> {
    let api = Api::new(server)?;
    let created = api.create_project().await?;
    let link = ShareLink::new(
        server,
        &created.edit_token,
        &LinkSecret::generate_edit().to_base64url(),
    );
    let share = ShareInfo {
        project_id: created.project_id,
        permission: Permission::Write,
        view_token: Some(created.view_token),
        retired: false,
    };
    // The project's group starts with this folder as its only member, before
    // anything else is uploaded, so every record has an author the group
    // vouches for.
    let local = crate::user::load_or_create_identity()?;
    let identity = Identity::resolve(ctx.name.as_deref(), None, local.graph.profile(), root);
    let group = create_group(&link, &identity, &local).await?;
    // Before .typstry/ exists, so the key cannot slip into a commit even if
    // the rest fails halfway.
    if let Some((repo, _)) = &plan.repo {
        repo.exclude_state_dir()?;
    }
    let mut session =
        Session::create_with_api(root, &link, &share, api, Some(group), ctx.name.as_deref())?;
    session.connect().await?;

    // The seed and the files go out together after the assets, so nobody
    // ever sees a project whose assets are still missing.
    set_peer_info(session.doc(), session.identity())?;
    init_bare_project(session.doc(), &plan.title)?;
    // The starter goes up like any other file, so there is only one way a
    // file gets into a new project.
    let paths: BTreeSet<String> = if plan.starter {
        session
            .worktree()
            .write(DEFAULT_MAIN_FILE, starter_content(&plan.title).as_bytes())?;
        BTreeSet::from([DEFAULT_MAIN_FILE.to_owned()])
    } else {
        plan.files.iter().map(|(p, _)| p.clone()).collect()
    };
    // Only the previewed paths, so whatever appeared since is not uploaded
    // unseen and skipped files stay skipped.
    let report = session
        .reconcile(&Scope::Paths(paths), Mode::Push, Flush::Now)
        .await?;
    let mut out = Output::terminal();
    // The preview already listed what goes up, so only what did not.
    print_not_applied(&mut out, &report.applied, "uploading");
    print_report_warnings(&mut out, &report);
    if let Some(main) = &plan.main {
        match build_path_index(session.doc()).by_path.get(main) {
            Some(&id) => set_main_file(session.doc(), Some(id))?,
            None => out.err(format!(
                "warning: {main} was not uploaded, so there is no main file"
            )),
        }
    }
    // Only meta changed since the reconcile, so the folder still matches.
    // Taken before sending, which may import someone else's ops.
    session.set_base_to_doc();
    session.push_local().await?;
    session.disconnect().await;
    session.remember_project();
    print_warnings(&mut out, &mut session);
    session.save()?;
    track_branch(&mut session, &mut out)?;
    Ok(session)
}

/// `path` made absolute with symlinks resolved, also when its last parts
/// do not exist yet.
pub(super) fn absolute(path: &Path) -> anyhow::Result<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if current.exists() {
            let mut out = current
                .canonicalize()
                .with_context(|| format!("cannot open {}", current.display()))?;
            out.extend(missing.iter().rev());
            return Ok(out);
        }
        let name = current
            .file_name()
            .with_context(|| format!("cannot use {} as a folder", path.display()))?;
        missing.push(name.to_owned());
        current = match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
    }
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_repo_clutter() {
        assert_eq!(
            clutter([
                "README.md",
                "readme.txt",
                ".gitlab/ci.yml",
                "LICENSE",
                "main.typ",
                "chapters/README.md",
                ".gitignore",
            ]),
            [".gitlab/", "LICENSE", "README.md", "readme.txt"]
        );
    }

    #[test]
    fn sizes_read_well() {
        assert_eq!(human_size(12), "12 B");
        assert_eq!(human_size(1_234_567), "1.2 MB");
    }
}
