//! The synced folder on disk: scanning it the way git would see it,
//! classifying files like the browser's upload does, and writing files
//! back without ever following a symlink out of the folder.

mod classify;
mod ignore;
mod stamp;

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use ::ignore::WalkBuilder;
use anyhow::{Context, bail};
use typstry_doc::materialize::is_safe_path;

use crate::api::MAX_UPLOAD_BYTES;
use crate::hash::Digest;
use crate::state::{STATE_DIR, atomic_write};

pub use self::classify::{MAX_ASSET_BYTES, MAX_TEXT_BYTES, as_text, case_clashes, mime_for};
pub use self::ignore::{GIT_FILE_REASON, GIT_FILES, IGNORE_FILE};
use self::ignore::{is_always_skipped, is_git_file};
use self::stamp::{Caches, Stamp, Stamped};

/// One file as found on disk. Holds the text for files that could be text,
/// and only a digest for the rest, so scanning a folder of images does not
/// keep them all in memory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    pub digest: Digest,
    pub size: u64,
    /// The content if it may be stored as a text node, see [`as_text`].
    /// Shared, so the stat cache and doc entries hand it out without
    /// copying.
    pub text: Option<Arc<str>>,
}

impl LocalFile {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        let digest = Digest::of(&bytes);
        let size = bytes.len() as u64;
        Self {
            digest,
            size,
            text: as_text(bytes).map(Arc::from),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    /// Empty for problems that are not about one path, like an unreadable
    /// ignore file.
    pub path: String,
    pub reason: String,
}

fn too_large(path: String) -> Skipped {
    Skipped {
        path,
        reason: format!(
            "larger than the {} MB upload limit",
            MAX_UPLOAD_BYTES / 1024 / 1024
        ),
    }
}

impl std::fmt::Display for Skipped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.reason)
        } else {
            write!(f, "{}: {}", self.path, self.reason)
        }
    }
}

#[derive(Debug, Default)]
pub struct Scan {
    /// By `/`-separated path relative to the root.
    pub files: BTreeMap<String, LocalFile>,
    pub skipped: Vec<Skipped>,
    /// Paths left out by default as [`GIT_FILES`], which are not worth a
    /// warning on every sync but are in a preview.
    pub git_files: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Worktree {
    root: PathBuf,
    case_insensitive: OnceLock<bool>,
    caches: Arc<Caches>,
}

impl Worktree {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            case_insensitive: OnceLock::new(),
            caches: Arc::default(),
        }
    }

    /// Whether names that differ only in case are one file here, as on
    /// macOS and Windows by default. Asked of the file system once, since
    /// it depends on the volume rather than the OS.
    pub fn case_insensitive(&self) -> bool {
        *self.case_insensitive.get_or_init(|| {
            // Inside the state folder when there is one, so the watcher
            // and the scan never see the probe.
            let state = self.root.join(STATE_DIR);
            let dir = if state.is_dir() {
                state
            } else {
                self.root.clone()
            };
            let tag = crate::state::random_hex(4);
            let lower = dir.join(format!(".case-probe-{tag}"));
            let upper = dir.join(format!(".CASE-PROBE-{tag}"));
            if fs::write(&lower, b"").is_err() {
                // Cannot tell; assuming insensitive only ever skips writes.
                return cfg!(any(target_os = "macos", windows));
            }
            let insensitive = fs::symlink_metadata(&upper).is_ok();
            let _ = fs::remove_file(&lower);
            insensitive
        })
    }

    /// Whether a file or folder named exactly `path`, case included, is on
    /// disk. On a case-insensitive file system [`Self::exists`] also
    /// answers yes for a case variant.
    pub fn exists_exact(&self, path: &str) -> bool {
        let abs = self.abs(path);
        let (Some(parent), Some(name)) = (abs.parent(), abs.file_name()) else {
            return false;
        };
        fs::read_dir(parent)
            .is_ok_and(|mut entries| entries.any(|e| e.is_ok_and(|e| e.file_name() == name)))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Every file git would see, plus `.typstryignore` rules on top.
    /// Symlinks are skipped (and reported), never followed.
    pub fn scan(&self) -> anyhow::Result<Scan> {
        let mut scan = Scan::default();
        let git_files = Arc::new(Mutex::new(Vec::new()));
        let filter = {
            let worktree = self.clone();
            let git_files = Arc::clone(&git_files);
            move |entry: &::ignore::DirEntry| {
                if entry.depth() == 0 {
                    return true;
                }
                let name = entry.file_name().to_str().unwrap_or("");
                if is_always_skipped(name) {
                    return false;
                }
                if is_git_file(name)
                    && let Some(path) = worktree.relative(entry.path())
                {
                    let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                    if !worktree.opted_in(&path, is_dir) {
                        git_files.lock().expect("never poisoned").push(path);
                        return false;
                    }
                }
                true
            }
        };
        let walker = WalkBuilder::new(&self.root)
            .hidden(false)
            .parents(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            // A folder that is not a git repo still has a .gitignore that
            // says what is build output.
            .require_git(false)
            .follow_links(false)
            .add_custom_ignore_filename(IGNORE_FILE)
            .filter_entry(filter)
            .build();
        for entry in walker {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    scan.skipped.push(Skipped {
                        path: String::new(),
                        reason: err.to_string(),
                    });
                    continue;
                }
            };
            if entry.depth() == 0 {
                continue;
            }
            let Some(path) = self.relative(entry.path()) else {
                continue;
            };
            let Some(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                scan.skipped.push(Skipped {
                    path,
                    reason: "symlinks are not synced".into(),
                });
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let seen = SystemTime::now();
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(err) => {
                    scan.skipped.push(Skipped {
                        path,
                        reason: err.to_string(),
                    });
                    continue;
                }
            };
            // Anything past the asset limit is past the text limit too, so
            // it is skipped without reading what may be a huge video.
            if meta.len() > MAX_ASSET_BYTES as u64 {
                scan.skipped.push(too_large(path));
                continue;
            }
            // The walker follows no links, so the file's folders are real
            // folders and its own metadata is what `read` would look up.
            match self.read_known(&path, &meta, seen) {
                Ok(Some(file)) => {
                    if file.size as usize > MAX_ASSET_BYTES && file.text.is_none() {
                        scan.skipped.push(too_large(path));
                    } else {
                        scan.files.insert(path, file);
                    }
                }
                Ok(None) => {}
                Err(err) => scan.skipped.push(Skipped {
                    path,
                    reason: err.to_string(),
                }),
            }
        }
        // Files that went away or became ignored would otherwise stay
        // cached for as long as the sync runs.
        self.caches
            .files
            .lock()
            .expect("never poisoned")
            .retain(|path, _| scan.files.contains_key(path));
        scan.git_files = std::mem::take(&mut *git_files.lock().expect("never poisoned"));
        scan.git_files.sort();
        Ok(scan)
    }

    /// The `/`-separated project path of `abs`, if it is inside the root
    /// and representable (UTF-8).
    pub fn relative(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        let mut parts = Vec::new();
        for component in rel.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_str()?),
                _ => return None,
            }
        }
        (!parts.is_empty()).then(|| parts.join("/"))
    }

    pub fn abs(&self, path: &str) -> PathBuf {
        let mut out = self.root.clone();
        for segment in path.split('/') {
            // `push` replaces the whole path for an absolute segment, or on
            // Windows for one with a drive like `C:`, and `..` climbs out.
            // Writes refuse such paths up front (see `check_writable`); this
            // is the backstop that keeps every other caller inside the root.
            let mut parts = Path::new(segment).components();
            if matches!(
                (parts.next(), parts.next()),
                (Some(Component::Normal(_)), None)
            ) {
                out.push(segment);
            }
        }
        out
    }

    /// Reads one file. None when it does not exist or is not a regular
    /// file, e.g. a symlink or a folder.
    ///
    /// Unchanged files come from a cache keyed by what `stat` says, so a
    /// full scan only reads and hashes what was edited since the last one.
    pub fn read(&self, path: &str) -> io::Result<Option<LocalFile>> {
        let seen = SystemTime::now();
        let meta = if self.symlinked_parent(path).is_some() {
            None
        } else {
            match fs::symlink_metadata(self.abs(path)) {
                Ok(meta) => Some(meta).filter(fs::Metadata::is_file),
                Err(err) if err.kind() == io::ErrorKind::NotFound => None,
                Err(err) => return Err(err),
            }
        };
        let Some(meta) = meta else {
            self.forget(path);
            return Ok(None);
        };
        self.read_known(path, &meta, seen)
    }

    /// [`Self::read`] for a regular file whose metadata the caller has,
    /// taken no earlier than `seen`.
    fn read_known(
        &self,
        path: &str,
        meta: &fs::Metadata,
        seen: SystemTime,
    ) -> io::Result<Option<LocalFile>> {
        let stamp = Stamp::of(meta);
        if let Some(stamp) = &stamp
            && let Some(cached) = self.caches.files.lock().expect("never poisoned").get(path)
            && cached.holds_for(stamp, self.caches.granularity)
        {
            return Ok(Some(cached.value.clone()));
        }
        let Some(bytes) = self.read_bytes(path)? else {
            self.forget(path);
            return Ok(None);
        };
        #[cfg(test)]
        self.caches
            .reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = LocalFile::from_bytes(bytes);
        // A length that differs from the stat means the file was written
        // while being read; the next read gets to look again.
        match stamp {
            Some(stamp) if stamp.len == file.size => {
                self.caches.files.lock().expect("never poisoned").insert(
                    path.to_owned(),
                    Stamped {
                        stamp,
                        seen,
                        value: file.clone(),
                    },
                );
            }
            _ => self.forget(path),
        }
        Ok(Some(file))
    }

    /// Whether `path` is still the file `file` was read from, judged by
    /// its stat alone. False whenever only its bytes could tell, including
    /// a file changed so recently that a second write may have left its
    /// stat as it was.
    pub fn unchanged_since_read(&self, path: &str, file: &LocalFile) -> bool {
        let Ok(meta) = fs::symlink_metadata(self.abs(path)) else {
            return false;
        };
        let Some(stamp) = Stamp::of(&meta).filter(|_| meta.is_file()) else {
            return false;
        };
        self.caches
            .files
            .lock()
            .expect("never poisoned")
            .get(path)
            .is_some_and(|cached| {
                cached.value.digest == file.digest
                    && cached.holds_for(&stamp, self.caches.granularity)
            })
    }

    fn forget(&self, path: &str) {
        self.caches
            .files
            .lock()
            .expect("never poisoned")
            .remove(path);
    }

    pub fn read_bytes(&self, path: &str) -> io::Result<Option<Vec<u8>>> {
        if self.symlinked_parent(path).is_some() {
            return Ok(None);
        }
        let abs = self.abs(path);
        match fs::symlink_metadata(&abs) {
            Ok(meta) if meta.is_file() => fs::read(&abs).map(Some),
            Ok(_) => Ok(None),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Whether anything (file, folder or link) sits at `path`.
    pub fn exists(&self, path: &str) -> bool {
        fs::symlink_metadata(self.abs(path)).is_ok()
    }

    /// The first parent folder of `path` that is a symlink or not a folder.
    fn symlinked_parent(&self, path: &str) -> Option<String> {
        let mut current = self.root.clone();
        let segments: Vec<&str> = path.split('/').collect();
        for (i, segment) in segments[..segments.len().saturating_sub(1)]
            .iter()
            .enumerate()
        {
            current.push(segment);
            match fs::symlink_metadata(&current) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return Some(segments[..=i].join("/")),
                Err(_) => return None,
            }
        }
        None
    }

    /// Fails when [`Self::write`] would refuse `path`: a symlinked or
    /// non-folder parent, or a symlink or folder at the path itself. Either
    /// could put the file outside the project or destroy something. So
    /// could a path that is not [`is_safe_path`], which `materialize` never
    /// lists; refusing it here keeps a future caller from slipping one in.
    pub fn check_writable(&self, path: &str) -> anyhow::Result<()> {
        if !is_safe_path(path) {
            bail!("{path:?} is not a safe path, not writing it");
        }
        if let Some(parent) = self.symlinked_parent(path) {
            bail!("{parent} is a symlink or a file, not writing {path} through it");
        }
        match fs::symlink_metadata(self.abs(path)) {
            Ok(meta) if meta.file_type().is_symlink() => {
                bail!("{path} is a symlink, not replacing it")
            }
            Ok(meta) if meta.is_dir() => bail!("{path} is a folder, not replacing it"),
            _ => Ok(()),
        }
    }

    /// Writes a file atomically, creating its folders. See
    /// [`Self::check_writable`] for what it refuses.
    pub fn write(&self, path: &str, bytes: &[u8]) -> anyhow::Result<()> {
        self.check_writable(path)?;
        let abs = self.abs(path);
        let previous = fs::symlink_metadata(&abs)
            .ok()
            .filter(fs::Metadata::is_file)
            .map(|meta| meta.permissions());
        if let Some(dir) = abs.parent() {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        atomic_write(&abs, bytes, false)?;
        self.forget(path);
        // Keeps an executable bit or a read-only flag the user set.
        if let Some(permissions) = previous {
            let _ = fs::set_permissions(&abs, permissions);
        }
        Ok(())
    }

    /// Deletes a file and then every folder it leaves empty, up to the
    /// root. Anything but a regular file is left alone.
    pub fn remove(&self, path: &str) -> anyhow::Result<()> {
        if !is_safe_path(path) || self.symlinked_parent(path).is_some() {
            return Ok(());
        }
        let abs = self.abs(path);
        match fs::symlink_metadata(&abs) {
            Ok(meta) if meta.is_file() => {
                fs::remove_file(&abs).with_context(|| format!("deleting {path}"))?;
                self.forget(path);
            }
            _ => return Ok(()),
        }
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if d == self.root || !d.starts_with(&self.root) || fs::remove_dir(d).is_err() {
                break;
            }
            dir = d.parent();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn tree() -> (tempfile::TempDir, Worktree) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, Worktree::new(root))
    }

    fn tree_with(granularity: Duration) -> (tempfile::TempDir, Worktree) {
        let (dir, mut wt) = tree();
        wt.caches = Arc::new(Caches {
            granularity,
            ..Caches::default()
        });
        (dir, wt)
    }

    /// A worktree that trusts timestamps at once, so tests can tell cache
    /// hits from the racy-timestamp rereads without sleeping.
    fn trusting_tree() -> (tempfile::TempDir, Worktree) {
        tree_with(Duration::ZERO)
    }

    fn reads(wt: &Worktree) -> usize {
        wt.caches.reads.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Writes `content` and dates the file back, as if it had been
    /// written long before the scan.
    fn write_old(wt: &Worktree, path: &str, content: &str, age_secs: u64) {
        fs::write(wt.abs(path), content).unwrap();
        let mtime = SystemTime::now() - Duration::from_secs(age_secs);
        fs::File::options()
            .write(true)
            .open(wt.abs(path))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
    }

    #[test]
    fn rescans_only_changed_files() {
        let (_dir, wt) = trusting_tree();
        write_old(&wt, "main.typ", "= One", 3600);
        write_old(&wt, "logo.png", "\0png", 3600);
        assert_eq!(wt.scan().unwrap().files.len(), 2);
        assert_eq!(reads(&wt), 2);
        let scan = wt.scan().unwrap();
        assert_eq!(reads(&wt), 2);
        assert_eq!(scan.files["main.typ"].text.as_deref(), Some("= One"));
        assert_eq!(scan.files["logo.png"].digest, Digest::of(b"\0png"));

        // Same size, so only the stamp's times tell the edit apart.
        write_old(&wt, "main.typ", "= Two", 1800);
        let scan = wt.scan().unwrap();
        assert_eq!(reads(&wt), 3);
        assert_eq!(scan.files["main.typ"].text.as_deref(), Some("= Two"));

        fs::remove_file(wt.abs("logo.png")).unwrap();
        assert!(!wt.scan().unwrap().files.contains_key("logo.png"));
        assert!(!wt.caches.files.lock().unwrap().contains_key("logo.png"));
    }

    #[cfg(unix)]
    #[test]
    fn rereads_a_file_whose_mtime_was_restored() {
        let (_dir, wt) = trusting_tree();
        write_old(&wt, "main.typ", "= One", 3600);
        let mtime = fs::metadata(wt.abs("main.typ"))
            .unwrap()
            .modified()
            .unwrap();
        wt.scan().unwrap();
        // Like `cp -p` or an unpacked archive: new bytes, old mtime. Only
        // the ctime moves.
        std::thread::sleep(Duration::from_millis(10));
        fs::write(wt.abs("main.typ"), "= Two").unwrap();
        fs::File::options()
            .write(true)
            .open(wt.abs("main.typ"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        let scan = wt.scan().unwrap();
        assert_eq!(scan.files["main.typ"].text.as_deref(), Some("= Two"));
    }

    #[test]
    fn tells_an_unchanged_file_by_its_stat() {
        let (_dir, wt) = trusting_tree();
        write_old(&wt, "main.typ", "= One", 3600);
        let file = wt.read("main.typ").unwrap().unwrap();
        assert!(wt.unchanged_since_read("main.typ", &file));
        write_old(&wt, "main.typ", "= Two", 1800);
        assert!(!wt.unchanged_since_read("main.typ", &file));

        // A file still settling is never vouched for.
        let (_dir, wt) = tree();
        fs::write(wt.abs("main.typ"), "= One").unwrap();
        let file = wt.read("main.typ").unwrap().unwrap();
        assert!(!wt.unchanged_since_read("main.typ", &file));
    }

    #[test]
    fn rereads_racily_clean_files() {
        let granularity = Duration::from_millis(200);
        let (_dir, wt) = tree_with(granularity);
        fs::write(wt.abs("main.typ"), "= One").unwrap();
        // Written within the granularity of the read, so a second write
        // in the same tick could hide behind an unchanged stamp.
        wt.scan().unwrap();
        wt.scan().unwrap();
        assert_eq!(reads(&wt), 2);

        // Read again once the file has been quiet for longer than that,
        // and only from then on trusted.
        std::thread::sleep(granularity + Duration::from_millis(50));
        wt.scan().unwrap();
        let scan = wt.scan().unwrap();
        assert_eq!(reads(&wt), 3);
        assert_eq!(scan.files["main.typ"].text.as_deref(), Some("= One"));
    }

    #[test]
    fn notices_edited_ignore_files() {
        let (_dir, wt) = tree();
        fs::write(wt.abs("a.typ"), "").unwrap();
        fs::write(wt.abs("b.typ"), "").unwrap();
        fs::write(wt.abs(".gitignore"), "a.typ\n").unwrap();
        assert!(wt.is_ignored("a.typ", false));
        assert!(!wt.is_ignored("b.typ", false));

        fs::write(wt.abs(".gitignore"), "b.typ\n").unwrap();
        assert!(!wt.is_ignored("a.typ", false));
        assert!(wt.is_ignored("b.typ", false));

        fs::write(wt.abs(IGNORE_FILE), "!b.typ\n").unwrap();
        assert!(!wt.is_ignored("b.typ", false));
        fs::remove_file(wt.abs(IGNORE_FILE)).unwrap();
        fs::remove_file(wt.abs(".gitignore")).unwrap();
        assert!(!wt.is_ignored("b.typ", false));
    }

    #[test]
    fn reuses_compiled_ignore_files_until_they_change() {
        let (_dir, wt) = trusting_tree();
        write_old(&wt, ".gitignore", "a.typ\n", 3600);
        assert!(wt.is_ignored("a.typ", false));
        let first = wt
            .matcher(&wt.root().join(".gitignore"), wt.root())
            .unwrap();
        let again = wt
            .matcher(&wt.root().join(".gitignore"), wt.root())
            .unwrap();
        assert!(Arc::ptr_eq(&first, &again));

        write_old(&wt, ".gitignore", "b.typ\n", 1800);
        assert!(!wt.is_ignored("a.typ", false));
        assert!(wt.is_ignored("b.typ", false));
    }

    #[test]
    fn scans_with_ignore_rules() {
        let (_dir, wt) = tree();
        let root = wt.root().to_path_buf();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join(STATE_DIR)).unwrap();
        fs::write(root.join(".git/HEAD"), "x").unwrap();
        fs::write(root.join(".typstry/doc.bin"), "x").unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join(IGNORE_FILE), "README.md\n").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();
        fs::write(root.join("build/out.pdf"), "x").unwrap();
        fs::write(root.join("main.typ"), "= Hi").unwrap();
        fs::write(root.join("logo.png"), [0x89, 0x50, 0, 1]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("main.typ"), root.join("link.typ")).unwrap();

        let scan = wt.scan().unwrap();
        let paths: Vec<&str> = scan.files.keys().map(String::as_str).collect();
        assert_eq!(paths, ["logo.png", "main.typ"]);
        assert_eq!(scan.git_files, [".gitignore", IGNORE_FILE]);
        assert_eq!(scan.files["main.typ"].text.as_deref(), Some("= Hi"));
        assert_eq!(scan.files["logo.png"].text, None);
        #[cfg(unix)]
        assert_eq!(scan.skipped[0].path, "link.typ");

        assert!(wt.is_ignored("build/out.pdf", false));
        assert!(wt.is_ignored("README.md", false));
        assert!(wt.is_ignored(".git/HEAD", false));
        assert!(!wt.is_ignored("main.typ", false));
        assert!(wt.is_ignored(".gitignore", false));
        assert!(wt.is_ignored(IGNORE_FILE, false));
    }

    #[test]
    fn git_files_stay_local_unless_opted_in() {
        let (_dir, wt) = tree();
        let root = wt.root().to_path_buf();
        fs::create_dir_all(root.join(".github/workflows")).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join(".github/workflows/ci.yml"), "x").unwrap();
        fs::write(root.join(".gitattributes"), "* text=auto\n").unwrap();
        fs::write(root.join(".gitmodules"), "").unwrap();
        fs::write(root.join("sub/.gitignore"), "*.pdf\n").unwrap();
        fs::write(root.join("main.typ"), "= Hi").unwrap();

        let scan = wt.scan().unwrap();
        let paths: Vec<&str> = scan.files.keys().map(String::as_str).collect();
        assert_eq!(paths, ["main.typ"]);
        assert_eq!(
            scan.git_files,
            [".gitattributes", ".github", ".gitmodules", "sub/.gitignore"]
        );
        assert!(wt.is_ignored(".github/workflows/ci.yml", false));
        assert!(wt.is_ignored("sub/.gitignore", false));
        assert!(wt.is_ignored(".github", true));

        fs::write(root.join(IGNORE_FILE), "!.gitattributes\n!.github/\n").unwrap();
        let scan = wt.scan().unwrap();
        let paths: Vec<&str> = scan.files.keys().map(String::as_str).collect();
        assert_eq!(
            paths,
            [".gitattributes", ".github/workflows/ci.yml", "main.typ"]
        );
        assert!(!wt.is_ignored(".gitattributes", false));
        assert!(!wt.is_ignored(".github/workflows/ci.yml", false));
        assert!(wt.is_ignored(IGNORE_FILE, false));
        assert!(wt.is_ignored("sub/.gitignore", false));
    }

    #[test]
    fn git_and_state_dirs_are_skipped_in_any_spelling() {
        let (_dir, wt) = tree();
        for path in [
            ".GIT/config",
            "sub/.Git/config",
            "GIT~1/HEAD",
            ".git./config",
            ".Typstry/config.json",
        ] {
            assert!(wt.is_ignored(path, false), "{path}");
            assert!(wt.check_writable(path).is_err(), "{path}");
            assert!(wt.write(path, b"[core]").is_err(), "{path}");
        }
        assert!(wt.is_ignored(".GITIGNORE", false));
        assert!(!wt.abs("sub").exists());
        assert!(!wt.abs(".GIT").exists());

        // On a case-sensitive disk these are separate folders that git
        // ignores, but uploading them would hand them to everyone else.
        let root = wt.root().to_path_buf();
        fs::create_dir_all(root.join("sub/.Git")).unwrap();
        fs::write(root.join("sub/.Git/config"), "[core]").unwrap();
        fs::write(root.join("main.typ"), "= Hi").unwrap();
        let scan = wt.scan().unwrap();
        let paths: Vec<&str> = scan.files.keys().map(String::as_str).collect();
        assert_eq!(paths, ["main.typ"]);
    }

    #[test]
    fn refuses_paths_that_could_leave_the_root() {
        let (_dir, wt) = tree();
        for path in [
            "C:/x.typ", "a:b.typ", "nul.txt", "notes.", "../x.typ", "/x.typ",
        ] {
            assert!(wt.write(path, b"x").is_err(), "{path}");
            assert!(wt.abs(path).starts_with(wt.root()), "{path}");
        }
        assert_eq!(fs::read_dir(wt.root()).unwrap().count(), 0);
    }

    #[test]
    fn writes_and_prunes_folders() {
        let (_dir, wt) = tree();
        wt.write("a/b/c.typ", b"x").unwrap();
        assert_eq!(fs::read(wt.abs("a/b/c.typ")).unwrap(), b"x");
        wt.write("a/keep.typ", b"y").unwrap();
        wt.remove("a/b/c.typ").unwrap();
        assert!(!wt.abs("a/b").exists());
        assert!(wt.abs("a/keep.typ").exists());
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_symlinks() {
        let (_dir, wt) = tree();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), wt.abs("out")).unwrap();
        assert!(wt.write("out/evil.typ", b"x").is_err());
        assert!(!outside.path().join("evil.typ").exists());
        assert_eq!(wt.read("out/evil.typ").unwrap(), None);
    }

    #[test]
    fn probes_case_sensitivity() {
        let (_dir, wt) = tree();
        fs::write(wt.abs("Notes.typ"), "x").unwrap();
        assert!(wt.exists_exact("Notes.typ"));
        assert!(!wt.exists_exact("notes.typ"));
        assert_eq!(wt.exists("notes.typ"), wt.case_insensitive());
        // The probe leaves nothing behind.
        assert_eq!(fs::read_dir(wt.root()).unwrap().count(), 1);
    }
}
