use anyhow::{Context, bail};
use typstry_wire::identity::{PersonId, person_fingerprint};
use typstry_wire::mls::{MemberInfo, Person, Role};

use super::link::write_links;
use super::{Ctx, MIN_PREFIX, Output, connected, print_warnings, unique};
use crate::engine::Session;
use crate::mls::profile_name;

/// List the people with access to the project, or remove one.
///
/// Every device that joined with a link is a member, listed by the name it
/// gave and grouped under the person it belongs to. The owner's person is
/// marked "owner", and devices their person has revoked "revoked".
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
    /// Remove a member and replace the links. The project owner only.
    Remove {
        /// A device's number from `typstry members` or its name, or a
        /// person's fingerprint (the start is enough) to remove all of
        /// their devices.
        // Fingerprints are base64url, so one starts with '-' now and then.
        #[arg(allow_hyphen_values = true)]
        member: String,
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
            list(&session, &mut out)
        }
        Some(Action::Remove { member }) => remove(&mut session, &member, &mut out).await,
    }
}

fn list(session: &Session, out: &mut Output) -> anyhow::Result<()> {
    let members = session.members()?;
    out.out(format!("Members ({}):", members.len()));
    let width = members
        .iter()
        .map(|m| display_name(m).chars().count())
        .max()
        .unwrap_or(0);
    // An owner device that was paired lately can be one before another one
    // hands it the key; until then it cannot remove anyone.
    let keyless = !session.holds_owner_key();
    let device = |out: &mut Output, member: &MemberInfo| {
        let revoked = matches!(member.person, Person::Verified { revoked: true, .. });
        let keyless = member.is_self && member.role == Role::Owner && keyless;
        out.out(format!(
            "    #{:<3} {:<width$}  {}{}{}{}",
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
        ));
    };
    let owner = session.owner_person();
    for person in people(&members) {
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
        out.out(format!(
            "  Person {}{}{marks}",
            person_fingerprint(&person),
            name.map(|n| format!("  {n}")).unwrap_or_default()
        ));
        for member in devices {
            device(out, member);
        }
    }
    for (heading, kind) in [
        ("Anonymous devices:", Person::Anonymous),
        (
            "Unverified devices (their person could not be checked):",
            Person::Unverified,
        ),
    ] {
        let group: Vec<_> = members.iter().filter(|m| m.person == kind).collect();
        if group.is_empty() {
            continue;
        }
        out.out(format!("  {heading}"));
        for member in group {
            device(out, member);
        }
    }
    Ok(())
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

async fn remove(session: &mut Session, query: &str, out: &mut Output) -> anyhow::Result<()> {
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
