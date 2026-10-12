use anyhow::{Context, bail};
use typstry_wire::mls::{MemberInfo, Role};

use super::link::print_links;
use super::{Ctx, Output, connected, print_warnings};
use crate::engine::Session;
use crate::mls::profile_name;

/// List the people with access to the project, or remove one.
///
/// Every device that joined with a link is a member, listed by the name it
/// gave. Removing a member replaces the project's links (the new ones are
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
    /// Remove a member and replace the links. Editors only.
    Remove {
        /// The member's number from `typstry members`, or its name.
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
    for member in &members {
        out.out(format!(
            "  #{:<3} {:<width$}  {}{}",
            member.leaf,
            display_name(member),
            match member.role {
                Role::Editor => "editor",
                Role::Viewer => "viewer",
            },
            if member.is_self { "  (you)" } else { "" },
        ));
    }
    Ok(())
}

fn display_name(member: &MemberInfo) -> String {
    member
        .profile
        .as_deref()
        .and_then(profile_name)
        .unwrap_or_else(|| "(unnamed)".to_owned())
}

/// The member `query` names: a leaf number, else a name.
fn find(members: &[MemberInfo], query: &str) -> anyhow::Result<MemberInfo> {
    if let Ok(leaf) = query.parse::<u32>() {
        return members
            .iter()
            .find(|m| m.leaf == leaf)
            .cloned()
            .with_context(|| format!("no member #{leaf}; see `typstry members`"));
    }
    let wanted = query.trim().to_lowercase();
    let mut found = members
        .iter()
        .filter(|m| display_name(m).to_lowercase() == wanted);
    match (found.next(), found.next()) {
        (Some(member), None) => Ok(member.clone()),
        (None, _) => bail!("no member named {query:?}; see `typstry members`"),
        (Some(_), Some(_)) => {
            bail!("more than one member is named {query:?}; use the number from `typstry members`")
        }
    }
}

async fn remove(session: &mut Session, query: &str, out: &mut Output) -> anyhow::Result<()> {
    if !session.can_write() {
        bail!("only editors can remove members, and this folder has a view-only link");
    }
    session.follow_group().await?;
    let target = find(&session.members()?, query)?;
    if target.is_self {
        bail!("#{} is this folder; it cannot remove itself", target.leaf);
    }
    let name = display_name(&target);
    session.remove_members(&[target.sig_pub]).await?;
    out.out(format!("Removed #{} {name}.", target.leaf));
    publish_rotation(session, out).await
}

/// After a rotation: the new links, and the project re-uploaded under the
/// new keys.
pub(super) async fn publish_rotation(
    session: &mut Session,
    out: &mut Output,
) -> anyhow::Result<()> {
    out.out("The project's links changed. Anyone who still needs access needs the new ones:");
    print_links(&session.config, None)?;
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
