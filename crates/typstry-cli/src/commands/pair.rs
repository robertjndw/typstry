use std::io::IsTerminal;
use std::time::Duration;

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::Message;
use typstry_doc::directory::State;
use typstry_wire::crypto::PublicKey;
use typstry_wire::identity::{
    DeviceState, PersonGraph, PersonId, device_fingerprint, person_fingerprint,
};
use typstry_wire::mls::LocalIdentity;
use typstry_wire::pairing::{
    Code, Event, Grant, GrantedSpace, PairError, Pairing, Role, fit_device_name,
};
use typstry_wire::relay::{CHANNEL_TTL_SECS, close_reason};

use super::init::confirm;
use super::list::print_catalog;
use super::{Ctx, clone};
use crate::api::Api;
use crate::client::{PING_INTERVAL, Socket, open_socket};
use crate::directory::list_all;
use crate::link::{ShareLink, relay_url};
use crate::space::{ensure_space, join_space, sync_server};
use crate::state::StateDir;
use crate::tui::countdown::Countdown;
use crate::user::{
    KnownProject, catalog, load_identity, load_or_create_device, merge_graph, owner_keys, projects,
    save_paired_graph, set_device_label,
};

/// Pair this device with another one of yours.
///
/// Pairing makes two devices the same person in every project they share.
/// The new device gets your projects, and keeps getting the ones you add
/// later, through your personal space on the server. Each device keeps
/// its own key; the existing one vouches for the new one in your device
/// graph (see `typstry devices`). Run it without arguments on the device
/// that is already you: it prints a short code. Then enter the code on the
/// new device, either here (`typstry pair <CODE>`) or in the browser at the
/// printed link.
///
/// A code allows one attempt and expires after a few minutes (the server
/// decides how long; the device showing it counts down).
#[derive(Debug, clap::Args)]
pub struct Args {
    /// The code or link shown by the other device. Without it, this device
    /// shows a code of its own.
    pub code: Option<String>,
    /// The typstry server to pair through; defaults to the one of the
    /// project in this folder, else of your most recent project. A link
    /// carries its own.
    #[arg(long, value_name = "URL", env = "TYPSTRY_SERVER")]
    pub server: Option<String>,
    /// Join as a new device even though this one is already a person. It
    /// switches to the other person; its own graph is discarded, its project
    /// list is merged into the other person's, and the folders here join
    /// their projects again as the other person on their next sync.
    /// Entering a code on a machine that only became a person by cloning
    /// asks about this by itself.
    #[arg(long)]
    pub replace: bool,
    /// Approve the other device without asking.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

/// Where the pairing goes once a server is known.
struct Meeting {
    origin: String,
    code: Code,
    /// Set for the side that allocated the channel.
    claim: Option<String>,
    expires_in: u64,
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let mut identity = load_identity()?;
    let mut replace = args.replace;
    if let Some(identity) = &identity {
        let own = identity.device.public();
        if replace {
            guard_replace(&identity.graph, &own)?;
        } else if is_disposable(&identity.graph, &own)? {
            // Asked before connecting: the role decides the first frame.
            if args.code.is_some() {
                replace = offer_switch(args.yes)?;
            } else {
                eprintln!(
                    "Note: this machine has no other devices yet. If you already use typstry on \
                     the other device, show the code there instead and enter it here."
                );
            }
        }
    }
    let old_person = identity.as_ref().map(|identity| identity.graph.id());
    // A revoked device cannot vouch for anyone, but it may join a person
    // again as a new device, the way `adopt` lets it leave the old one.
    if replace
        || identity
            .as_ref()
            .is_some_and(|i| i.graph.device_state(&i.device.public()) != DeviceState::Valid)
    {
        identity = None;
    }
    let device_name = device_name(ctx.name.as_deref());

    let mut countdown = None;
    let meeting = match args.code.as_deref() {
        None => {
            let origin = server_for(ctx, args.server.as_deref(), None)?;
            let channel = Api::new(&origin)?.allocate_relay().await?;
            let code = Code::generate(channel.channel).context("the server sent a bad channel")?;
            println!("Pairing code: {code}");
            println!("Or open:      {origin}/pair#{code}");
            println!("On the other device run: typstry pair {code}");
            if crate::term::interactive() {
                // The countdown line takes the place of the static one.
                countdown = Some(Countdown::new(Duration::from_secs(channel.expires_in)));
            } else {
                println!(
                    "Waiting for it (the code expires in {} min)...",
                    channel.expires_in.div_ceil(60)
                );
            }
            Meeting {
                origin,
                code,
                claim: Some(channel.claim),
                expires_in: channel.expires_in,
            }
        }
        Some(input) => {
            let code = Code::from_link_or_code(input)
                .map_err(|err| anyhow::anyhow!("that is not a pairing code: {err}"))?;
            let origin = server_for(ctx, args.server.as_deref(), Some(input))?;
            Meeting {
                origin,
                code,
                claim: None,
                expires_in: CHANNEL_TTL_SECS,
            }
        }
    };

    let deadline = Duration::from_secs(meeting.expires_in);
    let url = relay_url(
        &meeting.origin,
        meeting.code.channel(),
        meeting.claim.as_deref(),
    )?;
    let mut ws = open_socket(&url, &meeting.origin).await?;
    let outcome = tokio::time::timeout(
        deadline,
        pair(
            &mut ws,
            &meeting.code,
            &meeting.origin,
            identity.as_mut(),
            &device_name,
            args.yes,
            countdown,
        ),
    )
    .await;
    let _ = ws.close(None).await;
    match outcome {
        Ok(Ok(Outcome::Approved)) => Ok(()),
        Ok(Ok(Outcome::Granted(grant))) => {
            joined(ctx, grant, &meeting.origin, replace, old_person).await
        }
        Ok(Err(err)) => Err(err),
        Err(_) => {
            bail!("The code expired before the pairing finished. Start over with a new code.")
        }
    }
}

enum Outcome {
    /// Holder: the other device was added.
    Approved,
    /// New: this device was added by the other one.
    Granted(Grant),
}

async fn pair(
    ws: &mut Socket,
    code: &Code,
    origin: &str,
    mut identity: Option<&mut LocalIdentity>,
    device_name: &str,
    yes: bool,
    mut countdown: Option<Countdown>,
) -> anyhow::Result<Outcome> {
    // The new side's key, which the holder shows before it approves.
    let mut own_key = None;
    let (mut pairing, first) = match &identity {
        Some(_) => Pairing::start_holder(code),
        None => {
            let device = load_or_create_device()?;
            own_key = Some(device.public());
            Pairing::start_new(code, device_name, &device.public()).map_err(explain)?
        }
    };
    send(ws, first).await?;

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut second = tokio::time::interval(Duration::from_secs(1));
    second.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let frame = tokio::select! {
            frame = ws.next() => frame,
            _ = second.tick(), if countdown.is_some() => {
                if let Some(countdown) = &countdown {
                    countdown.draw();
                }
                continue;
            }
            _ = ping.tick() => {
                send_ping(ws).await?;
                continue;
            }
        };
        // A frame from the other device (or the socket ending) ends the
        // wait, and the line has to be gone before this loop prints or asks
        // anything. Text frames are the server's answers to our keep-alive
        // pings and are skipped below like the other control frames.
        if !matches!(
            frame,
            Some(Ok(Message::Text(_) | Message::Ping(_) | Message::Pong(_)))
        ) {
            countdown = None;
        }
        let bytes = match frame {
            Some(Ok(Message::Binary(bytes))) => bytes,
            Some(Ok(Message::Close(frame))) => {
                return Err(closed(frame.map(|f| f.reason.to_string())));
            }
            Some(Ok(_)) => continue,
            Some(Err(err)) => return Err(left(&err.to_string())),
            None => return Err(closed(None)),
        };
        let step = pairing
            .handle(&bytes)
            .map_err(|err| explain_as(err, pairing.role()))?;
        if let Some(frame) = step.send {
            send(ws, frame).await?;
        }
        match step.event {
            Some(Event::Verified) => {
                eprintln!("The code matched.");
                if let Some(key) = &own_key {
                    // A code someone overheard matches just as well; the key
                    // says which device actually used it.
                    eprintln!(
                        "This device's key: {}. Approve on the other device only if it shows the same.",
                        device_fingerprint(key)
                    );
                    eprintln!(
                        "Approve this device on the existing device to finish (it asks you there)..."
                    );
                }
            }
            Some(Event::AwaitApproval {
                device_name: new_name,
                device_pub,
            }) => {
                let identity = identity
                    .as_deref_mut()
                    .context("approval asked of a device that is not a person yet")?;
                let tag = device_fingerprint(&device_pub);
                let approved = if yes {
                    true
                } else {
                    match ask(ws, &new_name, &tag, &mut ping).await {
                        Ok(approved) => approved,
                        Err(err) => {
                            // Otherwise the other device only sees the
                            // connection drop and cannot tell why.
                            if let Ok(frame) = pairing.reject() {
                                let _ = send(ws, frame).await;
                            }
                            return Err(err);
                        }
                    }
                };
                if !approved {
                    send(ws, pairing.reject().map_err(explain)?).await?;
                    bail!("Declined. {new_name} was not added.");
                }
                // Before the device is added, so a failure leaves nothing behind.
                let space = personal_space(origin).await?;
                let graph = add_device(identity, &device_pub, &new_name)?;
                let grant = Grant::new(device_name.to_owned(), graph.encode(), space);
                send(ws, pairing.approve(&grant).map_err(explain)?).await?;
                println!(
                    "Paired. {new_name} ({tag}) is now one of your devices and gets your projects, \
                     including the ones you add later."
                );
                return Ok(Outcome::Approved);
            }
            Some(Event::Granted(grant)) => return Ok(Outcome::Granted(grant)),
            Some(Event::Rejected) => bail!("The other device declined the pairing."),
            None => {}
        }
    }
}

async fn send(ws: &mut Socket, frame: Vec<u8>) -> anyhow::Result<()> {
    ws.send(Message::Binary(frame.into()))
        .await
        .map_err(|err| left(&err.to_string()))
}

/// The server drops sockets that stay silent for 90 s, which a person
/// deciding whether to approve can easily exceed.
async fn send_ping(ws: &mut Socket) -> anyhow::Result<()> {
    ws.send(Message::Text("ping".into()))
        .await
        .map_err(|err| left(&err.to_string()))
}

/// Vouches for `device` in the person graph and saves the result, so a
/// pairing that fails after this still leaves the device listed (it can be
/// revoked like any other). Returns the graph to hand over.
fn add_device(
    identity: &mut LocalIdentity,
    device: &PublicKey,
    name: &str,
) -> anyhow::Result<PersonGraph> {
    identity
        .graph
        .vouch(&identity.device, device)
        .map_err(|err| anyhow::anyhow!("cannot add the device: {err}"))?;
    let merged = merge_graph(&identity.graph)?;
    set_device_label(device, name)?;
    Ok(merged)
}

/// Asks on the terminal while the socket stays alive.
async fn ask(
    ws: &mut Socket,
    device_name: &str,
    tag: &str,
    ping: &mut tokio::time::Interval,
) -> anyhow::Result<bool> {
    let question = format!("{device_name} (key {tag}) wants to join as you. Approve?");
    let mut answer = tokio::task::spawn_blocking(move || {
        confirm(
            &question,
            "cannot ask whether to approve the device without a terminal; \
             run `typstry pair --yes` to approve whoever enters the code",
        )
    });
    loop {
        tokio::select! {
            answer = &mut answer => return answer?,
            _ = ping.tick() => send_ping(ws).await?,
        }
    }
}

/// What the new device does with a grant. `old_person` is the person this
/// machine was before, if any.
async fn joined(
    ctx: &Ctx,
    grant: Grant,
    origin: &str,
    replace: bool,
    old_person: Option<PersonId>,
) -> anyhow::Result<()> {
    let graph = PersonGraph::decode(&grant.graph)
        .map_err(|err| anyhow::anyhow!("the received device graph is unusable: {err}"))?;
    let device = load_or_create_device()?;
    // `save_paired_graph` only checks this for another person's graph; a
    // grant has to list this device whoever it comes from.
    if graph.device_state(&device.public()) != DeviceState::Valid {
        bail!("The other device did not list this one among your devices. Start over.");
    }
    save_paired_graph(&graph, &device.public(), replace)?;
    // Names stay on the devices, so the holder's is what this one learns
    // its device by.
    if let Some(holder) = graph.added_by(&device.public())
        && !grant.holder_name.is_empty()
    {
        set_device_label(&holder, &grant.holder_name)?;
    }
    println!(
        "Paired. This device is now you ({}).",
        person_fingerprint(&graph.id())
    );
    if old_person.is_some_and(|old| old != graph.id()) {
        // The pairing is saved by now, so failing to list the folders must
        // not fail the command.
        let moving = local_folders().unwrap_or_default();
        if !moving.is_empty() {
            println!(
                "These folders joined their projects as your old person and switch to you on \
                 their next sync: {}",
                moving.join(", ")
            );
        }
    }
    // The directory is what carries the projects, so they arrive with the
    // first pass.
    join_space(origin, &grant.space).await.context(
        "paired, but this device could not join your personal space, so your projects will not sync",
    )?;
    sync_server(origin).await;
    let entries = catalog()?;
    if entries.is_empty() {
        println!("The other device has no projects yet.");
    } else if crate::term::interactive()
        && entries
            .iter()
            .any(|entry| entry.dir.is_none() && entry.state == State::Listed)
    {
        println!("Pick a project to clone now, or press q to do it later with `typstry list`.");
        // Without a link, clone shows the picker itself.
        Box::pin(clone::run(ctx, clone::Args::default())).await?;
    } else {
        println!("Your projects (copy one with `typstry clone <number>`):");
        print_catalog(false)?;
    }
    Ok(())
}

/// The personal space to hand the new device, created if this person has
/// none yet and brought up to date first, so the new device finds the
/// directory on the server. Pairing runs through the server, so a failure
/// here is a real problem and fails the approval.
async fn personal_space(origin: &str) -> anyhow::Result<GrantedSpace> {
    let binding = ensure_space(origin).await.context(
        "could not set up your personal space, which carries your projects to the new device",
    )?;
    sync_server(origin).await;
    GrantedSpace::new(binding.token, binding.secret, binding.owner_secrets)
        .map_err(|err| anyhow::anyhow!("could not hand over your personal space: {err}"))
}

/// Refuses `--replace` when it would leave a project without a way to
/// manage it: this device is the only valid device of the person that owns
/// a project it has a folder for. A recovery key counts as a device here,
/// since it can still bring the person back.
pub(super) fn guard_replace(graph: &PersonGraph, own: &PublicKey) -> anyhow::Result<()> {
    if graph.valid_devices() != [*own] {
        return Ok(());
    }
    let owned = owned_folders(graph)?;
    if owned.is_empty() {
        return Ok(());
    }
    bail!(
        "This device is the only one of your person that is valid, and you own {}. Switching to \
         another person would leave {} without an owner. Pair a second device or create a \
         recovery key (`typstry devices recovery`) first.",
        owned.join(", "),
        if owned.len() == 1 { "it" } else { "them" },
    )
}

/// The folders on this machine whose project `graph`'s person owns.
fn owned_folders(graph: &PersonGraph) -> anyhow::Result<Vec<String>> {
    let person = graph.id();
    Ok(projects()?
        .iter()
        .filter(|known| {
            // A damaged pin may well be this person's, and wrongly allowing
            // the replace would orphan the project.
            StateDir::peek_config(&known.dir).is_ok_and(|config| {
                config
                    .pinned_owner()
                    .map_or(true, |owner| owner == Some(person))
            })
        })
        .map(KnownProject::display_title)
        .collect())
}

/// The folders this machine still has, by title.
fn local_folders() -> anyhow::Result<Vec<String>> {
    Ok(catalog()?
        .into_iter()
        .filter(|entry| entry.dir.is_some())
        .map(|entry| entry.title)
        .collect())
}

/// Whether this machine's person is one it most likely became by
/// accident, by cloning before pairing: this device is the only one the
/// graph ever had, and it owns no project, in a folder here or in its
/// directory. Leaving such a person for another one loses nothing, and its
/// directory merges into the other person's.
fn is_disposable(graph: &PersonGraph, own: &PublicKey) -> anyhow::Result<bool> {
    Ok(graph.only_ever_had(own) && owned_folders(graph)?.is_empty() && !owns_listed()?)
}

/// Whether this machine holds the owner key of a project its directory lists.
fn owns_listed() -> anyhow::Result<bool> {
    Ok(list_all()?.iter().any(|(server, entry)| {
        entry.state != State::Forgotten && !owner_keys(server, &entry.project_id).is_empty()
    }))
}

/// Asks whether a machine that [`is_disposable`] should join the person of
/// the device showing the code. Usually it should, but a machine that has
/// only cloned so far may also be the first one, about to add a device.
/// So without a terminal, or with `--yes` (which approves the other side,
/// not a switch), it stays the holder, and `--replace` switches without
/// asking.
fn offer_switch(yes: bool) -> anyhow::Result<bool> {
    if yes || !std::io::stdin().is_terminal() {
        return Ok(false);
    }
    let folders = local_folders()?;
    let opened = if folders.is_empty() {
        String::new()
    } else {
        format!(" when it opened {}", folders.join(", "))
    };
    eprintln!("This machine became a person of its own{opened}, and has no other devices yet.");
    confirm(
        "Does the device showing the code already belong to you, so this machine should join \
         it? Its folders switch over on their next sync. (No: add that device to this machine.)",
        "unreachable: only asked on a terminal",
    )
}

/// The server to pair through: `--server`, the origin of a link, the
/// project in this folder, the most recently used project.
fn server_for(ctx: &Ctx, flag: Option<&str>, input: Option<&str>) -> anyhow::Result<String> {
    let flag = flag.map(str::trim).filter(|s| !s.is_empty());
    let from_input = input
        .and_then(|i| i.split_once('#'))
        .and_then(|(base, _)| base.strip_suffix("/pair"))
        .filter(|base| base.starts_with("http://") || base.starts_with("https://"));
    let origin = flag
        .or(from_input)
        .map(str::to_owned)
        .or_else(|| StateDir::peek_config(&ctx.dir).ok().map(|c| c.server))
        .or_else(|| {
            projects()
                .ok()?
                .iter()
                .rev()
                .find_map(|p| ShareLink::parse(&p.link).ok().map(|l| l.origin))
        });
    match origin {
        Some(origin) => {
            let origin = origin.trim_end_matches('/').to_owned();
            crate::link::ws_url(&origin).context("the server must be an http(s) URL")?;
            Ok(origin)
        }
        None => bail!(
            "no server to pair through; pass --server https://your-typstry-host, or paste the \
             link the other device shows"
        ),
    }
}

/// The name the holder sees: `--name`, else the machine's.
fn device_name(given: Option<&str>) -> String {
    given
        .and_then(fit_device_name)
        .or_else(|| {
            let out = std::process::Command::new("hostname").output().ok()?;
            fit_device_name(&String::from_utf8(out.stdout).ok()?)
        })
        .unwrap_or_else(|| "typstry CLI".to_owned())
}

fn explain(err: PairError) -> anyhow::Error {
    explain_as(err, Role::Holder)
}

fn explain_as(err: PairError, role: Role) -> anyhow::Error {
    match err {
        PairError::WrongCode => {
            anyhow::anyhow!("The code did not match. Start over with a new code.")
        }
        PairError::RoleConflict if role == Role::Holder => anyhow::anyhow!(
            "Both devices are already a person. To make this one join the other, \
             run `typstry pair <code> --replace` here; its own devices are left behind."
        ),
        PairError::RoleConflict => anyhow::anyhow!(
            "Neither device is a person yet. Pair from the device that has a project or has paired before."
        ),
        other => anyhow::anyhow!("The pairing failed: {other}. Start over with a new code."),
    }
}

fn closed(reason: Option<String>) -> anyhow::Error {
    match reason.as_deref() {
        Some(close_reason::NO_CHANNEL | close_reason::EXPIRED) => anyhow::anyhow!(
            "No pairing is open for this code: it expired, was already used, or is wrong. \
             Start over with a new code."
        ),
        Some(close_reason::RATE_LIMITED | close_reason::TOO_MANY_FRAMES) => {
            anyhow::anyhow!("The server stopped the pairing. Start over with a new code.")
        }
        Some(close_reason::PEER_LEFT) | None => {
            anyhow::anyhow!(
                "The other device left before the pairing finished. Start over with a new code."
            )
        }
        Some(other) => left(other),
    }
}

fn left(reason: &str) -> anyhow::Error {
    anyhow::anyhow!("The connection to the server ended ({reason}). Start over with a new code.")
}
