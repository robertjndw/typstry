use anyhow::{Context, bail};
use typstry_wire::identity::{PersonId, person_fingerprint};
use typstry_wire::mls::{MemberInfo, Person, Role};

use ratatui::style::Stylize;
use ratatui::text::Line;

use super::init::confirmed;
use super::link::write_links;
use super::{Ctx, MIN_PREFIX, Output, connected, print_warnings, unique};
use crate::engine::Session;
use crate::mls::profile_name;
use crate::term;
use crate::tui::chooser::{Item, Key, choose};

/// List the people with access to the project, or remove one.
///
/// Every device that joined with a link is a member, listed by the name it
/// gave and grouped under the person it belongs to. The owner's person is
/// marked "owner", and devices their person has revoked "revoked". In a
/// terminal the list is interactive: `d` removes the selected device or
/// person.
/// Removing a member replaces the project's links (the new ones are
/// printed), so what the removed device holds stops working; the members
/// who stay are switched over automatically the next time they sync.
#[derive(Debug, clap::Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct Args {
    #[command(subcommand)]
    pub action: Option<Action>,
    /// List the members as of the last sync instead of catching up first.
    #[arg(long)]
    pub offline: bool,
}

#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Remove a member and replace the links. The project owner only. In a
    /// terminal it asks first.
    Remove {
        /// A device's number from `typstry members` or its name, or a
        /// person's fingerprint (the start is enough) to remove all of
        /// their devices.
        // Fingerprints are base64url, so one starts with '-' now and then.
        #[arg(allow_hyphen_values = true)]
        member: String,
        /// Do not ask for confirmation. In a terminal the owner is asked
        /// before anything is removed.
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

pub async fn run(ctx: &Ctx, args: Args) -> anyhow::Result<()> {
    let mut session = ctx.open()?;
    let mut out = Output::terminal();
    match args.action {
        None => {
            if !args.offline {
                session.follow_group().await?;
                print_warnings(&mut out, &mut session);
            }
            if term::interactive() {
                match choose_member(&session).await? {
                    Some(query) => remove(&mut session, &query, false, &mut out).await,
                    None => Ok(()),
                }
            } else {
                list(&session, &mut out)
            }
        }
        Some(Action::Remove { member, yes }) => remove(&mut session, &member, yes, &mut out).await,
    }
}

fn list(session: &Session, out: &mut Output) -> anyhow::Result<()> {
    let members = session.members()?;
    out.out(format!("Members ({}):", members.len()));
    let width = name_width(&members);
    let keyless = keyless_owner(session);
    for group in groups(session, &members) {
        out.out(format!("  {}", group.heading));
        for member in group.devices {
            out.out(format!("    {}", device_text(member, width, keyless)));
        }
    }
    Ok(())
}

fn name_width(members: &[MemberInfo]) -> usize {
    members
        .iter()
        .map(|m| display_name(m).chars().count())
        .max()
        .unwrap_or(0)
}

/// A freshly paired owner device has no owner key until another one hands
/// it over, and cannot remove anyone until then.
fn keyless_owner(session: &Session) -> bool {
    !session.holds_owner_key()
}

/// The text of a device row, without the indent.
fn device_text(member: &MemberInfo, width: usize, keyless: bool) -> String {
    let revoked = matches!(member.person, Person::Verified { revoked: true, .. });
    let keyless = member.is_self && member.role == Role::Owner && keyless;
    format!(
        "#{:<3} {:<width$}  {}{}{}{}",
        member.leaf,
        display_name(member),
        match member.role {
            Role::Owner => "owner",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        },
        if revoked { "  (revoked)" } else { "" },
        if keyless {
            "  (no owner key here yet)"
        } else {
            ""
        },
        if member.is_self {
            "  (this device)"
        } else {
            ""
        },
    )
}

/// A heading and the devices under it.
struct Group<'a> {
    heading: String,
    /// Set for the heading of a verified person.
    person: Option<PersonId>,
    devices: Vec<&'a MemberInfo>,
}

/// The members as the list shows them: each verified person with their
/// devices, then the anonymous and unverified ones.
fn groups<'a>(session: &Session, members: &'a [MemberInfo]) -> Vec<Group<'a>> {
    let owner = session.owner_person();
    let mut groups = Vec::new();
    for person in people(members) {
        let devices: Vec<_> = members
            .iter()
            .filter(|m| matches!(m.person, Person::Verified { id, .. } if id == person))
            .collect();
        let mut marks = String::new();
        if owner == Some(person) {
            marks.push_str("  (owner)");
        }
        if devices.iter().any(|m| m.is_self) {
            marks.push_str("  (you)");
        }
        // Every device of the person carries the same graph profile.
        let name = devices
            .iter()
            .find_map(|m| m.person_profile.as_deref())
            .and_then(profile_name)
            .or_else(|| devices.first().map(|m| display_name(m)));
        groups.push(Group {
            heading: format!(
                "Person {}{}{marks}",
                person_fingerprint(&person),
                name.map(|n| format!("  {n}")).unwrap_or_default()
            ),
            person: Some(person),
            devices,
        });
    }
    for (heading, kind) in [
        ("Anonymous devices:", Person::Anonymous),
        (
            "Unverified devices (their person could not be checked):",
            Person::Unverified,
        ),
    ] {
        let devices: Vec<_> = members.iter().filter(|m| m.person == kind).collect();
        if !devices.is_empty() {
            groups.push(Group {
                heading: heading.to_owned(),
                person: None,
                devices,
            });
        }
    }
    groups
}

/// What a row of the member chooser stands for.
#[derive(Debug, Clone)]
enum Pick {
    Device(u32),
    Person(PersonId),
}

/// Why this folder cannot remove members, if it cannot.
fn cannot_remove(session: &Session) -> Option<&'static str> {
    if !session.can_write() {
        Some("Only the project owner can remove members (this folder has a view-only link)")
    } else if !session.holds_owner_key() {
        Some("Only the project owner can remove members (this folder has no owner key yet)")
    } else {
        None
    }
}

/// The chooser over the members. Returns the number or fingerprint to hand
/// to [`remove`], so the question and the checks are the ones of
/// `members remove`.
async fn choose_member(session: &Session) -> anyhow::Result<Option<String>> {
    let members = session.members()?;
    let width = name_width(&members);
    let keyless = keyless_owner(session);
    let mut items = Vec::new();
    for group in groups(session, &members) {
        items.push(Item {
            line: Line::from(group.heading).bold(),
            detail: None,
            value: group.person.map(Pick::Person),
        });
        for member in group.devices {
            items.push(Item {
                line: Line::from(format!("  {}", device_text(member, width, keyless))),
                detail: None,
                // `remove` refuses this folder's own device, so don't let
                // the cursor land on it only to fail after the view closes.
                value: (!member.is_self).then_some(Pick::Device(member.leaf)),
            });
        }
    }
    let note = cannot_remove(session).map(str::to_owned);
    let keys = if note.is_some() {
        &[][..]
    } else {
        &[Key {
            key: 'd',
            label: "remove",
        }][..]
    };
    let title = format!("typstry members ({})", members.len());
    Ok(choose(&title, items, keys, note)
        .await?
        .map(|(_, pick)| match pick {
            Pick::Device(leaf) => leaf.to_string(),
            Pick::Person(id) => person_fingerprint(&id),
        }))
}

/// The verified people in the group, in order of their first device.
fn people(members: &[MemberInfo]) -> Vec<PersonId> {
    let mut people = Vec::new();
    for member in members {
        if let Person::Verified { id, .. } = member.person
            && !people.contains(&id)
        {
            people.push(id);
        }
    }
    people
}

fn display_name(member: &MemberInfo) -> String {
    member
        .profile
        .as_deref()
        .and_then(profile_name)
        .unwrap_or_else(|| "(unnamed)".to_owned())
}

const CONSEQUENCE: &str =
    "The project's links are replaced; the other members switch over on their next sync.";

/// What `members remove` was pointed at.
enum Target {
    Device(MemberInfo),
    Person(PersonId),
}

/// What `query` names: a leaf number, else a person's fingerprint (a
/// unique prefix is enough), else a device name.
fn find(members: &[MemberInfo], query: &str) -> anyhow::Result<Target> {
    if let Ok(leaf) = query.parse::<u32>() {
        return members
            .iter()
            .find(|m| m.leaf == leaf)
            .cloned()
            .map(Target::Device)
            .with_context(|| format!("no member #{leaf}; see `typstry members`"));
    }
    let query = query.trim();
    if query.len() >= MIN_PREFIX {
        let matching = people(members)
            .into_iter()
            .filter(|p| person_fingerprint(p).starts_with(query));
        if let Some(person) = unique(matching, || {
            anyhow::anyhow!(
                "more than one person starts with {query:?}; type more of the fingerprint"
            )
        })? {
            return Ok(Target::Person(person));
        }
    }
    let wanted = query.to_lowercase();
    let found = members
        .iter()
        .filter(|m| display_name(m).to_lowercase() == wanted);
    unique(found, || {
        anyhow::anyhow!(
            "more than one member is named {query:?}; use the number from `typstry members`"
        )
    })?
    .cloned()
    .map(Target::Device)
    .with_context(|| format!("no member named {query:?}; see `typstry members`"))
}

async fn remove(
    session: &mut Session,
    query: &str,
    yes: bool,
    out: &mut Output,
) -> anyhow::Result<()> {
    if !session.can_write() {
        bail!("only the project owner can remove members, and this folder has a view-only link");
    }
    session.follow_group().await?;
    session.ensure_owner()?;
    let members = session.members()?;
    match find(&members, query)? {
        Target::Device(target) => {
            if target.is_self {
                bail!("#{} is this folder; it cannot remove itself", target.leaf);
            }
            let name = display_name(&target);
            if !confirmed(
                yes,
                &format!("Remove #{} {name}? {CONSEQUENCE}", target.leaf),
            )? {
                out.out("Nothing removed.");
                return Ok(());
            }
            session.remove_members(&[target.sig_pub]).await?;
            out.out(format!("Removed #{} {name}.", target.leaf));
        }
        Target::Person(person) => {
            let devices: Vec<_> = members
                .iter()
                .filter(|m| {
                    !m.is_self && matches!(m.person, Person::Verified { id, .. } if id == person)
                })
                .collect();
            if devices.is_empty() {
                bail!("that person's only device here is this folder; it cannot remove itself");
            }
            let names: Vec<_> = devices
                .iter()
                .map(|m| format!("#{} {}", m.leaf, display_name(m)))
                .collect();
            if !confirmed(
                yes,
                &format!(
                    "Remove person {} and their {} device(s) ({})? {CONSEQUENCE}",
                    person_fingerprint(&person),
                    devices.len(),
                    names.join(", ")
                ),
            )? {
                out.out("Nothing removed.");
                return Ok(());
            }
            session.remove_person(&person).await?;
            out.out(format!(
                "Removed person {} ({}).",
                person_fingerprint(&person),
                names.join(", ")
            ));
        }
    }
    publish_rotation(session, out).await
}

/// After a rotation: the new links, and the project re-uploaded under the
/// new keys.
pub(super) async fn publish_rotation(
    session: &mut Session,
    out: &mut Output,
) -> anyhow::Result<()> {
    out.out("The project's links changed. Anyone who still needs access needs the new ones:");
    write_links(out, &session.config);
    // The rotation is done; failing to upload the snapshot only leaves the
    // server with records under the keys of the old generation, which
    // members can still read, so this does not fail the command.
    if let Err(err) = connected(session, async |s| s.push_snapshot().await).await {
        out.err(format!(
            "warning: could not upload the project under the new keys yet ({err:#}); typstry sync will do it"
        ));
    }
    print_warnings(out, session);
    session.save()?;
    Ok(())
}
