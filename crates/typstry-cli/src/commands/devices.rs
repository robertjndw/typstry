use std::io::{IsTerminal, Read};

use anyhow::{Context, bail};
use futures_util::{StreamExt, stream};
use typstry_doc::directory::State;
use typstry_wire::crypto::{LinkSecret, PublicKey};
use typstry_wire::identity::{
    AdoptError, DeviceInfo, DeviceKey, DeviceState, EntryKind, FLAG_RECOVERY, PersonGraph,
    RecoverError, RecoverOptions, RecoveryKey, device_fingerprint, person_fingerprint,
    recover as recover_graph,
};
use typstry_wire::mls::{
    OwnerSecret, OwnerSecrets, PersonSpace, graphs_in_group_info, owner_share_for_recovery,
    person_spaces_for_recovery,
};
use typstry_wire::pairing::GrantedSpace;

use super::members::publish_rotation;
use super::{Ctx, Line, MIN_PREFIX, Output, print_warnings, unique};
use crate::api::Api;
use crate::directory::{LOCK_WAIT, bound_servers, normalize, project_dir_of};
use crate::engine::{DocKind, Identity, Session, SpaceCore};
use crate::link::ShareLink;
use crate::mls::{profile_bytes, profile_identity};
use crate::space::{drop_revoked, ensure_space, join_space, sync_bound, sync_server};
use crate::state::{Config, StateDir};
use crate::user::{
    catalog, catalog_with_forgotten, config_dir, device_key_path, device_labels,
    ensure_valid_device, load_identity, load_or_create_device, merge_graph, owner_keys,
    remember_owner_keys, set_device_label, update_graph,
};

/// List the devices that are you, or revoke one.
///
/// Your devices are the ones paired with each other. Revoking a device
/// (for example a lost laptop) stops it from being you: it loses the owner
/// rights of your projects, is removed from the ones you own, and their
/// links are replaced so what it holds stops working. In projects someone
/// else owns, the revoke is passed on and their owner's devices remove it
/// the next time they open the project.
///
/// The cleanup runs in every project this device has a folder for and can
/// edit. Projects it cannot reach (no folder here, a view-only link, no
/// connection) are listed; run the command again once they can be reached.
#[derive(Debug, clap::Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct Args {
    #[command(subcommand)]
    pub action: Option<Action>,
}

#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Revoke a device and remove it from your projects. Can be repeated
    /// for a device that is already revoked, to finish the cleanup.
    Revoke {
        /// The device's name from `typstry devices`, or the start of its
        /// fingerprint.
        // Fingerprints are base64url, so one starts with '-' now and then.
        #[arg(allow_hyphen_values = true)]
        device: String,
    },
    /// Make a recovery key: 17 words that let you take your account back
    /// after losing every device.
    ///
    /// Write the words down and keep them offline. Anyone who has them can
    /// take over your account. Running this again adds another key; revoke
    /// the old one with `typstry devices revoke`.
    Recovery,
    /// Take your account back on this machine with a recovery key, when
    /// every device of yours is lost.
    ///
    /// The words are read from standard input (asked for on a terminal),
    /// never from an argument, so they stay out of your shell history. The
    /// link can be any link of a project you were a member of, and the
    /// link's key is on the command line like it is for `typstry clone`.
    /// This device becomes one of yours and every other device is revoked.
    Recover {
        /// A link of a project your account is in, including the `#key`.
        // The link holds the key, so --help must not echo it.
        #[arg(env = "TYPSTRY_LINK", hide_env_values = true)]
        link: String,
        /// Switch to the recovered account even though this machine is
        /// already a device of another one.
        #[arg(long)]
        replace: bool,
        /// Leave your other devices valid instead of revoking them.
        #[arg(long)]
        keep_devices: bool,
    },
    /// Show or change the name and color all your devices go by. Give the
    /// name with `--name`.
    Profile {
        /// The color as #rrggbb.
        #[arg(long, value_name = "COLOR")]
        color: Option<String>,
    },
}

/// What this machine calls a recovery key. The graph holds keys only.
const RECOVERY_LABEL: &str = "Recovery key";

/// Projects cleaned at the same time. Each one is a few round trips to its
/// server, so a handful in flight hides most of the latency without
/// opening a connection per project at once.
const SPREAD_CONCURRENCY: usize = 4;

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    match args.action {
        None => list(),
        Some(Action::Revoke { device }) => {
            sync_bound().await;
            revoke(ctx, &device).await
        }
        Some(Action::Recovery) => recovery(ctx).await,
        Some(Action::Recover {
            link,
            replace,
            keep_devices,
        }) => {
            // Before the words are asked for: a pass holds the directory's
            // lock for a while.
            sync_bound().await;
            recover(ctx, &link, replace, keep_devices).await
        }
        Some(Action::Profile { color }) => profile(ctx, color.as_deref()).await,
    }
}

fn list() -> anyhow::Result<()> {
    let Some(identity) = load_identity()? else {
        println!(
            "This machine is not a person yet. It becomes one when you create a project, \
             or pair it with a device of yours."
        );
        return Ok(());
    };
    let labels = device_labels()?;
    let own = identity.device.public();
    let devices = identity.graph.devices();
    println!(
        "Your devices (person {}):",
        person_fingerprint(&identity.graph.id())
    );
    let width = devices
        .iter()
        .map(|d| name_of(&labels, &d.device).chars().count())
        .max()
        .unwrap_or(0);
    for DeviceInfo {
        device: key,
        state,
        recovery,
    } in &devices
    {
        println!(
            "  {:<width$}  {}  {}{}{}",
            name_of(&labels, key),
            device_fingerprint(key),
            match state {
                DeviceState::Revoked => "revoked",
                _ => "valid",
            },
            if *recovery { "  (recovery key)" } else { "" },
            if *key == own { "  (this device)" } else { "" },
        );
    }
    Ok(())
}

/// The name this machine gave the device, else its fingerprint.
fn name_of(labels: &std::collections::BTreeMap<PublicKey, String>, key: &PublicKey) -> String {
    labels
        .get(key)
        .cloned()
        .unwrap_or_else(|| device_fingerprint(key))
}

/// The device `query` names: a local name, else a fingerprint prefix.
fn find(graph: &PersonGraph, query: &str) -> anyhow::Result<PublicKey> {
    let labels = device_labels()?;
    let query = query.trim();
    let devices = graph.devices();
    let wanted = query.to_lowercase();
    let named = devices.iter().filter(|d| {
        labels
            .get(&d.device)
            .is_some_and(|name| name.to_lowercase() == wanted)
    });
    if let Some(d) = unique(named, || {
        anyhow::anyhow!(
            "more than one device is named {query:?}; use its fingerprint from `typstry devices`"
        )
    })? {
        return Ok(d.device);
    }
    if query.len() >= MIN_PREFIX {
        let matching = devices
            .iter()
            .filter(|d| device_fingerprint(&d.device).starts_with(query));
        if let Some(d) = unique(matching, || {
            anyhow::anyhow!(
                "more than one device starts with {query:?}; type more of the fingerprint"
            )
        })? {
            return Ok(d.device);
        }
    }
    bail!("no device matches {query:?}; see `typstry devices`")
}

async fn revoke(ctx: &Ctx, query: &str) -> anyhow::Result<()> {
    let mut identity = load_identity()?
        .context("this machine is not a person yet, so there are no devices to revoke")?;
    let target = find(&identity.graph, query)?;
    if target == identity.device.public() {
        bail!("that is this device; revoke it from another one of yours");
    }
    let labels = device_labels()?;
    let name = name_of(&labels, &target);
    let mut out = Output::terminal();
    if identity.graph.device_state(&target) == DeviceState::Revoked {
        out.out(format!("{name} is already revoked; finishing the cleanup."));
    } else {
        identity
            .graph
            .append(&identity.device, EntryKind::RevokeDevice { device: target })
            .map_err(|err| anyhow::anyhow!("cannot revoke {name}: {err}"))?;
        // Saved before any project is touched, so a run that stops halfway
        // still counts the device as revoked and can be repeated.
        merge_graph(&identity.graph)?;
        out.out(format!("Revoked {name}."));
    }

    clean_everywhere(ctx, &mut out).await
}

/// Removes the revoked devices from the personal space and from every
/// project this device can reach, and says what it could not.
async fn clean_everywhere(ctx: &Ctx, out: &mut Output) -> anyhow::Result<()> {
    // First, so the revoked device stops hearing of the projects (their
    // links are in the directory) before their links are replaced.
    let servers = bound_servers()?;
    // Servers whose directory the revoked device may still read. Project
    // links replaced there would be recorded into it, handing it the new ones.
    let mut unsecured = Vec::new();
    for server in &servers {
        match drop_revoked(server).await {
            Ok(None) => {}
            Ok(Some(0)) => out.out(format!(
                "Replaced the links of your personal space on {server}."
            )),
            Ok(Some(_)) => out.out(format!(
                "Removed it from your personal space on {server} and replaced its links."
            )),
            Err(err) => {
                out.err(format!(
                    "Not reached: your personal space on {server}: {err:#}\n\
                     Until it is cleaned, the revoked device keeps reading your project \
                     directory."
                ));
                out.err(format!(
                    "Your project list on {server} could not be secured, so no project links \
                     there were replaced. Run `typstry devices revoke` again once it can be \
                     reached."
                ));
                unsecured.push(server.clone());
            }
        }
    }

    let spread = spread(ctx, out, Scope::Revoke(&unsecured)).await?;
    // The rotations recorded in the directory go out under the personal
    // space's new links.
    for server in &servers {
        sync_server(server).await;
    }
    for (title, removed) in spread.counted(|c| c.removed) {
        out.out(format!(
            "Cleaned {title}: removed {removed} device(s) and replaced the links."
        ));
    }
    for title in spread.reset() {
        out.out(format!(
            "Replaced the links of {title}: you own it, and the revoked device may know them."
        ));
    }
    for (title, left) in spread.counted(|c| c.left) {
        out.out(format!(
            "{title}: {left} revoked device(s) left for the owner to remove; they keep their \
             access there until one of the owner's devices opens the project."
        ));
    }
    if spread.counted(|c| c.removed).next().is_none()
        && spread.reset().next().is_none()
        && spread.counted(|c| c.left).next().is_none()
        && spread.unreached.is_empty()
        && unsecured.is_empty()
    {
        out.out("No project had a leaf of that device.");
    }
    spread.report_unreached(
        out,
        "Until they are cleaned, the revoked device keeps the access it had there. \
         Run `typstry devices revoke` again once they can be reached.",
    );
    Ok(())
}

/// What [`spread`] is for.
#[derive(Clone, Copy)]
enum Scope<'a> {
    /// Only the saved graph goes into the projects, e.g. a new profile.
    Graph,
    /// A revocation: the owned projects' links are replaced, including the
    /// ones without a folder here, except on these servers (the personal
    /// space there could not be secured).
    Revoke(&'a [String]),
}

/// What a pass over the projects did.
struct Spread {
    /// Projects the graph reached, with what happened to their revoked
    /// devices.
    reached: Vec<(String, Cleanup)>,
    unreached: Vec<(String, String)>,
}

/// The revoked devices of one project after [`clean_project`].
#[derive(Debug, Clone, Copy, Default)]
struct Cleanup {
    /// Removed by this device, which holds the owner key.
    removed: usize,
    /// Still there, for the owner's devices to remove: someone else owns
    /// the project.
    left: usize,
    /// The links were replaced without removing anyone: an owned project
    /// the revoked device had no leaf in but may know the links of.
    reset: bool,
}

impl Spread {
    /// The reached projects where `count` is nonzero, with that count.
    fn counted(&self, count: fn(&Cleanup) -> usize) -> impl Iterator<Item = (&String, usize)> {
        self.reached
            .iter()
            .map(move |(title, cleanup)| (title, count(cleanup)))
            .filter(|(_, n)| *n > 0)
    }

    fn reset(&self) -> impl Iterator<Item = &String> {
        self.reached
            .iter()
            .filter(|(_, cleanup)| cleanup.reset)
            .map(|(title, _)| title)
    }

    fn report_unreached(&self, out: &mut Output, consequence: &str) {
        if self.unreached.is_empty() {
            return;
        }
        out.err("Not reached:");
        for (title, why) in &self.unreached {
            out.err(format!("  {title}: {why}"));
        }
        out.err(consequence);
    }
}

/// Gets this device's graph into every project it has a folder for, so the
/// leaves carry it, and drops the leaves of revoked devices where there are
/// any. The graph has to be saved already: each project reads it from
/// there.
///
/// Projects run a few at a time. Each one's lines are held back and
/// printed whole, in catalog order, so they do not interleave.
///
/// For a revocation, a project this person owns is reset even without
/// a folder here (this device holds its owner key): it is opened headless
/// and has its links replaced. Otherwise a folder-less one is only
/// reported.
async fn spread(ctx: &Ctx, out: &mut Output, scope: Scope<'_>) -> anyhow::Result<Spread> {
    let revoking = matches!(scope, Scope::Revoke(_));
    // Projects that are gone have nothing to clean, and a folder-less
    // one is only worth a note while the person can still open it. Dropped
    // ones are only hidden, their links work, so a revocation covers them.
    let all = if revoking {
        catalog_with_forgotten()?
    } else {
        catalog()?
    };
    let projects = all.into_iter().filter(|entry| {
        let blocked = match scope {
            Scope::Revoke(servers) => ShareLink::parse(&entry.link)
                .is_ok_and(|l| servers.iter().any(|s| s == normalize(&l.origin))),
            Scope::Graph => false,
        };
        !blocked
            && (entry.dir.is_some()
                || entry.state == State::Listed
                || (revoking && entry.state == State::Forgotten))
    });
    let cleanups = projects.map(|entry| async move {
        let mut lines = Output::collect();
        let result = match &entry.dir {
            Some(dir) => clean_project(ctx, &entry.title, dir, revoking, &mut lines).await,
            None if revoking => {
                let forgotten = entry.state == State::Forgotten;
                clean_detached(
                    ctx,
                    &entry.link,
                    entry.project_id.as_deref(),
                    forgotten,
                    &mut lines,
                )
                .await
            }
            None => Err(anyhow::anyhow!(
                "no folder on this device; run the command where it is cloned, \
                 or clone it here first"
            )),
        };
        (entry.title, result, lines.into_lines())
    });
    let mut done = stream::iter(cleanups).buffered(SPREAD_CONCURRENCY);
    let mut spread = Spread {
        reached: Vec::new(),
        unreached: Vec::new(),
    };
    while let Some((title, result, lines)) = done.next().await {
        for line in lines {
            match line {
                Line::Stdout(text) => out.out(text),
                Line::Stderr(text) => out.err(text),
            }
        }
        match result {
            Ok(removed) => spread.reached.push((title, removed)),
            Err(err) => spread.unreached.push((title, format!("{err:#}"))),
        }
    }
    Ok(spread)
}

async fn recovery(ctx: &Ctx) -> anyhow::Result<()> {
    let mut identity = load_identity()?.context(
        "this machine is not a person yet; create a project or pair it first, then make a recovery key",
    )?;
    ensure_valid_device(
        &identity,
        "this device was revoked from your devices, so it cannot add a recovery key; \
         run this on a device of yours that is still valid",
    )?;
    // A key with nowhere to point would recover the project it was found in
    // and nothing else.
    for server in project_servers()? {
        ensure_space(&server).await?;
    }
    let (key, words) = RecoveryKey::generate();
    identity
        .graph
        .append(
            &identity.device,
            EntryKind::AddDevice {
                device: key.public(),
                flags: FLAG_RECOVERY,
            },
        )
        .map_err(|err| anyhow::anyhow!("cannot add the recovery key: {err}"))?;
    merge_graph(&identity.graph)?;
    set_device_label(&key.public(), RECOVERY_LABEL)?;
    // After the graph is saved, so this device's leaf in the personal spaces
    // carries the key too: that is how a recovery gets their owner keys.
    sync_bound().await;

    let mut out = Output::terminal();
    out.out("Your recovery key. It is shown once and not stored anywhere:");
    out.out("");
    out.out(format!("  {words}"));
    out.out("");
    out.out(
        "Write it down and keep it offline. Anyone who has these words can take over your \
         account, and without them a lost set of devices cannot be recovered.",
    );
    out.out(
        "Running this again adds another key; revoke an old one with `typstry devices revoke`.",
    );

    let spread = spread(ctx, &mut out, Scope::Graph).await?;
    if spread.reached.is_empty() {
        out.err(
            "No project carries the key yet, so it cannot recover anything. Run `typstry pull` \
             in a project folder to put it there.",
        );
    } else {
        out.out(format!(
            "The key is in {} project(s). Recovery works through any of them.",
            spread.reached.len()
        ));
    }
    spread.report_unreached(
        &mut out,
        "Run `typstry pull` in those folders, or this command's cleanup again, to put the key there.",
    );
    Ok(())
}

/// The servers this person has projects on.
fn project_servers() -> anyhow::Result<Vec<String>> {
    let mut servers: Vec<String> = catalog()?
        .iter()
        .filter_map(|entry| ShareLink::parse(&entry.link).ok())
        .map(|link| normalize(&link.origin).to_owned())
        .collect();
    servers.sort();
    servers.dedup();
    Ok(servers)
}

/// The words, from a terminal prompt or from standard input. Never an
/// argument: those end up in shell history.
fn read_words() -> anyhow::Result<String> {
    let mut stdin = std::io::stdin();
    let mut words = String::new();
    if stdin.is_terminal() {
        eprint!("Recovery words: ");
        std::io::Write::flush(&mut std::io::stderr())?;
        stdin.read_line(&mut words)
    } else {
        stdin.read_to_string(&mut words)
    }
    .context("reading the recovery words")?;
    if words.trim().is_empty() {
        bail!("expected the recovery words on standard input");
    }
    Ok(words)
}

async fn recover(ctx: &Ctx, link: &str, replace: bool, keep_devices: bool) -> anyhow::Result<()> {
    let link = ShareLink::parse(link.trim())?;
    let recovery = RecoveryKey::from_words(&read_words()?)
        .map_err(|err| anyhow::anyhow!("that is not a recovery key: {err}"))?;
    let secret = LinkSecret::from_base64url(&link.key).context("reading the link")?;
    let api = Api::new(&link.origin)?;
    let boot = api.mls_bootstrap(&link.token).await?;
    let graphs = graphs_in_group_info(&secret, &boot.group_info, &boot.keyring).map_err(|_| {
        anyhow::anyhow!("could not read that project's members; is the link complete and current?")
    })?;
    // Only now, while the words are at hand and before this device joins:
    // once the recovered graph is in the tree, the lost devices' leaves no
    // longer count as the owner's, and theirs hold the only shares.
    let owner = owner_share_for_recovery(&secret, boot.as_mls(), &recovery).unwrap_or_else(|err| {
        eprintln!("warning: could not read the project's owner key ({err})");
        None
    });
    // Same reason as above: the pointer and the space's owner key sit in the
    // leaves of the lost devices.
    let space = match restorable_space(&api, &secret, &boot, &recovery).await {
        Ok(space) => space,
        Err(err) => {
            eprintln!("warning: could not read your personal space from the project ({err:#})");
            None
        }
    };
    // Asked before anything is saved, so a failure here leaves nothing half
    // done.
    let owner = match owner {
        Some(owner) => Some((api.resolve_share(&link.token).await?.space_id, owner)),
        None => None,
    };
    // Read first, so a damaged graph or a missing device key is reported
    // as such rather than papered over by a new key.
    let own = match load_identity()? {
        Some(existing) => existing.device.public(),
        None => load_or_create_device()?.public(),
    };
    let opts = RecoverOptions {
        keep_others: keep_devices,
        replace,
    };
    let mut revoked = Vec::new();
    let graph = update_graph(false, |stored| {
        let recovered =
            recover_graph(&graphs, &recovery, &own, stored, opts).map_err(recover_error)?;
        if replace && let Some(stored) = stored.filter(|s| s.id() != recovered.graph.id()) {
            super::pair::guard_replace(stored, &own)?;
        }
        revoked = recovered.revoked;
        Ok(recovered.graph)
    })?;
    set_device_label(&recovery.public(), RECOVERY_LABEL)?;
    // Kept on this machine for the folder `typstry clone` makes next.
    let owner_kept = match owner {
        Some((project, owner)) => {
            keep_owner_key(&link.origin, &project, owner)?;
            true
        }
        None => false,
    };

    let restored = match space {
        Some(space) => restore_projects(&link.origin, &recovery, &space).await,
        None => None,
    };

    println!(
        "This device is now you (person {}).",
        person_fingerprint(&graph.id())
    );
    if revoked.is_empty() {
        println!("No other device was revoked.");
    } else {
        println!("Revoked {} device(s):", revoked.len());
        for device in &revoked {
            println!("  {}", device_fingerprint(device));
        }
    }
    println!("Next, run `typstry clone <link>` to get the project; you own what you owned.");
    if let Some((listed, owned)) = restored {
        println!(
            "Your personal space is back: {listed} project(s) in your list, {owned} of them \
             yours to manage. `typstry list` shows them; clone one to work on it."
        );
        if !revoked.is_empty() {
            let mut out = Output::terminal();
            clean_everywhere(ctx, &mut out).await?;
        }
        return Ok(());
    }
    if owner_kept {
        println!(
            "This device took the project's owner key along, so it can remove members and \
             reset the links there. For another project you own, run `typstry devices recover` \
             with its link before you clone it, so the key of that one comes along too."
        );
    }
    if !revoked.is_empty() {
        println!(
            "The revoked devices are removed from a project you own when this device opens \
             it, and from the others when their owner's devices do. For projects with a folder \
             here, run `typstry devices revoke <name>` to finish the cleanup right away."
        );
    }
    Ok(())
}

/// The personal space the project's leaves point to, with its owner key,
/// read while the lost devices' leaves still stand for the person. None
/// when no leaf carries a pointer for this recovery key.
async fn restorable_space(
    api: &Api,
    secret: &LinkSecret,
    boot: &crate::api::Bootstrap,
    recovery: &DeviceKey,
) -> anyhow::Result<Option<GrantedSpace>> {
    let candidates = person_spaces_for_recovery(secret, &boot.group_info, &boot.keyring, recovery)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    // Any leaf of the person can carry any pointer, including a stolen
    // device's, so each is checked: a space only counts if the recovery key
    // opens its owner key. The best-ranked one that passes is the person's.
    for pointer in &candidates {
        if let Some(space) = usable_space(api, pointer, recovery).await {
            return Ok(Some(space));
        }
    }
    eprintln!(
        "warning: none of the personal spaces the project points to could be restored with \
         this recovery key"
    );
    Ok(None)
}

/// The space `pointer` leads to, if it is a live one this recovery key
/// holds the owner key of. Anything else is skipped.
async fn usable_space(
    api: &Api,
    pointer: &PersonSpace,
    recovery: &DeviceKey,
) -> Option<GrantedSpace> {
    let space_secret = LinkSecret::from_base64url(pointer.secret()).ok()?;
    let share = api.resolve_share(pointer.token()).await.ok()?;
    if share.retired {
        return None;
    }
    let space_boot = api.mls_bootstrap(pointer.token()).await.ok()?;
    let owner = owner_share_for_recovery(&space_secret, space_boot.as_mls(), recovery)
        .ok()
        .flatten()?;
    Some(GrantedSpace {
        token: pointer.token().to_owned(),
        secret: pointer.secret().to_owned().into(),
        owner_secrets: OwnerSecrets::received(owner).encode().to_vec().into(),
    })
}

/// Binds this machine to the recovered personal space, reads the directory
/// and takes the owner key of every project in it that the person owns.
/// Best effort, each failure a warning: the project the link led to is
/// recovered either way. Returns how many projects the list holds and how
/// many of them the person owns, None if the space could not be joined.
async fn restore_projects(
    server: &str,
    recovery: &DeviceKey,
    space: &GrantedSpace,
) -> Option<(usize, usize)> {
    if let Err(err) = join_space(server, space).await {
        eprintln!("warning: could not restore your personal space: {err:#}");
        return None;
    }
    sync_server(server).await;
    let doc = match crate::directory::read(server) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("warning: could not read your project list: {err:#}");
            return None;
        }
    };
    let entries: Vec<_> = typstry_doc::directory::list(&doc, crate::directory::now())
        .into_iter()
        .filter(|entry| entry.state != State::Forgotten)
        .collect();
    let mut owned = 0;
    for entry in &entries {
        let title = entry.title.as_deref().unwrap_or("Untitled");
        match take_owner_key(server, entry, recovery).await {
            Ok(true) => owned += 1,
            Ok(false) => {}
            Err(err) => eprintln!("warning: could not take the owner key of {title}: {err:#}"),
        }
    }
    Some((entries.len(), owned))
}

/// Keeps the owner key the person's lost devices left for the recovery
/// key in one listed project. False when it is not theirs.
async fn take_owner_key(
    server: &str,
    entry: &typstry_doc::directory::Entry,
    recovery: &DeviceKey,
) -> anyhow::Result<bool> {
    let secret = LinkSecret::from_base64url(&entry.link.secret).context("reading the link")?;
    let api = Api::new(server)?;
    // The entry is only a claim: a key found behind a link that belongs to
    // another project must not be filed under this one.
    let share = api.resolve_share(&entry.link.token).await?;
    if share.space_id != entry.project_id {
        bail!("your project list files this link under another project; skipped");
    }
    let boot = api.mls_bootstrap(&entry.link.token).await?;
    let Some(owner) = owner_share_for_recovery(&secret, boot.as_mls(), recovery)? else {
        return Ok(false);
    };
    keep_owner_key(server, &entry.project_id, owner)?;
    Ok(true)
}

/// Keeps a recovered owner key on this machine and puts it in the directory
/// for the person's other devices. Only the first part has to work: the
/// directory is a convenience.
fn keep_owner_key(server: &str, project_id: &str, owner: OwnerSecret) -> anyhow::Result<()> {
    remember_owner_keys(server, project_id, &OwnerSecrets::received(owner.clone()))?;
    if let Err(err) = crate::directory::record_owner_keys(server, project_id, &owner) {
        eprintln!("warning: could not share the owner key with your devices: {err:#}");
    }
    Ok(())
}

/// What a refused recovery means for the person at the terminal.
fn recover_error(err: RecoverError) -> anyhow::Error {
    match err {
        RecoverError::UnknownKey => {
            anyhow::anyhow!("this recovery key is not one of the people in that project")
        }
        RecoverError::KeyRevoked => {
            anyhow::anyhow!("this recovery key was revoked from your devices; use a newer one")
        }
        RecoverError::OwnRevoked => {
            let path = device_key_path()
                .map_or_else(|_| "device.key".to_owned(), |p| p.display().to_string());
            anyhow::anyhow!(
                "this machine's device key was revoked from that account, so it cannot be you \
                 again; move {path} out of the way and run this again to get a new one"
            )
        }
        RecoverError::Adopt(AdoptError::ForeignIdentity { stored }) => anyhow::anyhow!(
            "this machine is already a device of another account ({}); recovery is for a \
             machine that has none. Pass --replace to switch it to the recovered account",
            person_fingerprint(&stored)
        ),
        err => anyhow::anyhow!("cannot update your devices: {err}"),
    }
}

async fn profile(ctx: &Ctx, color: Option<&str>) -> anyhow::Result<()> {
    let mut identity = load_identity()?
        .context("this machine is not a person yet; create a project or pair it first")?;
    ensure_valid_device(
        &identity,
        "this device was revoked from your devices, so it cannot change the profile",
    )?;
    let current = identity.graph.profile().map(<[u8]>::to_vec);
    let known = current.as_deref().and_then(profile_identity);
    if ctx.name.is_none() && color.is_none() {
        match &known {
            Some(Identity { name, color }) => println!("Your devices go by {name} ({color})."),
            None => println!(
                "No name or color is set for your devices yet; set them with \
                 `typstry devices profile --name <NAME> --color <#rrggbb>`."
            ),
        }
        return Ok(());
    }
    let color = color.map(valid_color).transpose()?;
    let wanted = match (ctx.name.as_deref(), &known) {
        (Some(name), Some(known)) => Identity {
            color: known.color.clone(),
            ..Identity::new(name)
        },
        (Some(name), None) => Identity::new(name),
        (None, Some(known)) => known.clone(),
        (None, None) => Identity::resolve(None, None, None, &ctx.dir),
    };
    let wanted = Identity {
        color: color.unwrap_or(wanted.color.clone()),
        ..wanted
    };
    let bytes = profile_bytes(&wanted);
    if current.as_deref() == Some(bytes.as_slice()) {
        println!(
            "Your devices already go by {} ({}).",
            wanted.name, wanted.color
        );
        return Ok(());
    }
    // Every entry stays in the graph for good, so only a real change is one.
    identity
        .graph
        .append(&identity.device, EntryKind::SetProfile { profile: bytes })
        .map_err(|err| anyhow::anyhow!("cannot change the profile: {err}"))?;
    merge_graph(&identity.graph)?;
    // After the graph is saved, so the personal spaces carry the new profile
    // as well; the projects get it from the spread below.
    sync_bound().await;

    let mut out = Output::terminal();
    out.out(format!(
        "Your devices now go by {} ({}).",
        wanted.name, wanted.color
    ));
    let spread = spread(ctx, &mut out, Scope::Graph).await?;
    spread.report_unreached(
        &mut out,
        "Other members see the new profile there once you open them (`typstry pull`).",
    );
    Ok(())
}

/// `#rrggbb`, lowercased.
fn valid_color(color: &str) -> anyhow::Result<String> {
    let color = color.trim().to_lowercase();
    let hex = color.strip_prefix('#').unwrap_or("");
    if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(color)
    } else {
        bail!("{color:?} is not a color; write it as #rrggbb")
    }
}

/// Puts the saved graph into one project and, where this device holds the
/// owner key, removes the revoked devices from it. Elsewhere the graph in
/// this device's leaf is how the owner's devices learn what to remove. With
/// `reset_links` (a revocation), an owned project gets new links even when
/// no revoked leaf is in it: the revoked device may know the old ones. An
/// error says why the project could not be reached.
async fn clean_project(
    ctx: &Ctx,
    title: &str,
    dir: &std::path::Path,
    reset_links: bool,
    out: &mut Output,
) -> anyhow::Result<Cleanup> {
    if !dir.is_dir() {
        bail!("the folder {} is gone", dir.display());
    }
    let mut session = Session::open(dir, ctx.name.as_deref())?;
    if !session.can_write() {
        bail!("this folder has a view-only link, so it cannot remove anyone");
    }
    // Following also commits the revoke into this device's leaf, which is
    // what lets the other members see which leaves it covers.
    session.follow_group().await?;
    print_warnings(out, &mut session);
    if session
        .identity_step()?
        .is_some_and(|step| step.needs_refresh)
    {
        bail!("your devices could not be added to the project's group; try again");
    }
    if !session.holds_owner_key() {
        let left = session.revoked_in_group();
        // An owned project that a revocation would reset is out of reach
        // without the key even when no revoked leaf is in it: the revoked
        // device may still know its links.
        if (left > 0 || reset_links) && session.ensure_owner().is_ok() {
            // Reported as unreached so a later run is suggested: the key
            // comes once another owner device opens the project.
            bail!(
                "this device does not have the project's owner key yet, so it cannot remove \
                 anyone or reset the links; `typstry pull` on another of your devices that can \
                 hands it over"
            );
        }
        return Ok(Cleanup {
            left,
            ..Cleanup::default()
        });
    }
    let removed = session.remove_revoked().await?;
    if removed == 0 {
        if !reset_links {
            return Ok(Cleanup::default());
        }
        session.reset_links().await?;
        out.out(format!("{title}:"));
        publish_rotation(&mut session, out).await?;
        return Ok(Cleanup {
            reset: true,
            ..Cleanup::default()
        });
    }
    out.out(format!("{title}:"));
    publish_rotation(&mut session, out).await?;
    Ok(Cleanup {
        removed,
        ..Cleanup::default()
    })
}

/// [`clean_project`] for a project this device has no folder for but owns:
/// a headless seat under the config dir joins the group with the link the
/// directory holds and replaces the links. That happens even when the
/// revoked device has no leaf in it, since the directory (or a shared
/// link) may have handed it the project's links. Someone else's project is
/// an error saying so: their owner's devices remove the leaf. A dropped
/// project that is not the person's to reset is not worth a word, they
/// chose not to see it.
///
/// `project_id` is what the directory files the link under; the server has
/// the last word, and an entry that disagrees is moved to its project.
async fn clean_detached(
    ctx: &Ctx,
    link: &str,
    project_id: Option<&str>,
    forgotten: bool,
    out: &mut Output,
) -> anyhow::Result<Cleanup> {
    const NO_KEY_HERE: &str = "no folder on this device and no owner key for it here, so its \
         owner's devices remove the revoked device when they open it";
    let link = ShareLink::parse(link)?;
    let share = Api::new(&link.origin)?.resolve_share(&link.token).await?;
    if share.retired {
        if forgotten {
            return Ok(Cleanup::default());
        }
        bail!("the link in your directory was replaced; open the project on a device that has it");
    }
    if let Some(listed) = project_id
        && listed != share.space_id
    {
        // The server has the last word on what the token opens. Keys of the
        // project the entry names are not keys of this one, so only the
        // server's id is acted on, and the entry is moved to it.
        if let Err(err) =
            crate::directory::refile_if_misfiled(&link.origin, &link.token, &share.space_id)
        {
            out.err(format!(
                "warning: could not update your project directory: {err:#}"
            ));
        }
    }
    crate::directory::import_owner_keys(&link.origin, &share.space_id);
    if owner_keys(&link.origin, &share.space_id).is_empty() {
        if forgotten {
            return Ok(Cleanup::default());
        }
        bail!(NO_KEY_HERE);
    }
    if !share.permission.can_write() {
        bail!("the link in your directory is view-only, so it cannot reset the project");
    }
    let dir = project_dir_of(&config_dir()?, &link.origin, &share.space_id);
    let state =
        tokio::task::spawn_blocking(move || StateDir::open_headless_waiting(&dir, LOCK_WAIT))
            .await??;
    // A seat from an earlier run keeps its group, so it is not another
    // device in the project each time.
    if StateDir::peek_headless_config(state.dir()).is_none_or(|c| c.project_id != share.space_id) {
        state.save_config(&Config::new(&link, &share, None, None))?;
    }
    let mut core = SpaceCore::open(state, DocKind::PROJECT, ctx.name.as_deref(), None)?;
    let result = reset_detached(&mut core).await;
    for warning in core.take_warnings() {
        out.err(format!("warning: {warning}"));
    }
    result
}

async fn reset_detached(core: &mut SpaceCore) -> anyhow::Result<Cleanup> {
    core.follow_group().await?;
    if core.identity_step()?.is_some_and(|step| step.needs_refresh) {
        bail!("your devices could not be added to the project's group; try again");
    }
    if !core.holds_owner_key() {
        bail!(
            "this device does not have the project's owner key yet, so it cannot reset its \
             links; `typstry pull` on another of your devices that has the project hands it over"
        );
    }
    let removed = core.remove_revoked().await?;
    if removed > 0 {
        return Ok(Cleanup {
            removed,
            ..Cleanup::default()
        });
    }
    core.reset_links().await?;
    Ok(Cleanup {
        reset: true,
        ..Cleanup::default()
    })
}
