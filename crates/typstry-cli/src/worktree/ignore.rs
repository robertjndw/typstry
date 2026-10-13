//! Which paths are synced: git's ignore rules, `.typstryignore` on top,
//! and the git files that stay local unless opted in.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use ignore::gitignore::{Gitignore, GitignoreBuilder, gitconfig_excludes_path};
use typstry_doc::names::is_reserved_segment;

use super::Worktree;
use super::stamp::{Stamp, Stamped};

pub const IGNORE_FILE: &str = ".typstryignore";

/// Files that configure git or the local checkout rather than belong to
/// the document. Co-authors in the browser have no use for them, so they
/// are not synced unless `.typstryignore` asks for them, e.g. with
/// `!.gitignore`.
pub const GIT_FILES: &[&str] = &[
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".github",
    IGNORE_FILE,
];

/// Why a file in [`GIT_FILES`] is not synced, for previews.
pub const GIT_FILE_REASON: &str =
    "git file, not synced by default (opt in with a !pattern in .typstryignore)";

/// What the ignore rules need about the folder's place on disk. Found once
/// per worktree, so a repo created around a running sync only counts after
/// a restart.
#[derive(Debug)]
pub(super) struct IgnoreBase {
    /// The canonical root, since the repo's paths are canonical too.
    root: PathBuf,
    /// The folders from the repo's top down to the root's parent, whose
    /// ignore files also apply. Empty outside a repo.
    outer: Vec<PathBuf>,
    /// The repo's `info/exclude` and the folder its patterns are relative
    /// to.
    exclude: Option<(PathBuf, PathBuf)>,
    /// git's global excludes (`core.excludesFile`, or `git/ignore` in the
    /// config folder) and the folder its patterns are relative to. The
    /// walker applies it outside repos too, so this does as well.
    global: Option<(PathBuf, PathBuf)>,
}

impl Worktree {
    /// Whether the ignore rules exclude `path`, for callers that look at
    /// single paths instead of scanning. Approximates the walker in
    /// [`Self::scan`]: the `.gitignore` and `.typstryignore` files from the
    /// repo root down to the file's folder, the repo's `info/exclude` and
    /// the global git excludes.
    pub fn is_ignored(&self, path: &str, is_dir: bool) -> bool {
        let segments: Vec<&str> = path.split('/').collect();
        if segments.iter().any(|s| is_always_skipped(s)) {
            return true;
        }
        for (i, segment) in segments.iter().enumerate() {
            if is_git_file(segment) {
                let last = i == segments.len() - 1;
                if !self.opted_in(&segments[..=i].join("/"), is_dir || !last) {
                    return true;
                }
            }
        }
        let base = self.ignore_base();
        let (chain, abs) = folders_to(&base.root, &segments);
        let mut matchers = Vec::new();
        // Lowest priority first, as in the walker.
        if let Some((file, dir)) = &base.global {
            matchers.extend(self.matcher(file, dir));
        }
        if let Some((file, workdir)) = &base.exclude {
            matchers.extend(self.matcher(file, workdir));
        }
        // Outermost first, so the loop below can let deeper rules win.
        for dir in base.outer.iter().chain(&chain) {
            // `.typstryignore` last so it wins over `.gitignore`.
            for name in [".gitignore", IGNORE_FILE] {
                matchers.extend(self.matcher(&dir.join(name), dir));
            }
        }
        for matcher in matchers.iter().rev() {
            let m = matcher.matched_path_or_any_parents(&abs, is_dir);
            if m.is_ignore() {
                return true;
            }
            if m.is_whitelist() {
                return false;
            }
        }
        false
    }

    /// Whether `.typstryignore` re-includes one of the [`GIT_FILES`] with a
    /// negated pattern. Only `.typstryignore` counts: a `.gitignore` that
    /// negates itself is about git, not about co-authors.
    pub(super) fn opted_in(&self, path: &str, is_dir: bool) -> bool {
        let segments: Vec<&str> = path.split('/').collect();
        let base = self.ignore_base();
        let (dirs, abs) = folders_to(&base.root, &segments);
        // Deepest first, so a nested file overrides the top-level one.
        for dir in dirs.iter().rev() {
            let Some(matcher) = self.matcher(&dir.join(IGNORE_FILE), dir) else {
                continue;
            };
            let m = matcher.matched(&abs, is_dir);
            if m.is_whitelist() {
                return true;
            }
            if m.is_ignore() {
                return false;
            }
        }
        false
    }

    pub(super) fn ignore_base(&self) -> Arc<IgnoreBase> {
        let mut cached = self.caches.ignore_base.lock().expect("never poisoned");
        if let Some(base) = &*cached {
            return Arc::clone(base);
        }
        // A root that does not exist yet cannot be canonicalized; that
        // answer is not kept, so it is asked again once the folder is there.
        let Ok(root) = self.root.canonicalize() else {
            return Arc::new(IgnoreBase {
                root: self.root.clone(),
                outer: Vec::new(),
                exclude: None,
                global: None,
            });
        };
        let mut outer = Vec::new();
        let mut exclude = None;
        let mut global_dir = root.clone();
        if let Some(repo) = crate::git::Repo::discover(&root) {
            global_dir.clone_from(&repo.workdir);
            outer.extend(
                root.ancestors()
                    .skip(1)
                    .take_while(|dir| dir.starts_with(&repo.workdir))
                    .map(Path::to_path_buf),
            );
            outer.reverse();
            exclude = Some((repo.common_dir.join("info").join("exclude"), repo.workdir));
        }
        let global = gitconfig_excludes_path().map(|file| (file, global_dir));
        let base = Arc::new(IgnoreBase {
            root,
            outer,
            exclude,
            global,
        });
        *cached = Some(Arc::clone(&base));
        base
    }

    /// The compiled rules of the ignore file at `file`, with patterns
    /// relative to `dir`. None when there is no such file. Recompiled
    /// whenever the file's stamp changes, so edits apply right away.
    pub(super) fn matcher(&self, file: &Path, dir: &Path) -> Option<Arc<Gitignore>> {
        let seen = SystemTime::now();
        let meta = fs::metadata(file).ok().filter(fs::Metadata::is_file);
        let Some(meta) = meta else {
            self.caches
                .matchers
                .lock()
                .expect("never poisoned")
                .remove(file);
            return None;
        };
        let stamp = Stamp::of(&meta);
        if let Some(stamp) = &stamp
            && let Some(cached) = self
                .caches
                .matchers
                .lock()
                .expect("never poisoned")
                .get(file)
            && cached.holds_for(stamp, self.caches.granularity)
        {
            return Some(Arc::clone(&cached.value));
        }
        let mut builder = GitignoreBuilder::new(dir);
        // An unreadable file or a bad line leaves the rules that did parse,
        // like `Gitignore::new` does.
        builder.add(file);
        let matcher = Arc::new(builder.build().unwrap_or_else(|_| Gitignore::empty()));
        if let Some(stamp) = stamp {
            self.caches.matchers.lock().expect("never poisoned").insert(
                file.to_path_buf(),
                Stamped {
                    stamp,
                    seen,
                    value: Arc::clone(&matcher),
                },
            );
        }
        Some(matcher)
    }
}

/// The folders from `root` down to the one holding `segments`, and the
/// file's absolute path under `root`.
fn folders_to(root: &Path, segments: &[&str]) -> (Vec<PathBuf>, PathBuf) {
    let mut dirs = vec![root.to_path_buf()];
    let mut dir = root.to_path_buf();
    for segment in &segments[..segments.len() - 1] {
        dir.push(segment);
        dirs.push(dir.clone());
    }
    let mut abs = root.to_path_buf();
    abs.extend(segments);
    (dirs, abs)
}

/// `.git` and the state folder in every spelling a file system might fold
/// into them, so a shared `.GIT/config` is neither written nor uploaded.
pub(super) fn is_always_skipped(name: &str) -> bool {
    is_reserved_segment(name)
}

/// Case-insensitive, since `.GITIGNORE` is `.gitignore` on macOS.
pub(super) fn is_git_file(name: &str) -> bool {
    GIT_FILES.iter().any(|file| name.eq_ignore_ascii_case(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_excludes_apply_to_single_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let global = root.join("global-ignore");
        let tree = root.join("tree");
        fs::create_dir_all(&tree).unwrap();
        fs::write(&global, ".DS_Store\n*.swp\n").unwrap();
        let wt = Worktree::new(&tree);
        // Stands in for core.excludesFile, which would otherwise come from
        // the developer's own git config.
        *wt.caches.ignore_base.lock().unwrap() = Some(Arc::new(IgnoreBase {
            root: tree.clone(),
            outer: Vec::new(),
            exclude: None,
            global: Some((global, tree.clone())),
        }));
        assert!(wt.is_ignored(".DS_Store", false));
        assert!(wt.is_ignored("chapters/.intro.typ.swp", false));
        assert!(!wt.is_ignored("main.typ", false));

        // A project's own rules still win over the global ones.
        fs::write(tree.join(".gitignore"), "!keep.swp\n").unwrap();
        assert!(!wt.is_ignored("keep.swp", false));
    }
}
