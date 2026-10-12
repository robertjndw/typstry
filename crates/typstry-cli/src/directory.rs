//! The person's directory of projects, one Loro doc per server, kept in the
//! state dir of a headless space under `$config_dir/spaces/` (see
//! [`StateDir::open_headless_waiting`]). Without a `config.json` there it is
//! local only; with one it is the cache of the person's personal space,
//! which [`crate::space::sync_pass`] keeps in step with the server.
//!
//! Every function here takes the dir's lock for the length of the call. A
//! sync pass holds it for up to [`PASS_BUDGET`], so these wait [`LOCK_WAIT`].
//!
//! Recording is best effort: the directory is a convenience next to the
//! project, so callers turn its errors into warnings.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, anyhow};
use loro::LoroDoc;
use typstry_doc::directory::{self, Entry, NewLink, State};
use typstry_wire::crypto::LinkSecret;
use typstry_wire::mls::{Origin, OwnerSecret, OwnerSecrets};

use crate::engine::random_peer;
use crate::hash::to_hex;
use crate::link::ShareLink;
use crate::state::{StateDir, atomic_write, now_ms, read_doc};
use crate::user::config_dir;

const SPACES_DIR: &str = "spaces";
/// Which server a directory belongs to. The dir is named by a hash, so the
/// origin has to be kept somewhere to list every server's directory.
const ORIGIN_FILE: &str = "origin";

/// The longest a sync pass or the creation of the personal space holds the
/// directory's lock.
pub const PASS_BUDGET: Duration = Duration::from_secs(10);
/// How long recording waits for the lock: a whole pass and a little more.
pub(crate) const LOCK_WAIT: Duration = Duration::from_secs(15);

/// A project to record, see [`record_links_in`].
#[cfg(test)]
pub struct Incoming<'a> {
    pub link: &'a ShareLink,
    pub project_id: &'a str,
    pub title: Option<&'a str>,
    pub generation: Option<u32>,
}

/// One server's directory, read without taking its lock.
pub struct Snapshot {
    pub server: String,
    pub doc: LoroDoc,
}

pub(crate) fn normalize(server: &str) -> &str {
    server.trim_end_matches('/')
}

pub(crate) fn dir_of(config: &Path, server: &str) -> PathBuf {
    use sha2::Digest as _;
    let hash = sha2::Sha256::digest(normalize(server));
    config.join(SPACES_DIR).join(to_hex(&hash))
}

/// Where this device keeps its seat in a project it has no folder for, so
/// it can still reset that project's links. Named by the project id when
/// that is a safe file name, else by a hash.
pub(crate) fn project_dir_of(config: &Path, server: &str, project_id: &str) -> PathBuf {
    use sha2::Digest as _;
    let safe = !project_id.is_empty()
        && project_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let name = if safe {
        project_id.to_owned()
    } else {
        to_hex(&sha2::Sha256::digest(project_id))
    };
    dir_of(config, server).join("projects").join(name)
}

fn check(doc: &LoroDoc, dir: &Path) -> anyhow::Result<()> {
    directory::ensure_supported(doc)
        .with_context(|| format!("cannot use the project directory in {}", dir.display()))
}

/// Runs `f` on the directory of `server`, creating it if needed, and saves
/// it if `f` changed it. The lock is held for this call only: never wrap
/// anything that waits on the network.
pub fn with_directory<R>(
    server: &str,
    f: impl FnOnce(&LoroDoc) -> anyhow::Result<R>,
) -> anyhow::Result<R> {
    with_directory_in(&config_dir()?, server, f)
}

pub(crate) fn with_directory_in<R>(
    config: &Path,
    server: &str,
    f: impl FnOnce(&LoroDoc) -> anyhow::Result<R>,
) -> anyhow::Result<R> {
    let dir = dir_of(config, server);
    let state = StateDir::open_headless_waiting(&dir, LOCK_WAIT)?;
    let (doc, _) = state.load_doc()?;
    check(&doc, &dir)?;
    // A fresh peer per run, like the spaces: two runs never share one.
    doc.set_peer_id(random_peer())?;
    directory::configure(&doc);
    let before = doc.oplog_vv();
    directory::init(&doc)?;
    ensure_origin(&dir, server)?;
    let out = f(&doc)?;
    if doc.oplog_vv() != before {
        state.save_doc(&doc)?;
    }
    Ok(out)
}

pub(crate) fn ensure_origin(dir: &Path, server: &str) -> anyhow::Result<()> {
    let origin = dir.join(ORIGIN_FILE);
    if !origin.exists() {
        atomic_write(&origin, normalize(server).as_bytes(), true)?;
    }
    Ok(())
}

/// The servers whose directory is bound to a personal space.
pub fn bound_servers() -> anyhow::Result<Vec<String>> {
    let Ok(dirs) = fs::read_dir(config_dir()?.join(SPACES_DIR)) else {
        return Ok(Vec::new());
    };
    let mut servers: Vec<String> = dirs
        .filter_map(Result::ok)
        .filter_map(|d| StateDir::peek_headless_config(&d.path()))
        .map(|config| normalize(&config.server).to_owned())
        .collect();
    servers.sort();
    Ok(servers)
}

/// Every server's directory. Only reads, so it never waits for a command
/// that is writing: saves are atomic.
pub fn read_all() -> anyhow::Result<Vec<Snapshot>> {
    read_all_in(&config_dir()?)
}

pub(crate) fn read_all_in(config: &Path) -> anyhow::Result<Vec<Snapshot>> {
    let Ok(dirs) = fs::read_dir(config.join(SPACES_DIR)) else {
        return Ok(Vec::new());
    };
    let mut all = Vec::new();
    for dir in dirs.filter_map(Result::ok).map(|d| d.path()) {
        // A bound dir names its server in the config too.
        let Some(server) = fs::read_to_string(dir.join(ORIGIN_FILE))
            .ok()
            .or_else(|| StateDir::peek_headless_config(&dir).map(|c| c.server))
        else {
            continue;
        };
        let doc = read_doc(&dir)?;
        check(&doc, &dir)?;
        all.push(Snapshot { server, doc });
    }
    all.sort_by(|a, b| a.server.cmp(&b.server));
    Ok(all)
}

/// The directory of `server`, read without the lock like [`read_all`]. Empty
/// when there is none yet.
pub fn read(server: &str) -> anyhow::Result<LoroDoc> {
    read_in(&config_dir()?, server)
}

pub(crate) fn read_in(config: &Path, server: &str) -> anyhow::Result<LoroDoc> {
    let dir = dir_of(config, server);
    let doc = read_doc(&dir)?;
    check(&doc, &dir)?;
    Ok(doc)
}

/// Every entry of every server's directory, forgotten ones included.
pub fn list_all() -> anyhow::Result<Vec<(String, Entry)>> {
    Ok(read_all()?
        .into_iter()
        .flat_map(|s| {
            let server = s.server;
            directory::list(&s.doc, now())
                .into_iter()
                .map(move |entry| (server.clone(), entry))
        })
        .collect())
}

fn add(
    doc: &LoroDoc,
    link: &ShareLink,
    project_id: &str,
    title: Option<&str>,
    generation: Option<u32>,
    added_at: i64,
) -> anyhow::Result<()> {
    let secret = LinkSecret::from_base64url(&link.key).map_err(|e| anyhow!("bad link key: {e}"))?;
    directory::add_link(
        doc,
        &NewLink {
            token: &link.token,
            project_id,
            secret: &link.key,
            edit: secret.can_attest(),
            added_at,
            generation,
        },
    )?;
    if let Some(title) = title {
        directory::set_title(doc, project_id, title)?;
    }
    Ok(())
}

pub(crate) fn now() -> i64 {
    now_ms() as i64
}

/// Earlier ones get later `addedAt`s, so the directory lists them in order.
#[cfg(test)]
pub(crate) fn record_links_in(config: &Path, items: &[Incoming]) -> anyhow::Result<()> {
    let base = now();
    let mut servers: Vec<&str> = items.iter().map(|i| i.link.origin.as_str()).collect();
    servers.sort_unstable();
    servers.dedup();
    for server in servers {
        with_directory_in(config, server, |doc| {
            for (i, item) in items.iter().enumerate() {
                if item.link.origin == server {
                    let at = base - i as i64;
                    add(
                        doc,
                        item.link,
                        item.project_id,
                        item.title,
                        item.generation,
                        at,
                    )?;
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

/// Marks a project as opened by a folder here: its link and title, the
/// time, and listed again if it had been dropped or marked unavailable.
/// The server just named `project_id` for the link's token, so the link is
/// first moved there if the directory files it elsewhere (see
/// [`refile_if_misfiled`]). Returns whether it was.
pub fn record_open(
    link: &ShareLink,
    project_id: &str,
    title: Option<&str>,
    generation: Option<u32>,
) -> anyhow::Result<bool> {
    with_directory(&link.origin, |doc| {
        let refiled = refile(doc, &link.token, project_id)?;
        open(doc, link, project_id, title, generation)?;
        Ok(refiled)
    })
}

fn open(
    doc: &LoroDoc,
    link: &ShareLink,
    project_id: &str,
    title: Option<&str>,
    generation: Option<u32>,
) -> anyhow::Result<()> {
    let at = now();
    add(doc, link, project_id, title, generation, at)?;
    directory::touch_opened(doc, project_id, at)?;
    set_listed(doc, project_id, at)
}

fn set_listed(doc: &LoroDoc, project_id: &str, at: i64) -> anyhow::Result<()> {
    let state = directory::list(doc, at)
        .into_iter()
        .find(|e| e.project_id == project_id)
        .map(|e| e.state);
    if state.is_some_and(|s| s != State::Listed) {
        directory::set_status(doc, project_id, State::Listed, at, None)?;
    }
    Ok(())
}

/// A rotation: the new link, and the one it replaced is retired.
pub fn record_rotation(
    link: &ShareLink,
    project_id: &str,
    title: Option<&str>,
    generation: Option<u32>,
    old_token: &str,
) -> anyhow::Result<()> {
    with_directory(&link.origin, |doc| {
        open(doc, link, project_id, title, generation)?;
        if old_token != link.token {
            directory::retire(doc, old_token, now())?;
        }
        directory::prune_retired(doc, now())?;
        Ok(())
    })
}

pub fn record_title(server: &str, project_id: &str, title: &str) -> anyhow::Result<()> {
    with_directory(server, |doc| {
        directory::set_title(doc, project_id, title)?;
        Ok(())
    })
}

/// What `link` saw of the project: removed, gone. The link is recorded
/// first, so a folder that predates the directory still gets an entry for
/// the status to stand on.
pub fn record_status(link: &ShareLink, project_id: &str, state: State) -> anyhow::Result<()> {
    with_directory(&link.origin, |doc| {
        add(doc, link, project_id, None, None, now())?;
        directory::set_status(doc, project_id, state, now(), Some(&link.token))?;
        Ok(())
    })
}

/// Puts the project's current owner secret into that server's directory, so
/// the person's other devices can reset its links too. Idempotent. Only the
/// one the server names, never the whole held set: an old key could
/// otherwise be planted again after pruning. Never for the personal space:
/// its key travels in the grant, and the directory is that space.
pub fn record_owner_keys(
    server: &str,
    project_id: &str,
    current: &OwnerSecret,
) -> anyhow::Result<()> {
    record_owner_keys_in(&config_dir()?, server, project_id, current)
}

/// Re-files `token` under `project_id` when the directory has it under
/// another project than the one the server just named for it. The server has
/// the last word on what a token opens; the entry's secret and edit flag are
/// still the token's, so keeping the link beats retiring it. Returns whether
/// it moved anything.
pub fn refile_if_misfiled(server: &str, token: &str, project_id: &str) -> anyhow::Result<bool> {
    refile_if_misfiled_in(&config_dir()?, server, token, project_id)
}

pub(crate) fn refile_if_misfiled_in(
    config: &Path,
    server: &str,
    token: &str,
    project_id: &str,
) -> anyhow::Result<bool> {
    with_directory_in(config, server, |doc| refile(doc, token, project_id))
}

fn refile(doc: &LoroDoc, token: &str, project_id: &str) -> anyhow::Result<bool> {
    match directory::project_of_token(doc, token, now()) {
        Some(listed) if listed != project_id => Ok(directory::refile_link(doc, token, project_id)?),
        _ => Ok(false),
    }
}

fn is_personal_space(config: &Path, server: &str, project_id: &str) -> bool {
    StateDir::peek_headless_config(&dir_of(config, server))
        .is_some_and(|c| c.project_id == project_id)
}

pub(crate) fn record_owner_keys_in(
    config: &Path,
    server: &str,
    project_id: &str,
    current: &OwnerSecret,
) -> anyhow::Result<()> {
    if is_personal_space(config, server, project_id) {
        return Ok(());
    }
    // Every connect lands here, nearly always with a key that is recorded
    // already, so a lock-free read keeps it from waiting on a sync pass for
    // nothing. A doc that cannot be read takes the locked path, which says
    // why.
    if read_in(config, server).is_ok_and(|doc| directory::has_owner_key(&doc, project_id, current))
    {
        return Ok(());
    }
    with_directory_in(config, server, |doc| {
        let at = now();
        directory::add_owner_key(doc, project_id, current, at)?;
        directory::prune_owner_keys(doc, project_id, OwnerSecrets::KEEP, at)?;
        Ok(())
    })
}

/// The owner keys the directory of `server` holds for a project that this
/// device does not have yet, as received. Reads without the lock, so it
/// never waits for a sync pass.
pub fn owner_keys_missing(
    server: &str,
    project_id: &str,
    held: &OwnerSecrets,
) -> anyhow::Result<OwnerSecrets> {
    owner_keys_missing_in(&config_dir()?, server, project_id, held)
}

pub(crate) fn owner_keys_missing_in(
    config: &Path,
    server: &str,
    project_id: &str,
    held: &OwnerSecrets,
) -> anyhow::Result<OwnerSecrets> {
    if is_personal_space(config, server, project_id) {
        return Ok(OwnerSecrets::default());
    }
    Ok(
        directory::owner_keys(&read_in(config, server)?, project_id, now())
            .into_iter()
            .filter(|(_, secret)| held.find(&secret.public()).is_none())
            .map(|(_, secret)| (secret, Origin::Received))
            .collect(),
    )
}

/// Adds what the directory holds of a project's owner keys to this
/// machine's store before the project is opened, joined or cleaned, only
/// as far as there is room. Best effort: a directory that cannot be read
/// just leaves the store as it was.
pub fn import_owner_keys(server: &str, project_id: &str) {
    let held = crate::user::owner_keys(server, project_id);
    if let Ok(missing) = owner_keys_missing(server, project_id, &held) {
        let _ = crate::user::remember_owner_keys_fill(server, project_id, &missing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> String {
        LinkSecret::generate_edit().to_base64url().to_string()
    }

    fn link(origin: &str, token: &str) -> ShareLink {
        ShareLink::new(origin, token, &key())
    }

    const T1: &str = "aaaaaaaaaaaaaaaaaaaaaa";
    const T2: &str = "bbbbbbbbbbbbbbbbbbbbbb";

    fn entries(config: &Path) -> Vec<(String, Entry)> {
        read_all_in(config)
            .unwrap()
            .into_iter()
            .flat_map(|s| {
                let server = s.server;
                directory::list(&s.doc, now())
                    .into_iter()
                    .map(move |e| (server.clone(), e))
            })
            .collect()
    }

    #[test]
    fn records_round_trip_through_disk() {
        let config = tempfile::tempdir().unwrap();
        let l = link("http://one.test", T1);
        with_directory_in(config.path(), &l.origin, |doc| {
            add(doc, &l, "proj1", Some("Thesis"), Some(2), 1000)
        })
        .unwrap();
        let all = entries(config.path());
        assert_eq!(all.len(), 1);
        let (server, entry) = &all[0];
        assert_eq!(server, "http://one.test");
        assert_eq!(entry.project_id, "proj1");
        assert_eq!(entry.title.as_deref(), Some("Thesis"));
        assert_eq!(entry.link.token, T1);
        assert!(entry.link.edit);
        assert_eq!(entry.state, State::Listed);
    }

    #[test]
    fn servers_are_kept_apart_and_a_trailing_slash_is_the_same_server() {
        let config = tempfile::tempdir().unwrap();
        let a = link("http://one.test", T1);
        let b = link("http://two.test", T2);
        let a2 = ShareLink::new("http://one.test/", T2, &key());
        for (l, p) in [(&a, "p1"), (&b, "p2"), (&a2, "p1")] {
            with_directory_in(config.path(), &l.origin, |doc| {
                add(doc, l, p, None, None, 1)
            })
            .unwrap();
        }
        let all = entries(config.path());
        assert_eq!(all.len(), 2);
        assert_eq!(read_all_in(config.path()).unwrap().len(), 2);
    }

    #[test]
    fn the_lock_is_released_after_the_call() {
        let config = tempfile::tempdir().unwrap();
        with_directory_in(config.path(), "http://one.test", |_| Ok(())).unwrap();
        let dir = dir_of(config.path(), "http://one.test");
        // Would fail after the grace period if the lock were still held.
        StateDir::open_headless(&dir).unwrap();
    }

    #[test]
    fn recording_waits_for_a_pass_that_holds_the_lock() {
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        with_directory_in(config.path(), server, |_| Ok(())).unwrap();
        let dir = dir_of(config.path(), server);
        let held = StateDir::open_headless(&dir).unwrap();
        // Longer than the usual grace period, like a pass talking to a server.
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1200));
            drop(held);
        });
        with_directory_in(config.path(), server, |_| Ok(())).unwrap();
        release.join().unwrap();
    }

    #[test]
    fn a_directory_is_not_saved_when_nothing_changed() {
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        with_directory_in(config.path(), server, |_| Ok(())).unwrap();
        let doc = dir_of(config.path(), server).join("doc.bin");
        let first = fs::metadata(&doc).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        with_directory_in(config.path(), server, |_| Ok(())).unwrap();
        assert_eq!(fs::metadata(&doc).unwrap().modified().unwrap(), first);
    }

    #[test]
    fn a_doc_that_is_not_a_directory_is_refused() {
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        let dir = dir_of(config.path(), server);
        let state = StateDir::open_headless(&dir).unwrap();
        let project = LoroDoc::new();
        typstry_doc::init::init_project(&project, "T").unwrap();
        state.save_doc(&project).unwrap();
        drop(state);
        let err = with_directory_in(config.path(), server, |_| Ok(())).unwrap_err();
        assert!(format!("{err:#}").contains("not a directory"), "{err:#}");
    }

    #[test]
    fn status_and_rotation_follow_the_links() {
        let config = tempfile::tempdir().unwrap();
        let old = link("http://one.test", T1);
        let new = link("http://one.test", T2);
        with_directory_in(config.path(), &old.origin, |doc| {
            add(doc, &old, "p", None, None, 1)?;
            directory::set_status(doc, "p", State::Removed, 2, Some(T1))?;
            Ok(())
        })
        .unwrap();
        assert_eq!(entries(config.path())[0].1.state, State::Removed);
        with_directory_in(config.path(), &new.origin, |doc| {
            add(doc, &new, "p", None, Some(1), 3)?;
            directory::retire(doc, T1, 3)?;
            Ok(())
        })
        .unwrap();
        let entry = &entries(config.path())[0].1;
        assert_eq!(entry.link.token, T2);
        assert_eq!(entry.state, State::Listed);
    }

    #[test]
    fn batches_keep_their_order() {
        let config = tempfile::tempdir().unwrap();
        let ids = ["p3", "p1", "p2"];
        let tokens = [T1, T2, "cccccccccccccccccccccc"];
        let links: Vec<_> = tokens.iter().map(|t| link("http://one.test", t)).collect();
        let items: Vec<_> = links
            .iter()
            .zip(ids)
            .map(|(link, project_id)| Incoming {
                link,
                project_id,
                title: None,
                generation: None,
            })
            .collect();
        record_links_in(config.path(), &items).unwrap();
        let order: Vec<_> = entries(config.path())
            .into_iter()
            .map(|(_, e)| e.project_id)
            .collect();
        assert_eq!(order, ids);
    }

    #[test]
    fn only_the_recorded_owner_key_reaches_the_directory() {
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        let (old, current) = (OwnerSecret::generate(), OwnerSecret::generate());
        record_owner_keys_in(config.path(), server, "p1", &current).unwrap();
        // Idempotent.
        record_owner_keys_in(config.path(), server, "p1", &current).unwrap();
        let none = OwnerSecrets::default();
        let back = owner_keys_missing_in(config.path(), server, "p1", &none).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back.iter().next().unwrap().public(), current.public());
        // The stale one a device may still hold was never recorded.
        assert!(back.find(&old.public()).is_none());
        // What the device holds is not handed back, and other projects and
        // servers see nothing.
        let held = OwnerSecrets::received(current);
        let rest = owner_keys_missing_in(config.path(), server, "p1", &held).unwrap();
        assert!(rest.is_empty());
        for (s, p) in [("http://one.test", "p2"), ("http://two.test", "p1")] {
            assert!(
                owner_keys_missing_in(config.path(), s, p, &none)
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn rotations_keep_only_the_newest_owner_keys() {
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        for _ in 0..OwnerSecrets::KEEP + 2 {
            record_owner_keys_in(config.path(), server, "p1", &OwnerSecret::generate()).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let none = OwnerSecrets::default();
        let back = owner_keys_missing_in(config.path(), server, "p1", &none).unwrap();
        assert_eq!(back.len(), OwnerSecrets::KEEP);
    }

    #[test]
    fn a_token_filed_under_another_project_is_refiled() {
        let config = tempfile::tempdir().unwrap();
        let l = link("http://one.test", T1);
        with_directory_in(config.path(), &l.origin, |doc| {
            add(doc, &l, "planted", None, None, 1)
        })
        .unwrap();
        let server = &l.origin;
        // Its own project is fine, an unknown token is not its business.
        assert!(!refile_if_misfiled_in(config.path(), server, T1, "planted").unwrap());
        assert!(!refile_if_misfiled_in(config.path(), server, T2, "real").unwrap());
        assert!(refile_if_misfiled_in(config.path(), server, T1, "real").unwrap());
        let (_, entry) = &entries(config.path())[0];
        assert_eq!(entry.project_id, "real");
        assert!(!entry.link.retired);
        assert_eq!(entry.link.token, T1);
    }

    #[test]
    fn the_personal_spaces_own_key_stays_out_of_the_directory() {
        let config = tempfile::tempdir().unwrap();
        let server = "http://one.test";
        let dir = dir_of(config.path(), server);
        let l = link(server, T1);
        let share = crate::api::ShareInfo {
            space_id: "personal".into(),
            permission: crate::api::Permission::Write,
            view_token: None,
            retired: false,
        };
        let state = StateDir::open_headless(&dir).unwrap();
        state
            .save_config(&crate::state::Config::new(&l, &share, None, None))
            .unwrap();
        drop(state);
        record_owner_keys_in(config.path(), server, "personal", &OwnerSecret::generate()).unwrap();
        let none = OwnerSecrets::default();
        assert!(
            owner_keys_missing_in(config.path(), server, "personal", &none)
                .unwrap()
                .is_empty()
        );
    }
}
