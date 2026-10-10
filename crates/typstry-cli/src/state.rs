//! The `.typstry/` directory next to the synced files: the project link,
//! the cached doc, the base the working tree last matched, decrypted asset
//! blobs, and a lock so two commands never run on the same folder at once.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use loro::{Frontiers, LoroDoc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::api::Permission;
use crate::git::GitMark;
use crate::link::ShareLink;

pub const STATE_DIR: &str = ".typstry";
const CONFIG: &str = "config.json";
const DOC: &str = "doc.bin";
const BASE: &str = "base.json";
const LOCK: &str = "lock";
const BLOBS: &str = "blobs";
const GITIGNORE: &str = ".gitignore";

const LOCK_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The http origin the link points at.
    pub server: String,
    pub project_id: String,
    pub token: String,
    pub key: String,
    pub permission: Permission,
    /// Learned from the server for edit links, so `link` can print both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_token: Option<String>,
    /// Author name for history; overrides `git config user.name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The git branch typstry syncs on; see [`crate::git`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

impl Config {
    pub fn link(&self) -> ShareLink {
        ShareLink::new(&self.server, &self.token, &self.key)
    }

    pub fn view_link(&self) -> Option<ShareLink> {
        match self.permission {
            Permission::Read => Some(self.link()),
            Permission::Write => self
                .view_token
                .as_deref()
                .map(|token| ShareLink::new(&self.server, token, &self.key)),
        }
    }
}

/// What the working tree looked like after the last successful sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Base {
    /// `Frontiers::encode()` as base64url; empty means the empty doc.
    #[serde(default)]
    pub frontiers: String,
    /// Ciphertext hash (what the doc stores) to the plaintext's
    /// `sha256:<hex>`, for every asset we have seen the bytes of. A local
    /// binary is unchanged when its digest maps back to the base's hash.
    #[serde(default)]
    pub assets: BTreeMap<String, String>,
    /// Unix milliseconds of the last successful sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    /// Files whose copy on disk still matches an earlier doc state than
    /// `frontiers`, in the same encoding: ones a pull left alone because
    /// they changed on both sides, or that changed on disk while a sync
    /// was writing. Their local edits are diffed against that state, so
    /// the remote changes they lack are not taken for local reverts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pins: BTreeMap<String, String>,
    /// Where git's HEAD was when the folder was last known to match the
    /// base, to notice a branch switch that happened while nothing ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitMark>,
}

impl Base {
    pub fn frontiers(&self) -> anyhow::Result<Frontiers> {
        decode_frontiers(&self.frontiers)
    }

    pub fn set_frontiers(&mut self, frontiers: &Frontiers) {
        self.frontiers = encode_frontiers(frontiers);
    }

    /// The doc state `path` on disk corresponds to, encoded.
    pub fn state_of(&self, path: &str) -> &str {
        self.pins.get(path).unwrap_or(&self.frontiers)
    }

    pub fn touch(&mut self) {
        self.last_sync = Some(now_ms());
    }
}

pub fn encode_frontiers(frontiers: &Frontiers) -> String {
    if frontiers.is_empty() {
        return String::new();
    }
    URL_SAFE_NO_PAD.encode(frontiers.encode())
}

/// Empty means the empty doc.
pub fn decode_frontiers(encoded: &str) -> anyhow::Result<Frontiers> {
    if encoded.is_empty() {
        return Ok(Frontiers::default());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("base.json has malformed frontiers")?;
    Frontiers::decode(&bytes).context("base.json has malformed frontiers")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The folder's lock is held by `typstry sync`. Commands that can ask
/// the running sync to do their work look for this error.
#[derive(Debug, thiserror::Error)]
#[error(
    "`typstry sync` is running in {} ({holder}) and syncs this folder already; stop it with Ctrl+C to run this command",
    .root.display()
)]
pub struct SyncRunning {
    pub root: PathBuf,
    /// The state folder, where the running sync takes requests.
    pub dir: PathBuf,
    /// What sync wrote into the lock, e.g. `sync, pid 123`.
    pub holder: String,
}

/// An open `.typstry/`, locked for as long as this value lives.
#[derive(Debug)]
pub struct StateDir {
    root: PathBuf,
    dir: PathBuf,
    // Held for the lock, which the OS releases when the file closes, also
    // after a crash, so there is never a stale lock to clean up.
    lock: File,
}

impl StateDir {
    /// Creates `.typstry/` in `root`, which must not have one yet.
    pub fn create(root: &Path) -> anyhow::Result<Self> {
        let dir = root.join(STATE_DIR);
        if dir.exists() {
            bail!("{} is already linked to a typstry project", root.display());
        }
        create_private_dir(&dir)?;
        let state = Self::lock(root.to_path_buf(), dir)?;
        state.ignore_in_git()?;
        Ok(state)
    }

    /// Finds the project `start` is in, walking up like git does, so
    /// commands work from subfolders too.
    pub fn discover(start: &Path) -> anyhow::Result<Self> {
        let start = start
            .canonicalize()
            .with_context(|| format!("cannot open {}", start.display()))?;
        let mut current = Some(start.as_path());
        while let Some(dir) = current {
            if dir.join(STATE_DIR).join(CONFIG).is_file() {
                let state = Self::lock(dir.to_path_buf(), dir.join(STATE_DIR))?;
                // Folders linked before the file existed get it too.
                if !state.dir.join(GITIGNORE).exists() {
                    state.ignore_in_git()?;
                }
                return Ok(state);
            }
            current = dir.parent();
        }
        bail!(
            "{} is not inside a typstry project (no {STATE_DIR}/ found); use `typstry clone` first",
            start.display()
        )
    }

    /// The config of the project `start` is in, without taking the lock,
    /// so commands that only read it work while `sync` runs. Safe because
    /// the config is only ever replaced atomically.
    pub fn peek_config(start: &Path) -> anyhow::Result<Config> {
        let start = start
            .canonicalize()
            .with_context(|| format!("cannot open {}", start.display()))?;
        match start
            .ancestors()
            .map(|dir| dir.join(STATE_DIR).join(CONFIG))
            .find(|path| path.is_file())
        {
            Some(path) => read_json(&path),
            None => bail!(
                "{} is not inside a typstry project (no {STATE_DIR}/ found)",
                start.display()
            ),
        }
    }

    fn lock(root: PathBuf, dir: PathBuf) -> anyhow::Result<Self> {
        let path = dir.join(LOCK);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .with_context(|| format!("cannot open {}", path.display()))?;
        // A process forked by someone else while they held the lock keeps a
        // copy of it until that child execs, so a lock released a moment ago
        // can still look taken. A short grace period hides that; a real
        // second run still fails fast.
        let deadline = Instant::now() + LOCK_GRACE;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(fs::TryLockError::WouldBlock) => {
                    let holder = fs::read_to_string(&path).unwrap_or_default();
                    if holder.starts_with("sync") {
                        return Err(SyncRunning {
                            root,
                            dir,
                            holder: holder.trim().to_owned(),
                        }
                        .into());
                    }
                    bail!(
                        "another typstry command is running in {}; wait for it to finish",
                        root.display()
                    )
                }
                Err(fs::TryLockError::Error(err)) => {
                    return Err(err).with_context(|| format!("cannot lock {}", path.display()));
                }
            }
        }
        // Whatever a crashed holder wrote is stale now.
        let _ = file.set_len(0);
        Ok(Self {
            root,
            dir,
            lock: file,
        })
    }

    /// The folder holds the project key, and `info/exclude` only protects
    /// the repo it was written for: a folder that becomes a repo later, or
    /// is copied into another one, would otherwise offer the key to
    /// `git add -A`.
    fn ignore_in_git(&self) -> anyhow::Result<()> {
        atomic_write(&self.dir.join(GITIGNORE), b"*\n", false)
    }

    /// Records who holds the lock, so a command that finds it taken can
    /// say what is running instead of just that something is.
    pub fn announce(&self, holder: &str) -> anyhow::Result<()> {
        let mut file = &self.lock;
        file.set_len(0)?;
        file.seek(io::SeekFrom::Start(0))?;
        file.write_all(holder.as_bytes())?;
        Ok(())
    }

    /// The folder whose files are synced.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn load_config(&self) -> anyhow::Result<Config> {
        read_json(&self.dir.join(CONFIG))
    }

    pub fn save_config(&self, config: &Config) -> anyhow::Result<()> {
        write_json(&self.dir.join(CONFIG), config)
    }

    pub fn load_base(&self) -> anyhow::Result<Base> {
        let path = self.dir.join(BASE);
        if !path.exists() {
            return Ok(Base::default());
        }
        read_json(&path)
    }

    pub fn save_base(&self, base: &Base) -> anyhow::Result<()> {
        write_json(&self.dir.join(BASE), base)
    }

    /// The cached doc, or an empty one before the first sync.
    pub fn load_doc(&self) -> anyhow::Result<LoroDoc> {
        let doc = LoroDoc::new();
        let path = self.dir.join(DOC);
        match fs::read(&path) {
            Ok(bytes) => {
                doc.import(&bytes)
                    .with_context(|| format!("{} is corrupt", path.display()))?;
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
        }
        Ok(doc)
    }

    pub fn save_doc(&self, doc: &LoroDoc) -> anyhow::Result<()> {
        let bytes = doc
            .export(loro::ExportMode::Snapshot)
            .context("exporting the doc")?;
        atomic_write(&self.dir.join(DOC), &bytes, true)
    }

    /// Where the decrypted bytes of the blob with ciphertext `hash` are
    /// cached. The hash is `sha256:<hex>`; only the hex part names the file.
    pub fn blob_path(&self, hash: &str) -> PathBuf {
        let name: String = hash
            .rsplit(':')
            .next()
            .unwrap_or(hash)
            .chars()
            .filter(char::is_ascii_hexdigit)
            .collect();
        self.dir.join(BLOBS).join(name)
    }

    pub fn read_blob(&self, hash: &str) -> Option<Vec<u8>> {
        fs::read(self.blob_path(hash)).ok()
    }

    pub fn write_blob(&self, hash: &str, plaintext: &[u8]) -> anyhow::Result<()> {
        let dir = self.dir.join(BLOBS);
        if !dir.exists() {
            create_private_dir(&dir)?;
        }
        atomic_write(&self.blob_path(hash), plaintext, true)
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("{} is malformed", path.display()))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes, true)
}

/// The state holds the project key, so nobody else on the machine gets to
/// read it.
pub fn create_private_dir(dir: &Path) -> anyhow::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(dir)
        .with_context(|| format!("cannot create {}", dir.display()))
}

/// Writes through a temp file in the same directory and renames it into
/// place, so a crash or a concurrent reader never sees half a file. The
/// rename replaces a symlink at `path` instead of writing through it.
pub fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> anyhow::Result<()> {
    let dir = path.parent().context("path has no parent")?;
    let name = path.file_name().context("path has no file name")?;
    let mut suffix = [0u8; 6];
    getrandom::fill(&mut suffix).expect("OS random source unavailable");
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        suffix
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    let result = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(err) = result {
        let _ = fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("writing {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        state
            .save_config(&Config {
                server: "http://x".into(),
                project_id: "p".into(),
                token: "t".into(),
                key: "k".into(),
                permission: Permission::Write,
                view_token: None,
                name: None,
                branch: None,
            })
            .unwrap();
        let err = StateDir::discover(dir.path()).unwrap_err();
        assert!(err.to_string().contains("another typstry command"), "{err}");
        drop(state);
        let sub = dir.path().join("a/b");
        fs::create_dir_all(&sub).unwrap();
        let found = StateDir::discover(&sub).unwrap();
        assert_eq!(found.root(), dir.path().canonicalize().unwrap());
    }

    #[test]
    fn git_never_sees_the_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(state.dir().join(GITIGNORE)).unwrap(),
            "*\n"
        );
        fs::write(state.dir().join(CONFIG), "{}").unwrap();
        if crate::git::available() {
            crate::git::run(dir.path(), &["init", "--quiet"]).unwrap();
            let status = crate::git::run(
                dir.path(),
                &["status", "--porcelain", "--untracked-files=all"],
            )
            .unwrap();
            assert_eq!(status, "");
        }
    }

    #[test]
    fn base_round_trips_frontiers() {
        let mut base = Base::default();
        assert!(base.frontiers().unwrap().is_empty());
        let f: Frontiers = loro::ID::new(7, 3).into();
        base.set_frontiers(&f);
        assert_eq!(base.frontiers().unwrap(), f);
    }

    #[test]
    fn atomic_write_replaces_symlinks_instead_of_following() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        fs::write(&outside, "keep").unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            atomic_write(&link, b"new", false).unwrap();
            assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
            assert_eq!(fs::read_to_string(&link).unwrap(), "new");
        }
    }
}
