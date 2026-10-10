//! Just enough git to stay out of its way: find the repository a folder is
//! in, read which branch is checked out, and notice operations that are
//! rewriting the working tree. Everything here only reads `.git`; the one
//! write is the `.typstry/` line in `info/exclude`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Head {
    Branch(String),
    /// A commit is checked out directly, or HEAD is something we cannot
    /// read; either way there is no branch to sync on.
    Detached,
}

impl Head {
    /// Whether HEAD is on `branch`. No branch never matches, not even a
    /// detached HEAD.
    pub fn is_on(&self, branch: Option<&str>) -> bool {
        matches!((self, branch), (Self::Branch(b), Some(t)) if b == t)
    }
}

impl std::fmt::Display for Head {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Branch(name) => write!(f, "branch {name}"),
            Self::Detached => f.write_str("a detached HEAD"),
        }
    }
}

/// Where HEAD was at some moment, to tell later whether a branch was
/// checked out in between.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMark {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// Entries in HEAD's reflog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reflog: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    /// The directory holding `.git`.
    pub workdir: PathBuf,
    /// Where HEAD and the per-worktree state live. For a linked worktree
    /// that is `.git/worktrees/<name>` of the main repo.
    pub git_dir: PathBuf,
    /// Shared state like `info/exclude`. Same as `git_dir` except in
    /// linked worktrees.
    pub common_dir: PathBuf,
}

impl Repo {
    /// The repository `start` belongs to, walking up the way git does.
    pub fn discover(start: &Path) -> Option<Self> {
        let start = start.canonicalize().ok()?;
        let mut current = Some(start.as_path());
        while let Some(dir) = current {
            let dot_git = dir.join(".git");
            if let Some(git_dir) = resolve_git_dir(&dot_git) {
                let common_dir = fs::read_to_string(git_dir.join("commondir"))
                    .ok()
                    .map(|rel| git_dir.join(rel.trim()))
                    .and_then(|p| p.canonicalize().ok())
                    .unwrap_or_else(|| git_dir.clone());
                return Some(Self {
                    workdir: dir.to_path_buf(),
                    git_dir,
                    common_dir,
                });
            }
            current = dir.parent();
        }
        None
    }

    pub fn head(&self) -> Head {
        parse_head(self.read_head().as_deref())
    }

    /// The commit HEAD points at, from the loose ref or `packed-refs`.
    pub fn head_commit(&self) -> Option<String> {
        self.commit_of(self.read_head().as_deref()?)
    }

    fn read_head(&self) -> Option<String> {
        fs::read_to_string(self.git_dir.join("HEAD")).ok()
    }

    fn commit_of(&self, head: &str) -> Option<String> {
        let head = head.trim();
        let Some(name) = head.strip_prefix("ref: ") else {
            return is_object_id(head).then(|| head.to_owned());
        };
        // Branch refs are shared between worktrees, so they live in the
        // common dir.
        if let Ok(id) = fs::read_to_string(self.common_dir.join(name)) {
            let id = id.trim();
            return is_object_id(id).then(|| id.to_owned());
        }
        let packed = fs::read_to_string(self.common_dir.join("packed-refs")).ok()?;
        packed.lines().find_map(|line| {
            let (id, refname) = line.split_once(' ')?;
            (refname == name && is_object_id(id)).then(|| id.to_owned())
        })
    }

    /// HEAD's reflog as it is on disk. None without a reflog.
    fn reflog(&self) -> Option<String> {
        fs::read_to_string(self.git_dir.join("logs").join("HEAD")).ok()
    }

    pub fn mark(&self) -> GitMark {
        self.mark_with(self.reflog().as_deref())
    }

    /// [`Self::mark`] with the reflog already read, so callers that also
    /// look at its entries read it only once.
    fn mark_with(&self, reflog: Option<&str>) -> GitMark {
        let head = self.read_head();
        GitMark {
            branch: match parse_head(head.as_deref()) {
                Head::Branch(name) => Some(name),
                Head::Detached => None,
            },
            commit: head.as_deref().and_then(|head| self.commit_of(head)),
            reflog: reflog.map(|log| reflog_entries(log).count() as u64),
        }
    }

    /// Whether HEAD was moved to another branch or reset since `then`,
    /// which may have rewritten files without anyone editing them.
    /// Commits and merges on the same branch do not count. Without a
    /// reflog to tell, any move of HEAD counts.
    pub fn switched_since(&self, then: &GitMark) -> bool {
        let log = self.reflog();
        let now = self.mark_with(log.as_deref());
        if now == *then {
            return false;
        }
        match (then.reflog, now.reflog, log) {
            (Some(seen), Some(count), Some(log)) if count >= seen => {
                now.branch != then.branch
                    || reflog_entries(&log)
                        .skip(seen as usize)
                        .any(|line| moves_files(line.split_once('\t').map_or("", |(_, msg)| msg)))
            }
            _ => true,
        }
    }

    /// A merge, rebase or index update that is rewriting files right now,
    /// if any. Syncing in the middle of one would publish half its work.
    pub fn operation_in_progress(&self) -> Option<&'static str> {
        [
            ("index.lock", "another git command"),
            ("MERGE_HEAD", "a merge"),
            ("rebase-merge", "a rebase"),
            ("rebase-apply", "a rebase"),
            ("CHERRY_PICK_HEAD", "a cherry-pick"),
            ("REVERT_HEAD", "a revert"),
        ]
        .into_iter()
        .find(|(name, _)| self.git_dir.join(name).exists())
        .map(|(_, what)| what)
    }

    /// Adds `.typstry/` to `info/exclude`, so the project key never ends up
    /// in a commit. The pattern has no leading slash and so also matches in
    /// subfolders, where a project inside a bigger repo keeps its state.
    pub fn exclude_state_dir(&self) -> anyhow::Result<()> {
        let pattern = format!("{}/", crate::state::STATE_DIR);
        let info = self.common_dir.join("info");
        let path = info.join("exclude");
        let current = fs::read_to_string(&path).unwrap_or_default();
        if current.lines().any(|line| line.trim() == pattern) {
            return Ok(());
        }
        fs::create_dir_all(&info).with_context(|| format!("creating {}", info.display()))?;
        let mut next = current;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(&pattern);
        next.push('\n');
        fs::write(&path, next).with_context(|| format!("writing {}", path.display()))
    }
}

fn parse_head(head: Option<&str>) -> Head {
    match head
        .map(str::trim)
        .and_then(|h| h.strip_prefix("ref: refs/heads/"))
    {
        Some(branch) if !branch.is_empty() => Head::Branch(branch.to_owned()),
        _ => Head::Detached,
    }
}

/// The lines of a reflog, one per entry. Git always ends an entry with a
/// newline, but a final line without one still counts, as with `lines`.
fn reflog_entries(log: &str) -> impl Iterator<Item = &str> {
    log.split_terminator('\n')
}

/// Reflog entries of commands that replace the checked-out files rather
/// than adding to them: `checkout: moving from a to b`, `reset: moving to
/// HEAD~1`, `rebase (start): ...`, `pull --rebase (finish): ...`.
fn moves_files(message: &str) -> bool {
    let action = message.split(':').next().unwrap_or("");
    action == "checkout" || action == "reset" || action.contains("rebase")
}

fn is_object_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `.git` is a directory in a normal checkout and a `gitdir: <path>` file
/// in linked worktrees and submodules.
fn resolve_git_dir(dot_git: &Path) -> Option<PathBuf> {
    let meta = fs::symlink_metadata(dot_git).ok()?;
    if meta.is_dir() {
        return dot_git
            .join("HEAD")
            .is_file()
            .then(|| dot_git.canonicalize().ok())
            .flatten();
    }
    let content = fs::read_to_string(dot_git).ok()?;
    let target = content.trim().strip_prefix("gitdir:")?.trim();
    let target = dot_git.parent()?.join(target);
    target
        .join("HEAD")
        .is_file()
        .then(|| target.canonicalize().ok())?
}

/// Whether a `git` executable can be run at all.
pub fn available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
}

/// `git config user.name` as seen from `dir`, if git is installed and the
/// name is set.
pub fn user_name(dir: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["config", "user.name"])
        .current_dir(dir)
        .output()
        .ok()?;
    let name = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (out.status.success() && !name.is_empty()).then_some(name)
}

/// Runs a git command in `dir` and fails with its stderr when it does.
pub fn run(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .with_context(|| format!("cannot run git {}", args.join(" ")))?;
    if !out.status.success() {
        anyhow::bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_repo(dir: &Path, head: &str) {
        fs::create_dir_all(dir.join(".git/info")).unwrap();
        fs::write(dir.join(".git/HEAD"), head).unwrap();
    }

    #[test]
    fn reads_branch_and_detached_heads() {
        let dir = tempfile::tempdir().unwrap();
        fake_repo(dir.path(), "ref: refs/heads/main\n");
        let sub = dir.path().join("paper/chapters");
        fs::create_dir_all(&sub).unwrap();
        let repo = Repo::discover(&sub).unwrap();
        assert_eq!(repo.workdir, dir.path().canonicalize().unwrap());
        assert_eq!(repo.head(), Head::Branch("main".into()));

        fs::write(dir.path().join(".git/HEAD"), "0123abcd\n").unwrap();
        assert_eq!(repo.head(), Head::Detached);
        assert_eq!(repo.operation_in_progress(), None);
        fs::write(dir.path().join(".git/index.lock"), "").unwrap();
        assert!(repo.operation_in_progress().is_some());
    }

    #[test]
    fn tells_branch_switches_from_commits() {
        let dir = tempfile::tempdir().unwrap();
        fake_repo(dir.path(), "ref: refs/heads/main\n");
        let git = dir.path().join(".git");
        let one = "1".repeat(40);
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("refs/heads/main"), format!("{one}\n")).unwrap();
        fs::create_dir_all(git.join("logs")).unwrap();
        let entry = |msg: &str| format!("{one} {one} T <t@x> 1 +0000\t{msg}\n");
        fs::write(git.join("logs/HEAD"), entry("commit (initial): a")).unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let mark = repo.mark();
        assert_eq!(mark.commit.as_deref(), Some(one.as_str()));
        assert_eq!(mark.reflog, Some(1));
        assert!(!repo.switched_since(&mark));

        let mut log = entry("commit (initial): a");
        log.push_str(&entry("commit: more"));
        log.push_str(&entry("merge draft: Fast-forward"));
        fs::write(git.join("logs/HEAD"), &log).unwrap();
        let two = "2".repeat(40);
        fs::write(git.join("refs/heads/main"), format!("{two}\n")).unwrap();
        assert!(!repo.switched_since(&mark));

        log.push_str(&entry("checkout: moving from main to draft"));
        log.push_str(&entry("checkout: moving from draft to main"));
        fs::write(git.join("logs/HEAD"), &log).unwrap();
        assert!(repo.switched_since(&mark));

        // Packed refs and a missing reflog.
        fs::remove_file(git.join("refs/heads/main")).unwrap();
        fs::write(
            git.join("packed-refs"),
            format!("# pack\n{two} refs/heads/main\n"),
        )
        .unwrap();
        fs::remove_file(git.join("logs/HEAD")).unwrap();
        assert_eq!(repo.head_commit().as_deref(), Some(two.as_str()));
        assert!(repo.switched_since(&mark));
    }

    #[test]
    fn counts_reflog_entries_like_lines() {
        assert_eq!(reflog_entries("").count(), 0);
        assert_eq!(reflog_entries("a\tx\nb\ty\n").count(), 2);
        // Cut off mid-write, the last entry still counts.
        assert_eq!(reflog_entries("a\tx\nb\ty").count(), 2);
    }

    #[test]
    fn follows_gitdir_files_of_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        fake_repo(&main, "ref: refs/heads/main\n");
        let wt_git = main.join(".git/worktrees/feature");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let wt = dir.path().join("feature");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();

        let repo = Repo::discover(&wt).unwrap();
        assert_eq!(repo.head(), Head::Branch("feature".into()));
        assert_eq!(repo.common_dir, main.join(".git").canonicalize().unwrap());
        repo.exclude_state_dir().unwrap();
        repo.exclude_state_dir().unwrap();
        let exclude = fs::read_to_string(main.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude, ".typstry/\n");
    }
}
