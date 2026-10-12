//! State that belongs to the user rather than to one project folder: this
//! device's key, the graph of the devices that make up the person, local
//! names for those devices, the list of projects they have a folder for
//! (what pairing hands to a new device), and the owner keys of the
//! projects those folders own.
//!
//! It lives in `$TYPSTRY_CONFIG_DIR`, else the platform's config directory.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use loro::LoroDoc;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use typstry_wire::crypto::PublicKey;
use typstry_wire::identity::{AdoptError, DeviceKey, DeviceState, PersonGraph, adopt};
use typstry_wire::mls::{LocalIdentity, OwnerSecrets};

use crate::link::ShareLink;
use crate::state::{
    atomic_write, create_private_dir, fill_owner_keys, merge_owner_keys, read_owner_keys,
};
use typstry_doc::directory::{self as doc_dir, Entry, State};

const DEVICE_FILE: &str = "device.key";
const GRAPH_FILE: &str = "person.graph";
const IDENTITY_LOCK: &str = "identity.lock";
const DEVICES_FILE: &str = "devices.json";
const DEVICES_VERSION: u32 = 1;
const PROJECTS_FILE: &str = "projects.json";
const PROJECTS_VERSION: u32 = 1;
/// Guards the project list. Never held while taking another lock, so it
/// cannot take part in a deadlock with `identity.lock`.
const PROJECTS_LOCK: &str = "projects.lock";
/// The owner keys of the projects this machine's folders own, one file per
/// project (see [`owner_key`]).
const OWNER_KEYS_DIR: &str = "owner-keys";
/// Never held while taking another lock, like `projects.lock`.
const OWNER_KEYS_LOCK: &str = "owner-keys.lock";

/// A project this user has a folder for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownProject {
    pub dir: PathBuf,
    pub link: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl KnownProject {
    /// The title, else the folder's name.
    pub fn display_title(&self) -> String {
        self.title.clone().unwrap_or_else(|| {
            self.dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled".to_owned())
        })
    }
}

/// The shape of the user's JSON files: a format `version` next to the
/// content.
#[derive(Serialize, Deserialize)]
struct Versioned<T> {
    version: u32,
    #[serde(flatten)]
    content: T,
}

/// `projects.json`.
#[derive(Serialize, Deserialize)]
struct ProjectList<T> {
    projects: Vec<T>,
}

/// One row of `typstry list`: a project this person has, with the folder
/// on this device if there is one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub title: String,
    pub link: String,
    pub dir: Option<PathBuf>,
    /// The project the directory files the link under, for ones only the
    /// directory knows. Whoever acts on the entry checks it against what
    /// the server says the link is for.
    pub project_id: Option<String>,
    /// Removed and gone projects stay listed so the person can see why
    /// they cannot open them.
    pub state: State,
}

static OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// Uses `dir` for the rest of the process instead of the environment.
/// In-process tests need this: they share one environment, and changing it
/// at runtime is not sound. The first call wins.
pub fn override_config_dir(dir: PathBuf) {
    let _ = OVERRIDE.set(dir);
}

/// The directory for user-level state, created (private) if missing.
pub fn config_dir() -> anyhow::Result<PathBuf> {
    let from_env = || std::env::var_os("TYPSTRY_CONFIG_DIR").filter(|v| !v.is_empty());
    let dir = match OVERRIDE
        .get()
        .cloned()
        .or_else(|| from_env().map(PathBuf::from))
    {
        Some(dir) => dir,
        None => dirs::config_dir()
            .context("cannot find a config directory; set TYPSTRY_CONFIG_DIR")?
            .join("typstry"),
    };
    if !dir.is_dir() {
        if let Some(parent) = dir.parent().filter(|p| !p.exists()) {
            fs::create_dir_all(parent)
                .with_context(|| format!("cannot create {}", parent.display()))?;
        }
        create_private_dir(&dir)?;
    }
    Ok(dir)
}

/// The saved device key, or None if this machine has none yet. A file that
/// cannot be read is an error: replacing it would make this machine a new
/// device, one the person's graph does not list.
pub fn load_device() -> anyhow::Result<Option<DeviceKey>> {
    read_device(&device_key_path()?)
}

/// Where this machine's device key is kept.
pub fn device_key_path() -> anyhow::Result<PathBuf> {
    Ok(config_dir()?.join(DEVICE_FILE))
}

/// The file's bytes, or None if there is no such file.
fn read_optional(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
    }
}

fn read_device(path: &Path) -> anyhow::Result<Option<DeviceKey>> {
    let Some(bytes) = read_optional(path)? else {
        return Ok(None);
    };
    match DeviceKey::import(&bytes) {
        Ok(key) => Ok(Some(key)),
        Err(err) => bail!(
            "{} is damaged ({err}); restore it from a backup or pair this device again, \
             it is not replaced automatically because that would make this a different device",
            path.display()
        ),
    }
}

/// The device key, created on first use.
pub fn load_or_create_device() -> anyhow::Result<DeviceKey> {
    let path = device_key_path()?;
    if let Some(key) = read_device(&path)? {
        return Ok(key);
    }
    let key = DeviceKey::generate();
    // Linked into place rather than renamed, so of two first runs at the
    // same moment only one key wins and both end up using it.
    let tmp = path.with_extension(format!("new.{}", crate::state::random_hex(6)));
    atomic_write(&tmp, &key.export(), true)?;
    let linked = fs::hard_link(&tmp, &path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(key),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            read_device(&path)?.context("device.key disappeared while it was being created")
        }
        Err(err) => Err(err).with_context(|| format!("writing {}", path.display())),
    }
}

/// The person graph on file. Like the device key, a file that cannot be
/// read is an error: starting a new graph would split this user into a
/// second person.
fn read_graph(path: &Path) -> anyhow::Result<Option<PersonGraph>> {
    let Some(bytes) = read_optional(path)? else {
        return Ok(None);
    };
    match PersonGraph::decode(&bytes) {
        Ok(graph) => Ok(Some(graph)),
        Err(err) => bail!(
            "{} is damaged ({err}); restore it from a backup or pair this device again, \
             it is not replaced automatically because that would make you a different person",
            path.display()
        ),
    }
}

/// Serializes the read-modify-write cycles of the files that identity
/// state lives in, across processes. Held until dropped.
fn lock_identity() -> anyhow::Result<fs::File> {
    lock_in(&config_dir()?, IDENTITY_LOCK)
}

fn lock_in(dir: &Path, name: &str) -> anyhow::Result<fs::File> {
    let path = dir.join(name);
    let guard = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    guard.lock().context("waiting for another typstry run")?;
    Ok(guard)
}

/// This machine's identity: the device key and the person graph listing
/// it. None while the machine has no graph, i.e. it is not a person yet.
pub fn load_identity() -> anyhow::Result<Option<LocalIdentity>> {
    let dir = config_dir()?;
    let Some(graph) = read_graph(&dir.join(GRAPH_FILE))? else {
        return Ok(None);
    };
    let device = read_device(&dir.join(DEVICE_FILE))?.with_context(|| {
        format!(
            "{} exists but device.key is missing; restore device.key from a backup",
            dir.join(GRAPH_FILE).display()
        )
    })?;
    Ok(Some(LocalIdentity { device, graph }))
}

/// Fails with `revoked` when the graph no longer lists this device as
/// valid. A revoked device keeps its key and graph on file, so having an
/// identity is not enough to act for the person.
pub fn ensure_valid_device(identity: &LocalIdentity, revoked: &str) -> anyhow::Result<()> {
    if identity.graph.device_state(&identity.device.public()) != DeviceState::Valid {
        bail!("{revoked}");
    }
    Ok(())
}

/// [`load_identity`], starting a new person with this device as its first
/// device if there is none yet. Done lazily, so a machine that only ever
/// pairs into another person never makes one.
pub fn load_or_create_identity() -> anyhow::Result<LocalIdentity> {
    let device = load_or_create_device()?;
    let _lock = lock_identity()?;
    let path = config_dir()?.join(GRAPH_FILE);
    let graph = match read_graph(&path)? {
        Some(graph) => graph,
        None => {
            let graph = PersonGraph::genesis(&device);
            atomic_write(&path, &graph.encode(), true)?;
            graph
        }
    };
    Ok(LocalIdentity { device, graph })
}

/// Folds `other` into the saved graph and returns the result. Only ever
/// adds entries, so a stale copy cannot undo a revoke. A graph of another
/// person is an error.
pub fn merge_graph(other: &PersonGraph) -> anyhow::Result<PersonGraph> {
    let _lock = lock_identity()?;
    let path = config_dir()?.join(GRAPH_FILE);
    let mut graph = read_graph(&path)?
        .context("this machine has no person graph; pair it or create a project first")?;
    let before = graph.len();
    graph
        .merge(other)
        .map_err(|err| anyhow::anyhow!("cannot merge the person graph: {err}"))?;
    if graph.len() > before {
        atomic_write(&path, &graph.encode(), true)?;
    }
    Ok(graph)
}

/// Saves what `update` makes of the stored graph (None if there is none)
/// and returns it. The read and the write happen under the identity lock,
/// so an entry another run saved in between is not lost. With `past_damage`
/// a damaged file reads as none, which is the way out of it.
pub fn update_graph(
    past_damage: bool,
    update: impl FnOnce(Option<&PersonGraph>) -> anyhow::Result<PersonGraph>,
) -> anyhow::Result<PersonGraph> {
    let _lock = lock_identity()?;
    let path = config_dir()?.join(GRAPH_FILE);
    let stored = match read_graph(&path) {
        Ok(stored) => stored,
        Err(_) if past_damage => None,
        Err(err) => return Err(err),
    };
    let graph = update(stored.as_ref())?;
    if stored.as_ref() != Some(&graph) {
        atomic_write(&path, &graph.encode(), true)?;
    }
    Ok(graph)
}

/// Stores the graph a pairing handed over to `own`, this device, by
/// [`adopt`]'s rules: the same person merges in, another one replaces the
/// saved graph with `replace` or once this device was revoked there.
pub fn save_paired_graph(
    graph: &PersonGraph,
    own: &PublicKey,
    replace: bool,
) -> anyhow::Result<PersonGraph> {
    update_graph(replace, |stored| {
        adopt(stored, graph, own, replace).map_err(|err| match err {
            AdoptError::ForeignIdentity { .. } => anyhow::anyhow!(
                "this machine already belongs to another person; pass --replace to switch to the other one"
            ),
            AdoptError::NotListed => anyhow::anyhow!(
                "The other device did not list this one among your devices. Start over."
            ),
            AdoptError::Graph(err) => anyhow::anyhow!("cannot merge the person graph: {err}"),
        })
    })
}

/// How the user's devices are named on this machine. The names come from
/// pairing and never leave it: the graph holds keys only.
#[derive(Serialize, Deserialize)]
struct DeviceLabels {
    /// By base64url device key.
    labels: BTreeMap<String, String>,
}

/// The content of a versioned JSON file, or None if it is missing, damaged
/// or of another version. Only for files that are a convenience and
/// rebuild as they are used.
fn read_versioned<T: DeserializeOwned>(path: &Path, version: u32) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    let file = serde_json::from_slice::<Versioned<T>>(&bytes).ok()?;
    (file.version == version).then_some(file.content)
}

/// Writes `content` as a versioned JSON file, private since the user's
/// files hold secrets.
fn write_versioned<T: Serialize>(path: &Path, version: u32, content: T) -> anyhow::Result<()> {
    let file = Versioned { version, content };
    atomic_write(path, &serde_json::to_vec_pretty(&file)?, true)
}

/// The names this machine knows devices by.
pub fn device_labels() -> anyhow::Result<BTreeMap<PublicKey, String>> {
    Ok(read_labels(&config_dir()?.join(DEVICES_FILE)))
}

fn read_labels(path: &Path) -> BTreeMap<PublicKey, String> {
    read_versioned::<DeviceLabels>(path, DEVICES_VERSION)
        .map(|file| {
            file.labels
                .into_iter()
                .filter_map(|(key, name)| {
                    let key = URL_SAFE_NO_PAD.decode(key).ok()?;
                    Some((PublicKey::try_from(key.as_slice()).ok()?, name))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Names `device` on this machine.
pub fn set_device_label(device: &PublicKey, name: &str) -> anyhow::Result<()> {
    let _lock = lock_identity()?;
    let path = config_dir()?.join(DEVICES_FILE);
    let mut labels = read_labels(&path);
    labels.insert(*device, name.to_owned());
    let labels = labels
        .into_iter()
        .map(|(key, name)| (URL_SAFE_NO_PAD.encode(key), name))
        .collect();
    write_versioned(&path, DEVICES_VERSION, DeviceLabels { labels })
}

/// The remembered projects. A damaged list reads as empty: it is only a
/// convenience that rebuilds as projects are used.
pub fn projects() -> anyhow::Result<Vec<KnownProject>> {
    Ok(read_projects(&config_dir()?.join(PROJECTS_FILE)))
}

fn read_projects(path: &Path) -> Vec<KnownProject> {
    read_versioned::<ProjectList<KnownProject>>(path, PROJECTS_VERSION)
        .map(|file| file.projects)
        .unwrap_or_default()
}

/// Records that `dir` holds the project at `link`, replacing an earlier
/// entry for the same folder. Without a `title` the earlier one is kept.
pub fn remember_project(dir: &Path, link: &ShareLink, title: Option<&str>) -> anyhow::Result<()> {
    remember_project_in(&config_dir()?, dir, link, title)
}

fn remember_project_in(
    config: &Path,
    dir: &Path,
    link: &ShareLink,
    title: Option<&str>,
) -> anyhow::Result<()> {
    let _lock = lock_in(config, PROJECTS_LOCK)?;
    let path = config.join(PROJECTS_FILE);
    let mut projects = read_projects(&path);
    let link = link.to_string();
    match projects.iter_mut().find(|p| p.dir == dir) {
        Some(known) => {
            known.link = link;
            if let Some(title) = title {
                known.title = Some(title.to_owned());
            }
        }
        None => projects.push(KnownProject {
            dir: dir.to_owned(),
            link,
            title: title.map(str::to_owned),
        }),
    }
    // The links are secrets, so the file is as private as the keys.
    write_versioned(&path, PROJECTS_VERSION, ProjectList { projects })
}

/// Every project this person has: those with a folder here first, then
/// the ones only the directory knows, e.g. from another device. Projects
/// the person dropped are left out unless a folder here has them.
pub fn catalog() -> anyhow::Result<Vec<CatalogEntry>> {
    catalog_with(false)
}

/// [`catalog`], with the projects the person dropped from their list too:
/// dropping only hides a project, its links stay valid, so a cleanup that
/// replaces links has to reach it as well.
pub fn catalog_with_forgotten() -> anyhow::Result<Vec<CatalogEntry>> {
    catalog_with(true)
}

fn catalog_with(forgotten: bool) -> anyhow::Result<Vec<CatalogEntry>> {
    catalog_in(&config_dir()?, forgotten)
}

fn catalog_in(config: &Path, forgotten: bool) -> anyhow::Result<Vec<CatalogEntry>> {
    let snapshots = crate::directory::read_all_in(config)?;
    let mut docs: HashMap<&str, &LoroDoc> = HashMap::new();
    for s in &snapshots {
        docs.entry(s.server.as_str()).or_insert(&s.doc);
    }
    // Taken out as folders claim them, so what is left keeps the
    // directory's order for the folder-less part of the catalog.
    let mut listed: Vec<Option<(&str, Entry)>> = snapshots
        .iter()
        .flat_map(|s| {
            doc_dir::list(&s.doc, crate::directory::now())
                .into_iter()
                .map(|e| Some((s.server.as_str(), e)))
        })
        .collect();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    for (i, item) in listed.iter().enumerate() {
        if let Some((server, entry)) = item {
            index
                .entry(((*server).to_owned(), entry.project_id.clone()))
                .or_insert(i);
        }
    }
    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for known in read_projects(&config.join(PROJECTS_FILE)) {
        if !known.dir.is_dir() {
            continue;
        }
        // The folder may hold an older link than the directory's best, so
        // it is matched through the token rather than the entry's link.
        let parsed = ShareLink::parse(&known.link).ok();
        let project = parsed.as_ref().and_then(|link| {
            let doc = docs.get(link.origin.as_str())?;
            let id = doc_dir::project_of_token(doc, &link.token, crate::directory::now())?;
            Some((link.origin.clone(), id))
        });
        let key = project
            .clone()
            .or_else(|| parsed.map(|l| (l.origin, l.token)))
            .unwrap_or_else(|| (String::new(), known.link.clone()));
        if !seen.insert(key) {
            continue;
        }
        let entry = project
            .and_then(|key| listed[*index.get(&key)?].take())
            .map(|(_, e)| e);
        let title = entry
            .as_ref()
            .and_then(|e| e.title.clone())
            .or_else(|| known.title.clone())
            .unwrap_or_else(|| known.display_title());
        entries.push(CatalogEntry {
            title,
            link: known.link,
            dir: Some(known.dir),
            project_id: None,
            state: entry.map_or(State::Listed, |e| e.state),
        });
    }
    for (server, entry) in listed.into_iter().flatten() {
        if (entry.state == State::Forgotten && !forgotten)
            || seen.contains(&(server.to_owned(), entry.project_id.clone()))
        {
            continue;
        }
        let link = ShareLink::new(server, &entry.link.token, &entry.link.secret);
        entries.push(CatalogEntry {
            title: entry.title.unwrap_or_else(|| "Untitled".to_owned()),
            link: link.to_string(),
            dir: None,
            project_id: Some(entry.project_id),
            state: entry.state,
        });
    }
    Ok(entries)
}

/// Where this machine keeps the owner key of the project `project_id` at
/// `server`. Named by a hash because neither part is guaranteed to be a
/// safe file name.
fn owner_key_path(config: &Path, server: &str, project_id: &str) -> PathBuf {
    use sha2::Digest as _;
    let name = sha2::Sha256::digest(format!("{server}\n{project_id}"));
    config
        .join(OWNER_KEYS_DIR)
        .join(format!("{}.bin", crate::hash::to_hex(&name)))
}

/// The owner keys this machine's folders held for the project
/// `project_id` at `server`, or one a recovery took along, newest first. A
/// folder that joins with them can rotate right away instead of waiting for
/// another owner device to hand the key over. Unreadable reads as empty:
/// the group hands the key over again.
pub fn owner_keys(server: &str, project_id: &str) -> OwnerSecrets {
    let Ok(config) = config_dir() else {
        return OwnerSecrets::default();
    };
    read_owner_keys(&owner_key_path(&config, server, project_id))
}

/// Adds `keys` to what the machine keeps of the project's owner keys.
/// Nothing there is replaced: a folder that has not caught up yet may bring
/// older keys, and the newer ones must survive that.
pub fn remember_owner_keys(
    server: &str,
    project_id: &str,
    keys: &OwnerSecrets,
) -> anyhow::Result<()> {
    store_owner_keys(server, project_id, keys, merge_owner_keys)
}

/// Like [`remember_owner_keys`], but `keys` only fill room behind what the
/// machine already keeps. For keys that came from the directory, which a
/// planted entry must not be able to use to push a real key out.
pub fn remember_owner_keys_fill(
    server: &str,
    project_id: &str,
    keys: &OwnerSecrets,
) -> anyhow::Result<()> {
    store_owner_keys(server, project_id, keys, fill_owner_keys)
}

fn store_owner_keys(
    server: &str,
    project_id: &str,
    keys: &OwnerSecrets,
    write: fn(&Path, &OwnerSecrets) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    if keys.is_empty() {
        return Ok(());
    }
    let config = config_dir()?;
    let _lock = lock_in(&config, OWNER_KEYS_LOCK)?;
    let dir = config.join(OWNER_KEYS_DIR);
    if !dir.is_dir() {
        create_private_dir(&dir)?;
    }
    write(&owner_key_path(&config, server, project_id), keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use typstry_wire::identity::EntryKind;

    #[test]
    fn dropped_projects_are_listed_only_when_asked_for() {
        use typstry_doc::directory::{self as doc_dir, NewLink};
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        let secret = typstry_wire::crypto::LinkSecret::generate_edit().to_base64url();
        crate::directory::with_directory_in(config.path(), server, |doc| {
            for (token, id) in [
                ("aaaaaaaaaaaaaaaaaaaaaa", "kept"),
                ("bbbbbbbbbbbbbbbbbbbbbb", "dropped"),
            ] {
                doc_dir::add_link(
                    doc,
                    &NewLink {
                        token,
                        project_id: id,
                        secret: &secret,
                        edit: true,
                        added_at: crate::directory::now(),
                        generation: None,
                    },
                )?;
            }
            doc_dir::set_status(
                doc,
                "dropped",
                State::Forgotten,
                crate::directory::now(),
                None,
            )?;
            Ok(())
        })
        .unwrap();
        let shown = catalog_in(config.path(), false).unwrap();
        assert_eq!(shown.len(), 1);
        let all = catalog_in(config.path(), true).unwrap();
        assert_eq!(all.len(), 2);
        let dropped = all.iter().find(|e| e.state == State::Forgotten).unwrap();
        assert_eq!(dropped.project_id.as_deref(), Some("dropped"));
    }

    #[test]
    fn concurrent_remembers_keep_every_entry() {
        let config = tempfile::tempdir().unwrap();
        let link = ShareLink::new("http://localhost:1", "token", "key");
        std::thread::scope(|scope| {
            for i in 0..8 {
                let (config, link) = (config.path(), &link);
                scope.spawn(move || {
                    let dir = PathBuf::from(format!("/tmp/project-{i}"));
                    remember_project_in(config, &dir, link, None).unwrap();
                });
            }
        });
        let known = read_projects(&config.path().join(PROJECTS_FILE));
        assert_eq!(known.len(), 8);
    }

    #[test]
    fn damaged_device_key_is_an_error_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DEVICE_FILE);
        fs::write(&path, b"short").unwrap();
        assert!(read_device(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"short");
    }

    #[test]
    fn damaged_graph_is_an_error_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(GRAPH_FILE);
        fs::write(&path, b"nope").unwrap();
        assert!(read_graph(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"nope");
    }

    #[test]
    fn missing_files_are_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            read_device(&dir.path().join(DEVICE_FILE))
                .unwrap()
                .is_none()
        );
        assert!(read_graph(&dir.path().join(GRAPH_FILE)).unwrap().is_none());
    }

    #[test]
    fn labels_round_trip_and_damage_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DEVICES_FILE);
        assert!(read_labels(&path).is_empty());
        fs::write(&path, b"{").unwrap();
        assert!(read_labels(&path).is_empty());
    }

    #[test]
    fn graph_merge_is_monotonic() {
        let a = DeviceKey::generate();
        let b = DeviceKey::generate();
        let mut ahead = PersonGraph::genesis(&a);
        let behind = ahead.clone();
        ahead
            .append(
                &a,
                EntryKind::AddDevice {
                    device: b.public(),
                    flags: 0,
                },
            )
            .unwrap();
        let mut merged = ahead.clone();
        merged.merge(&behind).unwrap();
        assert_eq!(merged, ahead);
    }
}
