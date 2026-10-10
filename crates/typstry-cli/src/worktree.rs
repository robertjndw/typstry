//! The synced folder on disk: scanning it the way git would see it,
//! classifying files like the browser's upload does, and writing files
//! back without ever following a symlink out of the folder.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use anyhow::{Context, bail};
use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use sha2::{Digest, Sha256};
use typstry_doc::materialize::is_safe_path;
use typstry_doc::names::is_reserved_segment;
use typstry_wire::crypto::SEAL_OVERHEAD;

use crate::api::MAX_UPLOAD_BYTES;
use crate::state::{STATE_DIR, atomic_write};

/// Same cutoff as `MAX_TEXT_BYTES` in `apps/web/src/assets/upload.ts`:
/// larger files go to the blob store so they do not bloat every peer's
/// history forever.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// Largest asset that still fits the server's limit once sealed, like
/// `MAX_ASSET_BYTES` in the web app.
pub const MAX_ASSET_BYTES: usize = MAX_UPLOAD_BYTES - SEAL_OVERHEAD;

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

/// One file as found on disk. Holds the text for files that could be text,
/// and only a digest for the rest, so scanning a folder of images does not
/// keep them all in memory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    /// `sha256:<hex>` of the bytes on disk.
    pub digest: String,
    pub size: u64,
    /// The content if it may be stored as a text node, see [`as_text`].
    pub text: Option<String>,
}

impl LocalFile {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        let digest = digest(&bytes);
        let size = bytes.len() as u64;
        Self {
            digest,
            size,
            text: as_text(bytes),
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

/// `sha256:<hex>`, the same spelling the server uses for blob hashes.
pub fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for b in hash {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// The text of a file that can be a text node: valid UTF-8, no NUL bytes
/// (which no text format has, but many binaries that happen to decode do),
/// and at most [`MAX_TEXT_BYTES`]. Line endings are kept as they are, so a
/// file round-trips byte for byte and git sees no spurious changes.
pub fn as_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > MAX_TEXT_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Mime type by extension, the table of `apps/web/src/assets/file-types.ts`.
pub fn mime_for(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    // A leading dot does not start an extension: ".gitignore" has none.
    let ext = match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_ascii_lowercase(),
        _ => return "application/octet-stream",
    };
    match ext.as_str() {
        "typ" => "text/x-typst",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "ttc" | "otc" => "font/collection",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "bib" => "application/x-bibtex",
        "csv" => "text/csv",
        "json" => "application/json",
        "yml" | "yaml" => "application/yaml",
        "toml" => "application/toml",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "md" => "text/markdown",
        _ => "application/octet-stream",
    }
}

/// Paths that only differ in case, which a case-insensitive file system
/// stores as one file. One path of each group is kept: the first one
/// `prefer` accepts, else the first in sorted order. Returns `(kept,
/// dropped)` pairs.
pub fn case_clashes<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    prefer: impl Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut groups: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for path in paths {
        groups.entry(path.to_lowercase()).or_default().insert(path);
    }
    let mut clashes = Vec::new();
    for group in groups.values().filter(|g| g.len() > 1) {
        let kept = group
            .iter()
            .find(|p| prefer(p))
            .or_else(|| group.first())
            .expect("groups are not empty");
        for path in group.iter().filter(|p| *p != kept) {
            clashes.push(((*kept).to_owned(), (*path).to_owned()));
        }
    }
    clashes
}

/// How far apart two writes to a file must be for its timestamps to tell
/// them apart. Nanoseconds on APFS and ext4, but a second on HFS+ and two
/// on FAT, so this assumes the worst.
const TIMESTAMP_GRANULARITY: Duration = Duration::from_secs(2);

/// What `stat` says about a file, compared instead of its bytes to tell
/// whether it changed, the way git's index does. On unix the inode and
/// ctime also catch a file replaced by a rename or written by a tool that
/// restores the old mtime afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    mtime: SystemTime,
    #[cfg(unix)]
    ctime: SystemTime,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl Stamp {
    /// None where the platform has no mtime, which then is never cached.
    fn of(meta: &fs::Metadata) -> Option<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt as _;
        Some(Self {
            len: meta.len(),
            mtime: meta.modified().ok()?,
            #[cfg(unix)]
            ctime: u64::try_from(meta.ctime()).map_or(SystemTime::UNIX_EPOCH, |secs| {
                SystemTime::UNIX_EPOCH + Duration::new(secs, meta.ctime_nsec() as u32)
            }),
            #[cfg(unix)]
            dev: meta.dev(),
            #[cfg(unix)]
            ino: meta.ino(),
        })
    }

    fn last_change(&self) -> SystemTime {
        #[cfg(unix)]
        return self.mtime.max(self.ctime);
        #[cfg(not(unix))]
        self.mtime
    }
}

/// A value derived from a file's bytes, valid while the file's [`Stamp`]
/// stays the same.
#[derive(Debug)]
struct Stamped<V> {
    stamp: Stamp,
    /// When the file was looked at, taken before the `stat`.
    seen: SystemTime,
    value: V,
}

impl<V> Stamped<V> {
    /// Whether the value still describes a file that now has `stamp`. A
    /// file changed within the timestamp granularity of when it was read
    /// is "racily clean" in git's words: a second write in the same tick
    /// leaves the stamp as it was, so the value is not trusted until the
    /// file has been quiet for longer than that.
    fn holds_for(&self, stamp: &Stamp, granularity: Duration) -> bool {
        self.stamp == *stamp
            && self
                .stamp
                .last_change()
                .checked_add(granularity)
                .is_some_and(|settled| settled < self.seen)
    }
}

/// What the ignore rules need about the folder's place on disk. Found once
/// per worktree, so a repo created around a running sync only counts after
/// a restart.
#[derive(Debug)]
struct IgnoreBase {
    /// The canonical root, since the repo's paths are canonical too.
    root: PathBuf,
    /// The folders from the repo's top down to the root's parent, whose
    /// ignore files also apply. Empty outside a repo.
    outer: Vec<PathBuf>,
    /// The repo's `info/exclude` and the folder its patterns are relative
    /// to.
    exclude: Option<(PathBuf, PathBuf)>,
}

/// Shared between clones, so the walker's filter in [`Worktree::scan`]
/// fills the same cache.
#[derive(Debug)]
struct Caches {
    ignore_base: Mutex<Option<Arc<IgnoreBase>>>,
    /// Compiled ignore files by path.
    matchers: Mutex<HashMap<PathBuf, Stamped<Arc<Gitignore>>>>,
    /// Scanned files by project path. Holds the text of text files, which
    /// callers need anyway, and only the digest of assets.
    files: Mutex<HashMap<String, Stamped<LocalFile>>>,
    granularity: Duration,
    /// How often a file was actually read, for tests to see cache hits.
    #[cfg(test)]
    reads: std::sync::atomic::AtomicUsize,
}

impl Default for Caches {
    fn default() -> Self {
        Self {
            ignore_base: Mutex::default(),
            matchers: Mutex::default(),
            files: Mutex::default(),
            granularity: TIMESTAMP_GRANULARITY,
            #[cfg(test)]
            reads: Default::default(),
        }
    }
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
            move |entry: &ignore::DirEntry| {
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
            let too_large = Skipped {
                reason: format!(
                    "larger than the {} MB upload limit",
                    MAX_UPLOAD_BYTES / 1024 / 1024
                ),
                path: path.clone(),
            };
            // Anything past the asset limit is past the text limit too, so
            // it is skipped without reading what may be a huge video.
            if entry
                .metadata()
                .is_ok_and(|meta| meta.len() > MAX_ASSET_BYTES as u64)
            {
                scan.skipped.push(too_large);
                continue;
            }
            match self.read(&path) {
                Ok(Some(file)) => {
                    if file.size as usize > MAX_ASSET_BYTES && file.text.is_none() {
                        scan.skipped.push(too_large);
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
        let stamp = Stamp::of(&meta);
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

    /// Whether the ignore rules exclude `path`, for callers that look at
    /// single paths instead of scanning. Approximates the walker in
    /// [`Self::scan`]: the `.gitignore` and `.typstryignore` files from the
    /// repo root down to the file's folder, plus the repo's `info/exclude`.
    /// The global git excludes are not consulted.
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
    fn opted_in(&self, path: &str, is_dir: bool) -> bool {
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

    fn ignore_base(&self) -> Arc<IgnoreBase> {
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
            });
        };
        let mut outer = Vec::new();
        let mut exclude = None;
        if let Some(repo) = crate::git::Repo::discover(&root) {
            outer.extend(
                root.ancestors()
                    .skip(1)
                    .take_while(|dir| dir.starts_with(&repo.workdir))
                    .map(Path::to_path_buf),
            );
            outer.reverse();
            exclude = Some((repo.common_dir.join("info").join("exclude"), repo.workdir));
        }
        let base = Arc::new(IgnoreBase {
            root,
            outer,
            exclude,
        });
        *cached = Some(Arc::clone(&base));
        base
    }

    /// The compiled rules of the ignore file at `file`, with patterns
    /// relative to `dir`. None when there is no such file. Recompiled
    /// whenever the file's stamp changes, so edits apply right away.
    fn matcher(&self, file: &Path, dir: &Path) -> Option<Arc<Gitignore>> {
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
fn is_always_skipped(name: &str) -> bool {
    is_reserved_segment(name)
}

/// Case-insensitive, since `.GITIGNORE` is `.gitignore` on macOS.
fn is_git_file(name: &str) -> bool {
    GIT_FILES.iter().any(|file| name.eq_ignore_ascii_case(file))
}

#[cfg(test)]
mod tests {
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
        assert_eq!(scan.files["logo.png"].digest, digest(b"\0png"));

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
    fn classifies_like_the_browser() {
        assert_eq!(as_text(b"= Hi\r\n".to_vec()).as_deref(), Some("= Hi\r\n"));
        assert_eq!(as_text(vec![0xff, 0xfe]), None);
        assert_eq!(as_text(b"a\0b".to_vec()), None);
        assert_eq!(as_text(vec![b'a'; MAX_TEXT_BYTES + 1]), None);
        assert_eq!(mime_for("fig/Logo.PNG"), "image/png");
        assert_eq!(mime_for(".png"), "application/octet-stream");
        assert_eq!(mime_for("README"), "application/octet-stream");
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
    fn finds_case_clashes() {
        assert_eq!(
            case_clashes(["b.typ", "main.typ", "Main.typ"], |_| false),
            [("Main.typ".to_owned(), "main.typ".to_owned())]
        );
        assert_eq!(
            case_clashes(["b.typ", "main.typ", "Main.typ"], |p| p == "main.typ"),
            [("main.typ".to_owned(), "Main.typ".to_owned())]
        );
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
