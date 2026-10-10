//! The synced folder on disk: scanning it the way git would see it,
//! classifying files like the browser's upload does, and writing files
//! back without ever following a symlink out of the folder.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, bail};
use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use sha2::{Digest, Sha256};
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

#[derive(Debug, Clone)]
pub struct Worktree {
    root: PathBuf,
    case_insensitive: OnceLock<bool>,
}

impl Worktree {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            case_insensitive: OnceLock::new(),
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
            let mut suffix = [0u8; 4];
            getrandom::fill(&mut suffix).expect("OS random source unavailable");
            let tag: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
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
                if GIT_FILES.contains(&name)
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
            match self.read(&path) {
                Ok(Some(file)) => {
                    if file.size as usize > MAX_ASSET_BYTES && file.text.is_none() {
                        scan.skipped.push(Skipped {
                            reason: format!(
                                "larger than the {} MB upload limit",
                                MAX_UPLOAD_BYTES / 1024 / 1024
                            ),
                            path,
                        });
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
        out.extend(path.split('/'));
        out
    }

    /// Reads one file. None when it does not exist or is not a regular
    /// file, e.g. a symlink or a folder.
    pub fn read(&self, path: &str) -> io::Result<Option<LocalFile>> {
        Ok(self.read_bytes(path)?.map(LocalFile::from_bytes))
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
    /// could put the file outside the project or destroy something.
    pub fn check_writable(&self, path: &str) -> anyhow::Result<()> {
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
        // Keeps an executable bit or a read-only flag the user set.
        if let Some(permissions) = previous {
            let _ = fs::set_permissions(&abs, permissions);
        }
        Ok(())
    }

    /// Deletes a file and then every folder it leaves empty, up to the
    /// root. Anything but a regular file is left alone.
    pub fn remove(&self, path: &str) -> anyhow::Result<()> {
        if self.symlinked_parent(path).is_some() {
            return Ok(());
        }
        let abs = self.abs(path);
        match fs::symlink_metadata(&abs) {
            Ok(meta) if meta.is_file() => {
                fs::remove_file(&abs).with_context(|| format!("deleting {path}"))?;
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
            if GIT_FILES.contains(segment) {
                let last = i == segments.len() - 1;
                if !self.opted_in(&segments[..=i].join("/"), is_dir || !last) {
                    return true;
                }
            }
        }
        let root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let mut matchers = Vec::new();
        // Outermost first, so the loop below can let deeper rules win.
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(repo) = crate::git::Repo::discover(&root) {
            let mut builder = GitignoreBuilder::new(&repo.workdir);
            builder.add(repo.common_dir.join("info").join("exclude"));
            if let Ok(exclude) = builder.build() {
                matchers.push(exclude);
            }
            dirs.extend(
                root.ancestors()
                    .skip(1)
                    .take_while(|dir| dir.starts_with(&repo.workdir))
                    .map(Path::to_path_buf),
            );
            dirs.reverse();
        }
        let mut dir = root.clone();
        dirs.push(dir.clone());
        for segment in &segments[..segments.len() - 1] {
            dir.push(segment);
            dirs.push(dir.clone());
        }
        for dir in &dirs {
            matchers.extend(dir_matchers(dir));
        }
        let mut abs = root;
        abs.extend(&segments);
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
}

impl Worktree {
    /// Whether `.typstryignore` re-includes one of the [`GIT_FILES`] with a
    /// negated pattern. Only `.typstryignore` counts: a `.gitignore` that
    /// negates itself is about git, not about co-authors.
    fn opted_in(&self, path: &str, is_dir: bool) -> bool {
        let root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let segments: Vec<&str> = path.split('/').collect();
        let mut dirs = vec![root.clone()];
        let mut dir = root.clone();
        for segment in &segments[..segments.len() - 1] {
            dir.push(segment);
            dirs.push(dir.clone());
        }
        let mut abs = root;
        abs.extend(&segments);
        // Deepest first, so a nested file overrides the top-level one.
        for dir in dirs.iter().rev() {
            let file = dir.join(IGNORE_FILE);
            if !file.is_file() {
                continue;
            }
            let (matcher, _) = Gitignore::new(file);
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
}

fn is_always_skipped(name: &str) -> bool {
    name == ".git" || name == STATE_DIR
}

/// The ignore files of one folder, `.typstryignore` last so it wins.
fn dir_matchers(dir: &Path) -> Vec<Gitignore> {
    [".gitignore", IGNORE_FILE]
        .into_iter()
        .map(|name| dir.join(name))
        .filter(|path| path.is_file())
        .map(|path| Gitignore::new(path).0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (tempfile::TempDir, Worktree) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, Worktree::new(root))
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
