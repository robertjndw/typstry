//! Creating spaces, and the person's personal space in particular: the
//! space that carries their directory of projects between their devices.
//!
//! The directory doc lives in a headless state dir (see
//! [`crate::directory`]); a `config.json` there is the binding to the
//! personal space. Everything that takes that dir's lock does it for a
//! bounded time and never across a prompt.

use std::time::Duration;

use anyhow::{Context, bail};
use typstry_wire::crypto::LinkSecret;
use typstry_wire::mls::{LocalIdentity, OwnerSecrets, PersonSpace, SpaceGroup};
use typstry_wire::pairing::GrantedSpace;

use crate::api::{Api, Permission, ShareInfo};
use crate::directory::{self, LOCK_WAIT, PASS_BUDGET, dir_of, normalize};
use crate::engine::{DocKind, Identity, SpaceCore, SyncError};
use crate::link::ShareLink;
use crate::mls::create_group;
use crate::state::{Config, StateDir};
use crate::user::{config_dir, load_or_create_identity, owner_keys, remember_owner_keys};

/// Longer than a pass: a rotation is a few round trips, and giving up
/// early leaves a revoked device with access.
const REVOKE_BUDGET: Duration = Duration::from_secs(30);

/// A space this device just created and is the only member of.
pub struct Created {
    pub link: ShareLink,
    pub share: ShareInfo,
    pub api: Api,
    pub group: SpaceGroup,
}

/// Registers a space on `server` with a fresh edit link and starts its
/// group, with the person of `local` as owner. Nothing is stored locally
/// but the owner key; the caller decides what the space is for.
pub async fn create_space(
    server: &str,
    identity: &Identity,
    local: &LocalIdentity,
) -> anyhow::Result<Created> {
    let api = Api::new(server)?;
    let created = api.create_space().await?;
    let link = ShareLink::new(
        server,
        &created.edit_token,
        &LinkSecret::generate_edit().to_base64url(),
    );
    let share = ShareInfo {
        space_id: created.space_id,
        permission: Permission::Write,
        view_token: Some(created.view_token),
        retired: false,
    };
    // The group starts with this device as its only member, before anything
    // else is uploaded, so every record has an author the group vouches for.
    let group = create_group(&link, &share.space_id, identity, local).await?;
    Ok(Created {
        link,
        share,
        api,
        group,
    })
}

/// What another device of the person needs to use the personal space.
pub struct Binding {
    pub space_id: String,
    pub token: String,
    /// The edit secret, base64url.
    pub secret: String,
    /// An encoded [`OwnerSecrets`].
    pub owner_secrets: Vec<u8>,
}

impl Binding {
    fn of(config: &Config) -> Self {
        Self {
            space_id: config.project_id.clone(),
            token: config.token.clone(),
            secret: config.key.clone(),
            owner_secrets: owner_keys(&config.server, &config.project_id)
                .encode()
                .to_vec(),
        }
    }
}

/// Makes sure the directory of `server` exists and returns its path.
fn prepared_dir(server: &str) -> anyhow::Result<std::path::PathBuf> {
    directory::with_directory(server, |_| Ok(()))?;
    Ok(dir_of(&config_dir()?, server))
}

async fn lock_dir(dir: std::path::PathBuf) -> anyhow::Result<StateDir> {
    // The wait sleeps the thread, which a runtime worker should not.
    tokio::task::spawn_blocking(move || StateDir::open_headless_waiting(&dir, LOCK_WAIT)).await?
}

/// The pointer to the personal space on `server` that a leaf in the space
/// `space_id` carries, sealed to the recovery keys. None while the
/// directory is unbound, and for the personal space itself, where it would
/// only point at its own link.
pub fn pointer_for(server: &str, space_id: &str) -> Option<PersonSpace> {
    let dir = dir_of(&config_dir().ok()?, normalize(server));
    let config = StateDir::peek_headless_config(&dir)?;
    if config.project_id == space_id {
        return None;
    }
    PersonSpace::new(&config.token, &config.key).ok()
}

/// The personal space of this person on `server`, created on first use.
/// The directory's lock makes two commands agree on one space; the whole
/// creation is held to [`PASS_BUDGET`], which is how long others wait.
pub async fn ensure_space(server: &str) -> anyhow::Result<Binding> {
    let server = normalize(server);
    let state = lock_dir(prepared_dir(server)?).await?;
    if let Some(config) = StateDir::peek_headless_config(state.dir()) {
        return Ok(Binding::of(&config));
    }
    let local = load_or_create_identity()?;
    let identity = Identity::resolve(None, None, local.graph.profile(), state.root());
    let created = tokio::time::timeout(PASS_BUDGET, create_space(server, &identity, &local))
        .await
        .context("the server took too long to create your personal space")??;
    let config = Config::new(&created.link, &created.share, None, Some(&created.group));
    state.save_config(&config)?;
    state.save_mls(&created.group)?;
    Ok(Binding::of(&config))
}

/// Binds this device's directory on `server` to the personal space another
/// device of the person handed over, and keeps its owner keys.
pub async fn join_space(server: &str, space: &GrantedSpace) -> anyhow::Result<()> {
    let server = normalize(server);
    let keys = OwnerSecrets::decode(&space.owner_secrets)
        .map_err(|err| anyhow::anyhow!("the owner keys of your personal space: {err}"))?;
    let share = Api::new(server)?.resolve_share(&space.token).await?;
    if share.retired {
        bail!("the link to your personal space was already replaced; pair again");
    }
    let link = ShareLink::new(server, &space.token, &space.secret);
    remember_owner_keys(server, &share.space_id, &keys)?;
    let state = lock_dir(prepared_dir(server)?).await?;
    let config = match StateDir::peek_headless_config(state.dir()) {
        Some(mut config) if config.project_id == share.space_id => {
            config.token = space.token.clone();
            config.key = space.secret.to_string();
            config.view_token = share.view_token.clone();
            config.permission = share.permission;
            config
        }
        other => {
            // A seat in another space (the person this device was before)
            // means nothing in this one.
            if other.is_some() {
                state.clear_group()?;
            }
            Config::new(&link, &share, None, None)
        }
    };
    state.save_config(&config)?;
    Ok(())
}

/// Brings the directory of `server` in step with its personal space:
/// catches up, pushes what was recorded locally, saves, disconnects. Held
/// to `budget` (at most [`PASS_BUDGET`]) so the lock is never kept long.
/// Nothing happens for a directory that is not bound. Problems are the
/// returned warnings, since the directory is a convenience.
pub async fn sync_pass(server: &str, budget: Duration) -> Vec<String> {
    match pass(server, budget.min(PASS_BUDGET)).await {
        Ok(warnings) => warnings,
        Err(err) => vec![format!("could not sync your project directory: {err:#}")],
    }
}

async fn pass(server: &str, budget: Duration) -> anyhow::Result<Vec<String>> {
    let dir = dir_of(&config_dir()?, server);
    if StateDir::peek_headless_config(&dir).is_none() {
        return Ok(Vec::new());
    }
    let state = lock_dir(dir).await?;
    let mut core = SpaceCore::open(state, DocKind::DIRECTORY, None, None)?;
    let mut warnings = Vec::new();
    let mut removed = false;
    match tokio::time::timeout(budget, core.connect()).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) if SyncError::fatal(&err).is_some_and(|e| matches!(e, SyncError::Removed)) => {
            removed = true;
        }
        Ok(Err(err)) => warnings.push(format!("could not sync your project directory: {err:#}")),
        Err(_) => warnings.push("syncing your project directory took too long".to_owned()),
    }
    core.disconnect().await;
    // Whatever was fetched is worth keeping, unless it turned out not to be
    // a directory at all: that must never reach the file the commands read.
    match (DocKind::DIRECTORY.ensure)(core.doc()) {
        Ok(()) => core.save_doc()?,
        Err(err) => warnings.push(format!(
            "your personal space does not hold a directory ({err}); not using it"
        )),
    }
    if removed {
        // Unbound, the next pass skips the dir instead of warning every time.
        core.state().clear_binding()?;
        warnings.push(
            "this device was removed from your personal space; your projects stay here but no \
             longer sync"
                .to_owned(),
        );
    }
    warnings.extend(core.take_warnings());
    Ok(warnings)
}

/// Secures the personal space on `server` against the devices the person
/// revoked: removes their leaves where there are any and always replaces
/// the space's links, so they read no further directory updates. Every
/// device of the person holds the space's owner key, so any of them can.
/// Returns how many revoked devices were removed: zero means the links were
/// replaced all the same, since the revoked device may know them. None when
/// the directory is not bound, which is nothing to secure. Not securing it
/// (unreached, no owner key) is an error, so the caller does not rotate
/// project links into a directory the revoked device still reads.
pub async fn drop_revoked(server: &str) -> anyhow::Result<Option<usize>> {
    let dir = dir_of(&config_dir()?, normalize(server));
    if StateDir::peek_headless_config(&dir).is_none() {
        return Ok(None);
    }
    let state = lock_dir(dir).await?;
    let mut core = SpaceCore::open(state, DocKind::DIRECTORY, None, None)?;
    let work = tokio::time::timeout(REVOKE_BUDGET, async {
        core.follow_group().await?;
        if core.identity_step()?.is_some_and(|step| step.needs_refresh) {
            bail!("your devices could not be added to the personal space; try again");
        }
        if !core.holds_owner_key() {
            bail!("this device does not hold the personal space's owner key yet");
        }
        let removed = core.remove_revoked().await?;
        if removed == 0 {
            core.reset_links().await?;
        }
        Ok(removed)
    })
    .await
    .unwrap_or_else(|_| Err(anyhow::anyhow!("the server took too long")));
    if let Err(err) = &work
        && SyncError::fatal(err).is_some_and(|e| matches!(e, SyncError::Removed))
    {
        core.state().clear_binding()?;
    }
    work.map(Some)
}

/// [`sync_pass`] for one server, printing the warnings. For a command that
/// just recorded something, so the person's other devices hear of it.
pub async fn sync_server(server: &str) {
    for warning in sync_pass(server, PASS_BUDGET).await {
        say_err!("warning: {warning}");
    }
}

/// [`sync_pass`] for every bound directory, printing the warnings.
pub async fn sync_bound() {
    let servers = match directory::bound_servers() {
        Ok(servers) => servers,
        Err(err) => {
            say_err!("warning: could not look for your personal spaces: {err:#}");
            return;
        }
    };
    // Each pass locks only its own server's dir, so they can overlap: in
    // turn, a few unreachable servers would hold up `typstry list` for a
    // whole budget each.
    let passes = servers.iter().map(|server| sync_pass(server, PASS_BUDGET));
    for warning in futures_util::future::join_all(passes)
        .await
        .into_iter()
        .flatten()
    {
        say_err!("warning: {warning}");
    }
}
