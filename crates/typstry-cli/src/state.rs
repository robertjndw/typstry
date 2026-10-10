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

use typstry_wire::crypto::ProjectKey;

use crate::api::Permission;
use crate::git::GitMark;
use crate::hash::{BlobHash, Digest};
use crate::link::ShareLink;

pub const STATE_DIR: &str = ".typstry";
const CONFIG: &str = "config.json";
const DOC: &str = "doc.bin";
/// Updates since `doc.bin` was written, see [`StateDir::append_doc`].
const DOC_LOG: &str = "doc.log";
const BASE: &str = "base.json";
const LOCK: &str = "lock";
const BLOBS: &str = "blobs";
const GITIGNORE: &str = ".gitignore";

const LOCK_GRACE: Duration = Duration::from_millis(500);

/// Format versions of `config.json` and `base.json`. Bump one when an
/// older typstry would misread the file, and add the step that brings the
/// previous version up to it to the matching `*_MIGRATIONS`. Files from
/// before versions existed count as version 1.
pub const CONFIG_VERSION: u32 = 1;
pub const BASE_VERSION: u32 = 1;

/// `CONFIG_MIGRATIONS[i]` turns a version `i + 1` config into version
/// `i + 2`, on the raw JSON before it is parsed.
const CONFIG_MIGRATIONS: &[Migration] = &[];
const BASE_MIGRATIONS: &[Migration] = &[];

type Migration = fn(&mut serde_json::Value);

const _: () = assert!(CONFIG_MIGRATIONS.len() as u32 == CONFIG_VERSION - 1);
const _: () = assert!(BASE_MIGRATIONS.len() as u32 == BASE_VERSION - 1);

fn first_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Format of the file, see [`CONFIG_VERSION`]. Always written as the
    /// current one.
    #[serde(default = "first_version")]
    pub version: u32,
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

    /// Always built from the view secret: the edit secret in `key` must
    /// never end up in a link meant for viewers.
    pub fn view_link(&self) -> Option<ShareLink> {
        let secret = ProjectKey::from_base64url(&self.key).ok()?.view_secret();
        let token = match self.permission {
            Permission::Read => &self.token,
            Permission::Write => self.view_token.as_ref()?,
        };
        Some(ShareLink::new(&self.server, token, &secret))
    }

    /// Whether `key` is an edit secret, which writing takes on top of an
    /// edit token.
    pub fn can_sign(&self) -> bool {
        ProjectKey::from_base64url(&self.key).is_ok_and(|key| key.can_sign())
    }
}

/// What the working tree looked like after the last successful sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Base {
    /// Format of the file, see [`BASE_VERSION`]. Always written as the
    /// current one.
    #[serde(default = "first_version")]
    pub version: u32,
    /// The doc state the folder matches. On disk, `Frontiers::encode()` as
    /// base64url, and empty for the empty doc.
    #[serde(default, with = "encoded_frontiers")]
    pub frontiers: Frontiers,
    /// Ciphertext hash (what the doc stores) to the plaintext's digest,
    /// for every asset we have seen the bytes of. A local binary is
    /// unchanged when its digest maps back to the base's hash.
    #[serde(default)]
    pub assets: BTreeMap<BlobHash, Digest>,
    /// Unix milliseconds of the last successful sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    /// Files whose copy on disk still matches an earlier doc state than
    /// `frontiers`, encoded the same way: ones a pull left alone because
    /// they changed on both sides, or that changed on disk while a sync
    /// was writing. Their local edits are diffed against that state, so
    /// the remote changes they lack are not taken for local reverts.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        with = "encoded_pins"
    )]
    pub pins: BTreeMap<String, Frontiers>,
    /// Where git's HEAD was when the folder was last known to match the
    /// base, to notice a branch switch that happened while nothing ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitMark>,
}

impl Default for Base {
    fn default() -> Self {
        Self {
            version: BASE_VERSION,
            frontiers: Frontiers::default(),
            assets: BTreeMap::new(),
            last_sync: None,
            pins: BTreeMap::new(),
            git: None,
        }
    }
}

impl Base {
    /// The doc state `path` on disk corresponds to.
    pub fn state_of(&self, path: &str) -> &Frontiers {
        self.pins.get(path).unwrap_or(&self.frontiers)
    }

    pub fn touch(&mut self) {
        self.last_sync = Some(now_ms());
    }
}

fn encode_frontiers(frontiers: &Frontiers) -> String {
    if frontiers.is_empty() {
        return String::new();
    }
    URL_SAFE_NO_PAD.encode(frontiers.encode())
}

/// Empty means the empty doc.
fn decode_frontiers(encoded: &str) -> Result<Frontiers, &'static str> {
    if encoded.is_empty() {
        return Ok(Frontiers::default());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "malformed frontiers")?;
    Frontiers::decode(&bytes).map_err(|_| "malformed frontiers")
}

mod encoded_frontiers {
    use loro::Frontiers;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(frontiers: &Frontiers, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::encode_frontiers(frontiers))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Frontiers, D::Error> {
        let encoded = String::deserialize(d)?;
        super::decode_frontiers(&encoded).map_err(serde::de::Error::custom)
    }
}

mod encoded_pins {
    use std::collections::BTreeMap;

    use loro::Frontiers;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        pins: &BTreeMap<String, Frontiers>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        s.collect_map(
            pins.iter()
                .map(|(path, state)| (path, super::encode_frontiers(state))),
        )
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<BTreeMap<String, Frontiers>, D::Error> {
        BTreeMap::<String, String>::deserialize(d)?
            .into_iter()
            .map(|(path, encoded)| Ok((path, super::decode_frontiers(&encoded)?)))
            .collect::<Result<_, &str>>()
            .map_err(serde::de::Error::custom)
    }
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
        if let Some(dir) = Self::find_root(&start) {
            let state = Self::lock(dir.to_path_buf(), dir.join(STATE_DIR))?;
            // Folders linked before the file existed get it too.
            if !state.dir.join(GITIGNORE).exists() {
                state.ignore_in_git()?;
            }
            return Ok(state);
        }
        bail!(
            "{} is not inside a typstry project (no {STATE_DIR}/ found); use `typstry clone` first",
            start.display()
        )
    }

    /// The nearest folder at or above `start` that holds a project.
    pub fn find_root(start: &Path) -> Option<&Path> {
        start
            .ancestors()
            .find(|dir| dir.join(STATE_DIR).join(CONFIG).is_file())
    }

    /// The config of the project `start` is in, without taking the lock,
    /// so commands that only read it work while `sync` runs. Safe because
    /// the config is only ever replaced atomically.
    pub fn peek_config(start: &Path) -> anyhow::Result<Config> {
        let start = start
            .canonicalize()
            .with_context(|| format!("cannot open {}", start.display()))?;
        match Self::find_root(&start) {
            Some(dir) => read_config(&dir.join(STATE_DIR).join(CONFIG)),
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
        read_config(&self.dir.join(CONFIG))
    }

    pub fn save_config(&self, config: &Config) -> anyhow::Result<()> {
        write_versioned(&self.dir.join(CONFIG), config, CONFIG_VERSION)
    }

    pub fn load_base(&self) -> anyhow::Result<Base> {
        let path = self.dir.join(BASE);
        if !path.exists() {
            return Ok(Base::default());
        }
        read_versioned(&path, BASE_VERSION, BASE_MIGRATIONS)
    }

    pub fn save_base(&self, base: &Base) -> anyhow::Result<()> {
        write_versioned(&self.dir.join(BASE), base, BASE_VERSION)
    }

    /// The cached doc, or an empty one before the first sync. A log entry
    /// that a crash cut off is dropped from the file, so the next append
    /// does not land behind it. A damaged entry with more after it is an
    /// error instead, see [`log_entries`].
    pub fn load_doc(&self) -> anyhow::Result<LoroDoc> {
        self.load_doc_noting().map(|(doc, _)| doc)
    }

    /// [`Self::load_doc`], plus a warning when it had to drop the log.
    ///
    /// A log from before the preamble is folded into a fresh snapshot right
    /// away, so nothing gets appended to it. One from a newer typstry is
    /// dropped. It is only a cache over `doc.bin`, and what of it reached
    /// the server comes back on the next connect. `base.json` stays, it
    /// describes the folder.
    pub fn load_doc_noting(&self) -> anyhow::Result<(LoroDoc, Option<String>)> {
        let (doc, log) = read_doc_and_log(&self.dir)?;
        let path = self.dir.join(DOC_LOG);
        match log.format {
            LogFormat::Current if log.torn => {
                OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .and_then(|file| file.set_len(log.valid))
                    .with_context(|| format!("repairing {}", path.display()))?;
            }
            LogFormat::Current | LogFormat::Missing => {}
            LogFormat::Legacy => {
                self.save_doc(&doc)?;
            }
            LogFormat::Unknown(version) => {
                remove_if_exists(&path)?;
                return Ok((
                    doc,
                    Some(format!(
                        "dropped {} (format {version}, written by a newer typstry); changes in it that reached the server come back on the next sync",
                        path.display()
                    )),
                ));
            }
        }
        Ok((doc, None))
    }

    /// Sizes in bytes of the snapshot and of the log on top of it.
    pub fn doc_sizes(&self) -> (u64, u64) {
        let len = |name| fs::metadata(self.dir.join(name)).map_or(0, |m| m.len());
        (len(DOC), len(DOC_LOG))
    }

    /// Writes the whole doc as a fresh snapshot and drops the log, which
    /// it covers. Returns the snapshot's size.
    pub fn save_doc(&self, doc: &LoroDoc) -> anyhow::Result<u64> {
        let bytes = doc
            .export(loro::ExportMode::Snapshot)
            .context("exporting the doc")?;
        // atomic_write syncs the directory, so the new snapshot is durable
        // before the log goes. Otherwise a crash could keep the removal but
        // lose the rename, and with it ops that base.json may already
        // count as synced. A crash before the removal leaves entries the
        // snapshot already has, which import as no-ops.
        atomic_write(&self.dir.join(DOC), &bytes, true)?;
        remove_if_exists(&self.dir.join(DOC_LOG))?;
        Ok(bytes.len() as u64)
    }

    /// Appends a Loro update to the log next to the snapshot and syncs it,
    /// which costs as much as the update rather than the doc. Returns the
    /// bytes it added. A failed append is cut off again; should that fail
    /// too, the caller has to write a snapshot before appending more.
    pub fn append_doc(&self, update: &[u8]) -> anyhow::Result<u64> {
        let path = self.dir.join(DOC_LOG);
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        let before = file.metadata()?.len();
        let mut frame = log_frame(update);
        // In one write with the first entry, so a crash cannot leave a log
        // that has entries but no preamble.
        if before == 0 {
            frame.splice(0..0, log_preamble());
        }
        let result = file.write_all(&frame).and_then(|()| file.sync_data());
        if let Err(err) = result {
            let _ = file.set_len(before);
            return Err(err).with_context(|| format!("writing {}", path.display()));
        }
        // A log this append created is only durable once its directory
        // entry is.
        if before == 0 {
            sync_dir(&self.dir).with_context(|| format!("syncing {}", self.dir.display()))?;
        }
        Ok(frame.len() as u64)
    }

    /// Where the decrypted bytes of the blob with ciphertext `hash` are
    /// cached. Only a canonical `sha256:<64 lowercase hex>` gets a file:
    /// hashes come from the doc, and anything looser would let two of them
    /// share one cached plaintext, which is read back without a check.
    pub fn blob_path(&self, hash: &str) -> Option<PathBuf> {
        let hex = hash.strip_prefix("sha256:")?;
        (hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .then(|| self.dir.join(BLOBS).join(hex))
    }

    pub fn read_blob(&self, hash: &str) -> Option<Vec<u8>> {
        fs::read(self.blob_path(hash)?).ok()
    }

    pub fn write_blob(&self, hash: &str, plaintext: &[u8]) -> anyhow::Result<()> {
        let path = self
            .blob_path(hash)
            .with_context(|| format!("{hash:?} is not a blob hash"))?;
        let dir = self.dir.join(BLOBS);
        if !dir.exists() {
            create_private_dir(&dir)?;
        }
        atomic_write(&path, plaintext, true)
    }
}

/// What reading the log found.
#[derive(Debug, Default)]
struct LogRead {
    format: LogFormat,
    /// Bytes of the preamble and whole, intact entries from the start.
    valid: u64,
    /// Something follows them: an entry cut off by a crash.
    torn: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum LogFormat {
    /// No log, or an empty one.
    #[default]
    Missing,
    /// [`LOG_FORMAT`], or a preamble a crash cut off, whose entries
    /// then start at 0.
    Current,
    /// Entries without a preamble, as typstry wrote them before it had one.
    /// The entries themselves are framed the same way.
    Legacy,
    /// A preamble with another version, from a newer typstry.
    Unknown(u32),
}

/// The log starts with this and [`LOG_FORMAT`] (u32 LE), so a typstry
/// that changes how entries are framed can tell its logs from older ones.
/// A preambleless log can never start with it: its first four bytes would
/// be a length, and the next four would have to be its complement.
const LOG_MAGIC: &[u8; 8] = b"TYPSTRYL";
/// Format of `doc.log`, written into its preamble. Bump it when entries are
/// framed differently, so an older typstry drops the log instead of
/// misreading it.
pub const LOG_FORMAT: u32 = 1;
const LOG_PREAMBLE: usize = LOG_MAGIC.len() + 4;

fn log_preamble() -> [u8; LOG_PREAMBLE] {
    let mut preamble = [0; LOG_PREAMBLE];
    preamble[..LOG_MAGIC.len()].copy_from_slice(LOG_MAGIC);
    preamble[LOG_MAGIC.len()..].copy_from_slice(&LOG_FORMAT.to_le_bytes());
    preamble
}

/// The format of `log` and where its entries start.
fn log_format(log: &[u8]) -> (LogFormat, usize) {
    if log.is_empty() {
        return (LogFormat::Missing, 0);
    }
    let magic = &log[..log.len().min(LOG_MAGIC.len())];
    if magic != &LOG_MAGIC[..magic.len()] {
        return (LogFormat::Legacy, 0);
    }
    let Some(version) = log.get(LOG_MAGIC.len()..LOG_PREAMBLE) else {
        return (LogFormat::Current, 0);
    };
    match u32::from_le_bytes(version.try_into().expect("4 bytes")) {
        LOG_FORMAT => (LogFormat::Current, LOG_PREAMBLE),
        other => (LogFormat::Unknown(other), LOG_PREAMBLE),
    }
}

/// Each log entry: the update's length (u32 LE), its bitwise complement,
/// the first bytes of the update's SHA-256 and the update. The checksum
/// tells a torn entry from a whole one where a file system leaves zeros or
/// garbage after a crash. The complement catches a damaged length, which
/// would otherwise look like a body cut off by a crash. It also means the
/// search for intact entries after a damaged one rarely has to hash.
const LOG_HEADER: usize = 8 + LOG_CHECKSUM;
const LOG_CHECKSUM: usize = 8;

fn log_checksum(bytes: &[u8]) -> [u8; LOG_CHECKSUM] {
    use sha2::Digest as _;
    let hash = sha2::Sha256::digest(bytes);
    hash[..LOG_CHECKSUM].try_into().expect("long enough")
}

fn log_frame(update: &[u8]) -> Vec<u8> {
    let len = u32::try_from(update.len()).expect("updates stay far below 4 GiB");
    let mut frame = Vec::with_capacity(LOG_HEADER + update.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&(!len).to_le_bytes());
    frame.extend_from_slice(&log_checksum(update));
    frame.extend_from_slice(update);
    frame
}

/// The intact entries at the start of `log`. Only the last append can be
/// torn, since each one is synced before the next, so the first damaged
/// entry is taken for a torn one only when no intact entry follows it.
/// Otherwise cutting there would lose entries that were synced; that is
/// `Err` with its offset, for someone to look at.
fn log_entries(log: &[u8]) -> Result<(Vec<&[u8]>, LogRead), usize> {
    let mut entries = Vec::new();
    let mut at = 0;
    while at < log.len() {
        let Some(body) = log_entry_at(log, at) else {
            if (at + 1..log.len()).any(|later| log_entry_at(log, later).is_some()) {
                return Err(at);
            }
            break;
        };
        entries.push(body);
        at += LOG_HEADER + body.len();
    }
    let read = LogRead {
        format: LogFormat::Current,
        valid: at as u64,
        torn: at < log.len(),
    };
    Ok((entries, read))
}

/// The update of the intact entry starting at `at`, if there is one.
fn log_entry_at(log: &[u8], at: usize) -> Option<&[u8]> {
    let header = log.get(at..at + LOG_HEADER)?;
    let len = u32::from_le_bytes(header[..4].try_into().expect("4 bytes"));
    let check = u32::from_le_bytes(header[4..8].try_into().expect("4 bytes"));
    if len == 0 || check != !len {
        return None;
    }
    let body = log.get(at + LOG_HEADER..)?.get(..len as usize)?;
    (log_checksum(body) == header[8..]).then_some(body)
}

fn read_optional(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
    }
}

/// The doc cached in the state folder `dir`: the snapshot plus the log on
/// top of it. Only reads, so it works without the lock; see
/// [`StateDir::load_doc`].
pub fn read_doc(dir: &Path) -> anyhow::Result<LoroDoc> {
    read_doc_and_log(dir).map(|(doc, _)| doc)
}

fn read_doc_and_log(dir: &Path) -> anyhow::Result<(LoroDoc, LogRead)> {
    let doc = LoroDoc::new();
    let path = dir.join(DOC);
    if let Some(bytes) = read_optional(&path)? {
        doc.import(&bytes)
            .with_context(|| format!("{} is corrupt", path.display()))?;
    }
    let path = dir.join(DOC_LOG);
    let mut read = LogRead::default();
    if let Some(log) = read_optional(&path)? {
        let (format, start) = log_format(&log);
        match format {
            LogFormat::Unknown(_) => return Ok((doc, LogRead { format, ..read })),
            // The first append was cut off inside the preamble, before
            // any entry made it.
            LogFormat::Current if start == 0 => {
                let read = LogRead {
                    format,
                    valid: 0,
                    torn: true,
                };
                return Ok((doc, read));
            }
            _ => {}
        }
        let (entries, found) = log_entries(&log[start..]).map_err(|at| {
            anyhow::anyhow!(
                "{} is corrupt: the entry at byte {} is damaged and more follow it",
                path.display(),
                start + at
            )
        })?;
        if !entries.is_empty() {
            doc.import_batch(&entries.iter().map(|e| e.to_vec()).collect::<Vec<_>>())
                .with_context(|| format!("{} is corrupt", path.display()))?;
        }
        read = LogRead {
            format,
            valid: start as u64 + found.valid,
            torn: found.torn,
        };
    }
    Ok((doc, read))
}

fn read_config(path: &Path) -> anyhow::Result<Config> {
    read_versioned(path, CONFIG_VERSION, CONFIG_MIGRATIONS)
}

/// Reads a JSON file that carries a format `version`, migrating an older
/// one up to `current` first. A newer one is refused, since saving it
/// again would drop the fields this build does not know.
fn read_versioned<T: DeserializeOwned>(
    path: &Path,
    current: u32,
    migrations: &[Migration],
) -> anyhow::Result<T> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let malformed = || format!("{} is malformed", path.display());
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).with_context(malformed)?;
    let version = match value.get("version") {
        None => first_version(),
        Some(v) => v
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= 1)
            .with_context(|| format!("{}: version {v} is not valid", malformed()))?,
    };
    if version > current {
        bail!(
            "{} was written by a newer typstry (format {version}, this one reads up to {current}); upgrade typstry",
            path.display()
        );
    }
    for step in &migrations[version as usize - 1..] {
        step(&mut value);
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("version".to_owned(), current.into());
    }
    serde_json::from_value(value).with_context(malformed)
}

/// Writes `value` with its `version` set to `current`, whatever the struct
/// says, so a file always claims the format it is actually in.
fn write_versioned<T: Serialize>(path: &Path, value: &T, current: u32) -> anyhow::Result<()> {
    let mut value = serde_json::to_value(value)?;
    if let Some(object) = value.as_object_mut() {
        object.insert("version".to_owned(), current.into());
    }
    write_json(path, &value)
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
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

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random source unavailable");
    crate::hash::to_hex(&buf)
}

/// Removes `path`; one that is already gone is just as good.
pub(crate) fn remove_if_exists(path: &Path) -> anyhow::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => {
            Err(err).with_context(|| format!("removing {}", path.display()))
        }
        _ => Ok(()),
    }
}

/// Makes renames and removals in `dir` durable. Only unix can fsync a
/// directory; elsewhere this does nothing.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        match fs::File::open(dir).and_then(|d| d.sync_all()) {
            // Some file systems cannot sync a directory at all; there is
            // nothing more to do on those.
            Err(err) if err.kind() == io::ErrorKind::InvalidInput => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::Unsupported => Ok(()),
            result => result,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Writes through a temp file in the same directory and renames it into
/// place, so a crash or a concurrent reader never sees half a file. The
/// rename replaces a symlink at `path` instead of writing through it.
pub fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> anyhow::Result<()> {
    let dir = path.parent().context("path has no parent")?;
    let name = path.file_name().context("path has no file name")?;
    let tmp = dir.join(format!(".{}.{}.tmp", name.to_string_lossy(), random_hex(6)));
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
        fs::rename(&tmp, path)?;
        sync_dir(dir)
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
        state.save_config(&test_config()).unwrap();
        let err = StateDir::discover(dir.path()).unwrap_err();
        assert!(err.to_string().contains("another typstry command"), "{err}");
        drop(state);
        let sub = dir.path().join("a/b");
        fs::create_dir_all(&sub).unwrap();
        let found = StateDir::discover(&sub).unwrap();
        assert_eq!(found.root(), dir.path().canonicalize().unwrap());
    }

    fn test_config() -> Config {
        Config {
            version: CONFIG_VERSION,
            server: "http://x".into(),
            project_id: "p".into(),
            token: "t".into(),
            key: "k".into(),
            permission: Permission::Write,
            view_token: None,
            name: None,
            branch: None,
        }
    }

    #[test]
    fn config_and_base_without_a_version_load_as_version_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        fs::write(
            state.dir().join(CONFIG),
            r#"{"server":"http://x","projectId":"p","token":"t","key":"k","permission":"write"}"#,
        )
        .unwrap();
        fs::write(state.dir().join(BASE), r#"{"frontiers":""}"#).unwrap();
        let config = state.load_config().unwrap();
        assert_eq!(config.version, 1);
        assert_eq!(config.project_id, "p");
        assert_eq!(state.load_base().unwrap(), Base::default());

        // Saving writes the version, whatever the struct holds.
        state
            .save_config(&Config {
                version: 0,
                ..config
            })
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(state.dir().join(CONFIG)).unwrap()).unwrap();
        assert_eq!(saved["version"], CONFIG_VERSION);
        state.save_base(&Base::default()).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(state.dir().join(BASE)).unwrap()).unwrap();
        assert_eq!(saved["version"], BASE_VERSION);
    }

    #[test]
    fn newer_config_and_base_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let mut config = serde_json::to_value(test_config()).unwrap();
        config["version"] = (CONFIG_VERSION + 1).into();
        fs::write(state.dir().join(CONFIG), config.to_string()).unwrap();
        let err = state.load_config().unwrap_err();
        assert!(format!("{err:#}").contains("upgrade typstry"), "{err:#}");
        let err = StateDir::peek_config(dir.path()).unwrap_err();
        assert!(format!("{err:#}").contains("upgrade typstry"), "{err:#}");

        let base = format!(r#"{{"version":{},"frontiers":""}}"#, BASE_VERSION + 1);
        fs::write(state.dir().join(BASE), base).unwrap();
        let err = state.load_base().unwrap_err();
        assert!(format!("{err:#}").contains("upgrade typstry"), "{err:#}");

        fs::write(state.dir().join(BASE), r#"{"version":"x"}"#).unwrap();
        let err = state.load_base().unwrap_err();
        assert!(format!("{err:#}").contains("malformed"), "{err:#}");
    }

    #[test]
    fn a_log_without_preamble_is_folded_into_the_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let doc = LoroDoc::new();
        let text = doc.get_text("t");
        text.insert(0, "snapshot").unwrap();
        doc.commit();
        state.save_doc(&doc).unwrap();
        let saved = doc.oplog_vv();
        text.insert(text.len_unicode(), " logged").unwrap();
        doc.commit();
        // How typstry wrote the log before it had a preamble.
        let update = doc.export(loro::ExportMode::updates(&saved)).unwrap();
        let log = state.dir().join(DOC_LOG);
        fs::write(&log, log_frame(&update)).unwrap();

        assert_eq!(
            read_doc(state.dir()).unwrap().get_text("t").to_string(),
            "snapshot logged"
        );
        let (loaded, note) = state.load_doc_noting().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot logged");
        assert_eq!(note, None);
        assert!(!log.exists());
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot logged");
    }

    #[test]
    fn a_log_from_a_newer_typstry_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        state.save_base(&Base::default()).unwrap();
        let doc = LoroDoc::new();
        doc.get_text("t").insert(0, "snapshot").unwrap();
        doc.commit();
        state.save_doc(&doc).unwrap();
        let log = state.dir().join(DOC_LOG);
        let mut bytes = LOG_MAGIC.to_vec();
        bytes.extend_from_slice(&(LOG_FORMAT + 1).to_le_bytes());
        bytes.extend_from_slice(b"whatever comes next");
        fs::write(&log, bytes).unwrap();

        assert_eq!(
            read_doc(state.dir()).unwrap().get_text("t").to_string(),
            "snapshot"
        );
        let (loaded, note) = state.load_doc_noting().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot");
        assert!(note.unwrap().contains("newer typstry"));
        assert!(!log.exists());
        assert!(state.dir().join(BASE).exists());
    }

    #[test]
    fn a_preamble_cut_off_by_a_crash_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let log = state.dir().join(DOC_LOG);
        fs::write(&log, &log_preamble()[..5]).unwrap();
        state.load_doc().unwrap();
        assert_eq!(fs::metadata(&log).unwrap().len(), 0);

        let doc = LoroDoc::new();
        doc.get_text("t").insert(0, "after").unwrap();
        doc.commit();
        state
            .append_doc(&doc.export(loro::ExportMode::all_updates()).unwrap())
            .unwrap();
        assert!(fs::read(&log).unwrap().starts_with(LOG_MAGIC));
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "after");
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
    fn doc_log_adds_up_and_survives_a_torn_tail() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let doc = LoroDoc::new();
        let text = doc.get_text("t");
        text.insert(0, "snapshot").unwrap();
        doc.commit();
        state.save_doc(&doc).unwrap();
        let mut saved = doc.oplog_vv();
        for word in [" one", " two"] {
            text.insert(text.len_unicode(), word).unwrap();
            doc.commit();
            let update = doc.export(loro::ExportMode::updates(&saved)).unwrap();
            state.append_doc(&update).unwrap();
            saved = doc.oplog_vv();
        }
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot one two");

        // A crash halfway through the next append.
        text.insert(text.len_unicode(), " three").unwrap();
        doc.commit();
        let update = doc.export(loro::ExportMode::updates(&saved)).unwrap();
        let frame = log_frame(&update);
        let log = state.dir().join(DOC_LOG);
        let whole = fs::metadata(&log).unwrap().len();
        let mut file = OpenOptions::new().append(true).open(&log).unwrap();
        file.write_all(&frame[..frame.len() / 2]).unwrap();
        drop(file);
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot one two");
        // Cut back to the whole entries, so the next one is readable.
        assert_eq!(fs::metadata(&log).unwrap().len(), whole);
        state.append_doc(&update).unwrap();
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot one two three");

        // A snapshot covers the log and replaces it.
        state.save_doc(&doc).unwrap();
        assert!(!log.exists());
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "snapshot one two three");
    }

    /// A log of three entries on an empty snapshot, and the offset where
    /// each entry starts.
    fn three_entry_log(state: &StateDir) -> Vec<u64> {
        let doc = LoroDoc::new();
        let text = doc.get_text("t");
        let mut saved = doc.oplog_vv();
        let mut starts = Vec::new();
        for word in ["one", " two", " three"] {
            text.insert(text.len_unicode(), word).unwrap();
            doc.commit();
            let update = doc.export(loro::ExportMode::updates(&saved)).unwrap();
            starts.push(state.doc_sizes().1);
            state.append_doc(&update).unwrap();
            saved = doc.oplog_vv();
        }
        starts
    }

    fn flip_byte(path: &Path, at: u64) {
        let mut bytes = fs::read(path).unwrap();
        bytes[at as usize] ^= 0xff;
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_damaged_last_log_entry_is_cut_off() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let starts = three_entry_log(&state);
        let log = state.dir().join(DOC_LOG);
        // Garbage in the last entry's body, as a crash can leave.
        flip_byte(&log, fs::metadata(&log).unwrap().len() - 1);
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "one two");
        assert_eq!(fs::metadata(&log).unwrap().len(), starts[2]);
    }

    #[test]
    fn a_damaged_middle_log_entry_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let starts = three_entry_log(&state);
        let log = state.dir().join(DOC_LOG);
        flip_byte(&log, starts[1] + LOG_HEADER as u64);
        let before = fs::read(&log).unwrap();
        let err = state.load_doc().unwrap_err();
        assert!(format!("{err:#}").contains("corrupt"), "{err:#}");
        assert!(read_doc(state.dir()).is_err());
        // The entry after it was synced; it stays for someone to recover.
        assert_eq!(fs::read(&log).unwrap(), before);
    }

    #[test]
    fn a_damaged_middle_log_length_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let starts = three_entry_log(&state);
        let log = state.dir().join(DOC_LOG);
        // Flipping the high byte makes the length run past EOF, just like a
        // torn tail.
        flip_byte(&log, starts[1] + 3);
        let before = fs::read(&log).unwrap();
        assert!(state.load_doc().is_err());
        assert_eq!(fs::read(&log).unwrap(), before);
    }

    #[test]
    fn a_damaged_last_log_length_is_cut_off() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        let starts = three_entry_log(&state);
        let log = state.dir().join(DOC_LOG);
        flip_byte(&log, starts[2] + 3);
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "one two");
        assert_eq!(fs::metadata(&log).unwrap().len(), starts[2]);
    }

    #[test]
    fn zeros_after_the_log_count_as_a_torn_tail() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDir::create(dir.path()).unwrap();
        three_entry_log(&state);
        let whole = state.doc_sizes().1;
        let log = state.dir().join(DOC_LOG);
        let mut file = OpenOptions::new().append(true).open(&log).unwrap();
        file.write_all(&[0; 64]).unwrap();
        drop(file);
        let loaded = state.load_doc().unwrap();
        assert_eq!(loaded.get_text("t").to_string(), "one two three");
        assert_eq!(fs::metadata(&log).unwrap().len(), whole);
    }

    #[test]
    fn base_keeps_its_on_disk_format() {
        let mut base = Base::default();
        let json = serde_json::to_string(&base).unwrap();
        assert_eq!(json, r#"{"version":1,"frontiers":"","assets":{}}"#);
        assert_eq!(serde_json::from_str::<Base>("{}").unwrap(), base);

        let f: Frontiers = loro::ID::new(7, 3).into();
        base.frontiers = f.clone();
        base.pins.insert("a.typ".into(), Frontiers::default());
        base.pins.insert("b.typ".into(), f.clone());
        let encoded = URL_SAFE_NO_PAD.encode(f.encode());
        let json = serde_json::to_string(&base).unwrap();
        assert_eq!(
            json,
            format!(
                r#"{{"version":1,"frontiers":"{encoded}","assets":{{}},"pins":{{"a.typ":"","b.typ":"{encoded}"}}}}"#
            )
        );
        assert_eq!(serde_json::from_str::<Base>(&json).unwrap(), base);
        assert!(serde_json::from_str::<Base>(r#"{"frontiers":"!"}"#).is_err());
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
