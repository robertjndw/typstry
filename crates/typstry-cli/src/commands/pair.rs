use std::time::Duration;

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::Message;
use typstry_wire::crypto::PublicKey;
use typstry_wire::identity::{DeviceState, PersonGraph, device_fingerprint, person_fingerprint};
use typstry_wire::mls::LocalIdentity;
use typstry_wire::pairing::{
    Code, Event, Grant, GrantedProject, PairError, Pairing, Role, fit_device_name,
};
use typstry_wire::relay::{CHANNEL_TTL_SECS, close_reason};

use super::Ctx;
use super::init::confirm;
use crate::api::Api;
use crate::client::{PING_INTERVAL, Socket, open_socket};
use crate::link::{ShareLink, relay_url};
use crate::state::StateDir;
use crate::user::{
    AvailableProject, load_identity, load_or_create_device, merge_graph, projects,
    remember_available, save_paired_graph, set_device_label,
};

/// Pair this device with another one of yours.
///
/// Pairing makes two devices the same person in every project they share,
/// and hands the new device the list of your projects. Each device keeps
/// its own key; the existing one vouches for the new one in your device
/// graph (see `typstry devices`). Run it without arguments on the device
/// that is already you: it prints a short code. Then enter the code on the
/// new device, either here (`typstry pair <CODE>`) or in the browser at the
/// printed link.
///
/// A code allows one attempt and expires after five minutes.
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
    /// switches to the other person; its own graph is discarded.
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
    if args.replace
        && let Some(identity) = &identity
    {
        guard_replace(&identity.graph, &identity.device.public())?;
    }
    // A revoked device cannot vouch for anyone, but it may join a person
    // again as a new device, the way `adopt` lets it leave the old one.
    if args.replace
        || identity
            .as_ref()
            .is_some_and(|i| i.graph.device_state(&i.device.public()) != DeviceState::Valid)
    {
        identity = None;
    }
    let device_name = device_name(ctx.name.as_deref());

    let meeting = match args.code.as_deref() {
        None => {
            let origin = server_for(ctx, args.server.as_deref(), None)?;
            let channel = Api::new(&origin)?.allocate_relay().await?;
            let code = Code::generate(channel.channel).context("the server sent a bad channel")?;
            println!("Pairing code: {code}");
            println!("Or open:      {origin}/pair#{code}");
            println!("On the other device run: typstry pair {code}");
            println!(
                "Waiting for it (the code expires in {} min)...",
                channel.expires_in.div_ceil(60)
            );
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
            identity.as_mut(),
            &device_name,
            &args,
        ),
    )
    .await;
    let _ = ws.close(None).await;
    match outcome {
        Ok(Ok(Outcome::Approved)) => Ok(()),
        Ok(Ok(Outcome::Granted(grant))) => joined(grant, args.replace),
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
    mut identity: Option<&mut LocalIdentity>,
    device_name: &str,
    args: &Args,
) -> anyhow::Result<Outcome> {
    let (mut pairing, first) = match &identity {
        Some(_) => Pairing::start_holder(code),
        None => {
            let device = load_or_create_device()?;
            Pairing::start_new(code, device_name, &device.public()).map_err(explain)?
        }
    };
    send(ws, first).await?;

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        let frame = tokio::select! {
            frame = ws.next() => frame,
            _ = ping.tick() => {
                send_ping(ws).await?;
                continue;
            }
        };
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
                if identity.is_none() {
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
                let approved = args.yes || ask(ws, &new_name, &tag, &mut ping).await?;
                if !approved {
                    send(ws, pairing.reject().map_err(explain)?).await?;
                    bail!("Declined. {new_name} was not added.");
                }
                let graph = add_device(identity, &device_pub, &new_name)?;
                let grant = granted_projects(Grant::new(device_name.to_owned(), graph.encode()));
                let shared = grant.projects.len();
                send(ws, pairing.approve(&grant).map_err(explain)?).await?;
                println!(
                    "Paired. {new_name} ({tag}) is now one of your devices and received {shared} project(s)."
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
    let mut answer = tokio::task::spawn_blocking(move || confirm(&question));
    loop {
        tokio::select! {
            answer = &mut answer => return answer?,
            _ = ping.tick() => send_ping(ws).await?,
        }
    }
}

/// What the new device does with a grant.
fn joined(grant: Grant, replace: bool) -> anyhow::Result<()> {
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
    if grant.projects.is_empty() {
        println!("The other device has no projects to hand over.");
        return Ok(());
    }
    let handed: Vec<AvailableProject> = grant.projects.into_iter().map(Into::into).collect();
    remember_available(&handed)?;
    println!(
        "Received {} project(s). See them with `typstry list`, copy one with `typstry clone <number>`.",
        handed.len()
    );
    Ok(())
}

/// Refuses `--replace` when it would leave a project without a way to
/// manage it: this device is the only valid device of the person that owns
/// a project it has a folder for. A recovery key counts as a device here,
/// since it can still bring the person back.
pub(super) fn guard_replace(graph: &PersonGraph, own: &PublicKey) -> anyhow::Result<()> {
    let person = graph.id();
    if graph.valid_devices() != [*own] {
        return Ok(());
    }
    let owned: Vec<String> = projects()?
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
        .map(|known| {
            known
                .title
                .clone()
                .unwrap_or_else(|| known.dir.display().to_string())
        })
        .collect();
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

/// `grant` with what the holder shares: the folders it still has.
fn granted_projects(mut grant: Grant) -> Grant {
    for known in projects().unwrap_or_default() {
        if !known.dir.is_dir() {
            continue;
        }
        let title = known.display_title();
        if let Some(project) = GrantedProject::new(&title, known.link)
            && !grant.push(project)
        {
            break;
        }
    }
    grant
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
