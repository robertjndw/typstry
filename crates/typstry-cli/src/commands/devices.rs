use std::io::{IsTerminal, Read};

use anyhow::{Context, bail};
use futures_util::{StreamExt, stream};
use typstry_wire::crypto::{LinkSecret, PublicKey};
use typstry_wire::identity::{
    AdoptError, DeviceInfo, DeviceState, EntryKind, FLAG_RECOVERY, PersonGraph, RecoverError,
    RecoverOptions, RecoveryKey, device_fingerprint, person_fingerprint, recover as recover_graph,
};
use typstry_wire::mls::{OwnerSecrets, graphs_in_group_info, owner_share_for_recovery};

use super::members::publish_rotation;
use super::{Ctx, Line, MIN_PREFIX, Output, print_warnings, unique};
use crate::api::Api;
use crate::engine::{Identity, Session};
use crate::link::ShareLink;
use crate::mls::{profile_bytes, profile_identity};
use crate::user::{
    catalog, device_key_path, device_labels, ensure_valid_device, load_identity,
    load_or_create_device, merge_graph, remember_owner_keys, set_device_label, update_graph,
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
        Some(Action::Revoke { device }) => revoke(ctx, &device).await,
        Some(Action::Recovery) => recovery(ctx).await,
        Some(Action::Recover {
            link,
            replace,
            keep_devices,
        }) => recover(&link, replace, keep_devices).await,
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

    let spread = spread(ctx, &mut out).await?;
    for (title, removed) in spread.counted(|c| c.removed) {
        out.out(format!(
            "Cleaned {title}: removed {removed} device(s) and replaced the links."
        ));
    }
    for (title, left) in spread.counted(|c| c.left) {
        out.out(format!(
            "{title}: {left} revoked device(s) left for the owner to remove; they keep their \
             access there until one of the owner's devices opens the project."
        ));
    }
    if spread.counted(|c| c.removed).next().is_none()
        && spread.counted(|c| c.left).next().is_none()
        && spread.unreached.is_empty()
    {
        out.out("No project had a leaf of that device.");
    }
    spread.report_unreached(
        &mut out,
        "Until they are cleaned, the revoked device keeps the access it had there. \
         Run `typstry devices revoke` again once they can be reached.",
    );
    Ok(())
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
}

impl Spread {
    /// The reached projects where `count` is nonzero, with that count.
    fn counted(&self, count: fn(&Cleanup) -> usize) -> impl Iterator<Item = (&String, usize)> {
        self.reached
            .iter()
            .map(move |(title, cleanup)| (title, count(cleanup)))
            .filter(|(_, n)| *n > 0)
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
async fn spread(ctx: &Ctx, out: &mut Output) -> anyhow::Result<Spread> {
    let cleanups = catalog()?.into_iter().map(|entry| async move {
        let mut lines = Output::collect();
        let result = match &entry.dir {
            Some(dir) => clean_project(ctx, &entry.title, dir, &mut lines).await,
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

    let spread = spread(ctx, &mut out).await?;
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

async fn recover(link: &str, replace: bool, keep_devices: bool) -> anyhow::Result<()> {
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
    // Asked before anything is saved, so a failure here leaves nothing half
    // done.
    let owner = match owner {
        Some(owner) => Some((api.resolve_share(&link.token).await?.project_id, owner)),
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
            remember_owner_keys(&link.origin, &project, &OwnerSecrets::received(owner))?;
            true
        }
        None => false,
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

    let mut out = Output::terminal();
    out.out(format!(
        "Your devices now go by {} ({}).",
        wanted.name, wanted.color
    ));
    let spread = spread(ctx, &mut out).await?;
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
/// this device's leaf is how the owner's devices learn what to remove. An
/// error says why the project could not be reached.
async fn clean_project(
    ctx: &Ctx,
    title: &str,
    dir: &std::path::Path,
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
        if left > 0 && session.ensure_owner().is_ok() {
            // Reported as unreached so a later run is suggested: the key
            // comes once another owner device opens the project.
            bail!(
                "this device does not have the project's owner key yet, so it cannot remove \
                 anyone; `typstry pull` on another of your devices that can hands it over"
            );
        }
        return Ok(Cleanup { removed: 0, left });
    }
    let removed = session.remove_revoked().await?;
    if removed == 0 {
        return Ok(Cleanup::default());
    }
    out.out(format!("{title}:"));
    publish_rotation(&mut session, out).await?;
    Ok(Cleanup { removed, left: 0 })
}
