//! Just enough git to stay out of its way: find the repository a folder is
//! in, read which branch is checked out, and notice operations that are
//! rewriting the working tree. Everything here only reads `.git`; the one
//! write is the `.typstry/` line in `info/exclude`.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

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

#[derive(Debug, Clone)]
pub struct Repo {
    /// The directory holding `.git`.
    pub workdir: PathBuf,
    /// Where HEAD and the per-worktree state live. For a linked worktree
    /// that is `.git/worktrees/<name>` of the main repo.
    pub git_dir: PathBuf,
    /// Shared state like `info/exclude`. Same as `git_dir` except in
    /// linked worktrees.
    pub common_dir: PathBuf,
    /// Sync looks at the reflog several times a second, and it only ever
    /// grows, so what was read of it is kept. Shared between clones.
    reflog: ReflogCache,
}

/// What the reflog says: how many entries it has and the last one that
/// moved files, which is all sync ever asks of it.
#[derive(Debug, Clone, Copy, Default)]
struct Reflog {
    /// Entries that end in a newline.
    whole: u64,
    /// Index of the last whole entry that moved files.
    last_move: Option<u64>,
    /// A last line without its newline yet, and whether it moves files;
    /// it still counts, as with `lines`.
    partial: Option<bool>,
}

impl Reflog {
    fn count(&self) -> u64 {
        self.whole + u64::from(self.partial.is_some())
    }

    fn moves_files_after(&self, seen: u64) -> bool {
        self.last_move.is_some_and(|i| i >= seen)
            || (self.partial == Some(true) && self.whole >= seen)
    }
}

/// The reflog as last read, and how to tell whether the file moved on.
#[derive(Debug)]
struct ReadReflog {
    log: Reflog,
    /// Bytes up to the end of the last whole entry.
    parsed: u64,
    /// That entry, which must still be there, right before `parsed`, for
    /// the file to count as only appended to. Inode, mtime and length
    /// alone miss `git reflog expire` followed by enough new entries,
    /// most of all where there is no inode to compare.
    last_entry: Vec<u8>,
    len: u64,
    mtime: Option<SystemTime>,
    #[cfg(unix)]
    ino: u64,
}

#[derive(Debug, Clone, Default)]
struct ReflogCache(Arc<Mutex<Option<ReadReflog>>>);

fn entry_moves_files(line: &str) -> bool {
    moves_files(line.split_once('\t').map_or("", |(_, msg)| msg))
}

fn whole_entries_len(text: &str) -> u64 {
    text.rfind('\n').map_or(0, |end| end as u64 + 1)
}

/// The last whole entry in `text`, newline included; empty if there is
/// none.
fn last_whole_entry(text: &str) -> &[u8] {
    let whole = &text[..whole_entries_len(text) as usize];
    let start = whole
        .strip_suffix('\n')
        .and_then(|rest| rest.rfind('\n'))
        .map_or(0, |end| end + 1);
    &whole.as_bytes()[start..]
}

/// Adds the entries in `text` to `log`; a last line without a newline
/// becomes its partial entry.
fn parse_reflog(text: &str, log: &mut Reflog) {
    let (whole, partial) = match text.rfind('\n') {
        Some(end) => text.split_at(end + 1),
        None => ("", text),
    };
    for moves in reflog_entries(whole).map(entry_moves_files) {
        if moves {
            log.last_move = Some(log.whole);
        }
        log.whole += 1;
    }
    log.partial = (!partial.is_empty()).then(|| entry_moves_files(partial));
}

/// Adds what was appended to the reflog since `read`. False, with `read`
/// untouched, when the file no longer holds what was read before, so it
/// has to be read in full.
fn read_appended(file: &mut fs::File, read: &mut ReadReflog, mtime: Option<SystemTime>) -> bool {
    // From the start of the last whole entry: it is the check, and a
    // partial entry after it is read again in full.
    let start = read.parsed - read.last_entry.len() as u64;
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return false;
    }
    let Some(tail) = bytes.strip_prefix(read.last_entry.as_slice()) else {
        return false;
    };
    let Ok(tail) = std::str::from_utf8(tail) else {
        return false;
    };
    parse_reflog(tail, &mut read.log);
    let whole = whole_entries_len(tail);
    if whole > 0 {
        read.last_entry = last_whole_entry(tail).to_vec();
    }
    read.len = read.parsed + tail.len() as u64;
    read.parsed += whole;
    read.mtime = mtime;
    true
}

impl Repo {
    /// The repository `start` belongs to, walking up the way git does.
    /// With `GIT_DIR` or `GIT_WORK_TREE` set, git looks there instead of
    /// for a `.git`, so git itself is asked.
    pub fn discover(start: &Path) -> Option<Self> {
        let start = start.canonicalize().ok()?;
        if std::env::var_os("GIT_DIR").is_some() || std::env::var_os("GIT_WORK_TREE").is_some() {
            return Self::discover_with_git(&start);
        }
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
                    reflog: ReflogCache::default(),
                });
            }
            current = dir.parent();
        }
        None
    }

    /// [`Self::discover`] by `git rev-parse`, which knows the environment
    /// and `core.worktree`. None without git or outside a work tree.
    fn discover_with_git(start: &Path) -> Option<Self> {
        let mut command = git();
        command
            .args([
                "rev-parse",
                "--absolute-git-dir",
                "--git-common-dir",
                "--show-toplevel",
            ])
            .current_dir(start);
        // Relative to where typstry was started, not to `start` (`-C`).
        let cwd = std::env::current_dir().ok()?;
        for var in ["GIT_DIR", "GIT_WORK_TREE"] {
            if let Some(value) = std::env::var_os(var) {
                command.env(var, cwd.join(value));
            }
        }
        let out = command.output().ok().filter(|out| out.status.success())?;
        let text = String::from_utf8(out.stdout).ok()?;
        let mut lines = text.lines();
        let git_dir = PathBuf::from(lines.next()?).canonicalize().ok()?;
        // Relative to the folder git ran in.
        let common_dir = start.join(lines.next()?).canonicalize().ok()?;
        let workdir = PathBuf::from(lines.next()?).canonicalize().ok()?;
        start.starts_with(&workdir).then(|| Self {
            workdir,
            git_dir,
            common_dir,
            reflog: ReflogCache::default(),
        })
    }

    /// Whether `refs/heads/<branch>` points at a commit, loose or packed.
    pub fn branch_exists(&self, branch: &str) -> bool {
        self.commit_of(&format!("ref: refs/heads/{branch}"))
            .is_some()
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

    /// HEAD's reflog as it is on disk. None without a reflog. Git only
    /// appends to it, so a file that grew is read from where the last read
    /// stopped. Anything else (`git reflog expire`, a new file) is read
    /// from the start.
    fn reflog(&self) -> Option<Reflog> {
        let path = self.git_dir.join("logs").join("HEAD");
        let mut cache = self.reflog.0.lock().expect("never poisoned");
        let Ok(mut file) = fs::File::open(&path) else {
            *cache = None;
            return None;
        };
        let meta = file.metadata().ok()?;
        #[cfg(unix)]
        let ino = std::os::unix::fs::MetadataExt::ino(&meta);
        let (len, mtime) = (meta.len(), meta.modified().ok());
        let same_file = |read: &ReadReflog| {
            #[cfg(unix)]
            if read.ino != ino {
                return false;
            }
            read.mtime.is_some() && len >= read.len
        };
        let current = match cache.as_mut() {
            Some(read) if same_file(read) && read.len == len && read.mtime == mtime => true,
            Some(read) if same_file(read) => read_appended(&mut file, read, mtime),
            _ => false,
        };
        if !current {
            let mut text = String::new();
            file.seek(SeekFrom::Start(0)).ok()?;
            file.read_to_string(&mut text).ok()?;
            let mut log = Reflog::default();
            parse_reflog(&text, &mut log);
            *cache = Some(ReadReflog {
                log,
                parsed: whole_entries_len(&text),
                last_entry: last_whole_entry(&text).to_vec(),
                len: text.len() as u64,
                mtime,
                #[cfg(unix)]
                ino,
            });
        }
        cache.as_ref().map(|read| read.log)
    }

    pub fn mark(&self) -> GitMark {
        self.mark_with(self.reflog().as_ref())
    }

    /// [`Self::mark`] with the reflog already read, so callers that also
    /// look at its entries read it only once.
    fn mark_with(&self, reflog: Option<&Reflog>) -> GitMark {
        let head = self.read_head();
        GitMark {
            branch: match parse_head(head.as_deref()) {
                Head::Branch(name) => Some(name),
                Head::Detached => None,
            },
            commit: head.as_deref().and_then(|head| self.commit_of(head)),
            reflog: reflog.map(Reflog::count),
        }
    }

    /// Whether HEAD was moved to another branch or reset since `then`,
    /// which may have rewritten files without anyone editing them.
    /// Commits and merges on the same branch do not count. Without a
    /// reflog to tell, any move of HEAD counts.
    pub fn switched_since(&self, then: &GitMark) -> bool {
        let log = self.reflog();
        let now = self.mark_with(log.as_ref());
        if now == *then {
            return false;
        }
        match (then.reflog, now.reflog, log) {
            (Some(seen), Some(count), Some(log)) if count >= seen => {
                now.branch != then.branch || log.moves_files_after(seen)
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
        // A crash halfway must not cost the user their own exclude rules.
        crate::state::atomic_write(&path, next.as_bytes(), false)
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

/// Where `core.hooksPath` points so that no hook is found.
const NO_HOOKS: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// A `git` command that runs no program the repository's config names.
///
/// The folders the CLI runs git in are filled from a shared project, and a
/// config that slipped in (`core.fsmonitor`) or a hook would be code any
/// collaborator gets to run here. Name checks keep `.git` out of the
/// project; this keeps git from executing anything should one ever miss.
fn git() -> Command {
    let mut command = Command::new("git");
    command.args([
        "-c",
        "core.fsmonitor=false",
        "-c",
        &format!("core.hooksPath={NO_HOOKS}"),
    ]);
    command
}

/// Whether a `git` executable can be run at all.
pub fn available() -> bool {
    git()
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
}

/// `git config user.name` as seen from `dir`, if git is installed and the
/// name is set.
pub fn user_name(dir: &Path) -> Option<String> {
    let out = git()
        .args(["config", "user.name"])
        .current_dir(dir)
        .output()
        .ok()?;
    let name = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (out.status.success() && !name.is_empty()).then_some(name)
}

/// Runs a git command in `dir` and fails with its stderr when it does.
pub fn run(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    let out = git()
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
    fn reads_only_what_was_appended_to_the_reflog() {
        use std::io::Write as _;

        let dir = tempfile::tempdir().unwrap();
        fake_repo(dir.path(), "ref: refs/heads/main\n");
        fs::create_dir_all(dir.path().join(".git/logs")).unwrap();
        let path = dir.path().join(".git/logs/HEAD");
        fs::write(&path, "a\tcommit: one\nb\tcheckout: moving").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let log = repo.reflog().unwrap();
        assert_eq!(log.count(), 2);
        assert!(log.moves_files_after(1));
        assert!(!log.moves_files_after(2));

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b" from a to b\nc\tcommit: two\n").unwrap();
        drop(file);
        let log = repo.clone().reflog().unwrap();
        assert_eq!(log.count(), 3);
        assert_eq!(log.last_move, Some(1));
        assert!(!log.moves_files_after(2));

        // Expiring rewrites the file shorter; it is read again in full.
        fs::write(&path, "c\tcommit: two\n").unwrap();
        let log = repo.reflog().unwrap();
        assert_eq!((log.count(), log.last_move), (1, None));
    }

    #[test]
    fn rereads_a_reflog_rewritten_to_the_same_length() {
        use std::io::Write as _;

        let dir = tempfile::tempdir().unwrap();
        fake_repo(dir.path(), "ref: refs/heads/main\n");
        fs::create_dir_all(dir.path().join(".git/logs")).unwrap();
        let path = dir.path().join(".git/logs/HEAD");
        fs::write(&path, "a\tcommit: one\nb\tcommit: two\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let log = repo.reflog().unwrap();
        assert_eq!((log.count(), log.last_move), (2, None));

        // Expired down to one entry, then appended back to the old length.
        // Truncating in place keeps the inode, which is what HEAD.lock
        // reuse can amount to.
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(0).unwrap();
        file.write_all(b"b\tcommit: two\nc\tcheckout: m\n").unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH).unwrap();
        drop(file);
        assert_eq!(fs::metadata(&path).unwrap().len(), 28);
        let log = repo.reflog().unwrap();
        assert_eq!((log.count(), log.last_move), (2, Some(1)));
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

    #[cfg(unix)]
    #[test]
    fn runs_no_fsmonitor_or_hook_from_the_repo() {
        use std::os::unix::fs::PermissionsExt;

        if !available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "--quiet"]).unwrap();
        let marker = root.join("ran");
        let script = root.join("planted.sh");
        fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let hooks = root.join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::copy(&script, hooks.join("pre-commit")).unwrap();
        let config = root.join(".git/config");
        let mut text = fs::read_to_string(&config).unwrap();
        text.push_str(&format!("[core]\n\tfsmonitor = {}\n", script.display()));
        fs::write(&config, text).unwrap();
        fs::write(root.join("a.typ"), "x").unwrap();

        run(root, &["add", "-A"]).unwrap();
        run(
            root,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@localhost",
                "commit",
                "--quiet",
                "-m",
                "x",
            ],
        )
        .unwrap();
        run(root, &["status", "--porcelain"]).unwrap();
        assert!(!marker.exists());
    }
}
