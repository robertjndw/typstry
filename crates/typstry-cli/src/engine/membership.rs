//! Following the project's MLS group: catching up on commits before the doc
//! connects, adopting rotated links, and the commits this folder makes
//! itself (removing members, resetting the links).
//!
//! The doc never waits for the group beyond the catch-up in
//! [`Session::connect`]: a stalled group only costs rotations, so it is a
//! warning, not an error.

use std::time::Duration;

use anyhow::{Context, bail};
use typstry_wire::crypto::{DocKeys, PublicKey};
use typstry_wire::ds::{Permission as DsPermission, ServerMessage};
use typstry_wire::mls::{
    Device, MemberInfo, MlsError, Outcome, ProjectGroup, Rotation, SubmitPayload,
};

use crate::api::Permission;
use crate::mls::{Ds, Reply, jitter, join_group, refusal_text};
use crate::state::Config;

use super::{Session, SyncError};

pub(super) const NO_KEYS: &str =
    "this folder has no group keys; run `typstry pull` to join the project again";

/// Rejoins in a row before giving up, e.g. against a group that keeps being
/// reset.
const RESYNCS: u32 = 3;

/// Tries at a commit of our own before giving up. Each lost one means
/// someone else committed first.
const COMMIT_ATTEMPTS: u32 = 5;

/// How long the server may go quiet while it still owes us commits. A log
/// that was pruned past our epoch never sends them, which is the cue to
/// rejoin instead.
const COMMIT_SILENCE: Duration = Duration::from_secs(8);

enum Followed {
    /// Up to date. Holds the connection the last catch-up ended on when it
    /// can still be used to submit a commit (see [`Session::follow`]).
    Current(Option<Box<Ds>>),
    /// The folder's state cannot follow the group any more.
    Rejoin,
}

impl Session {
    pub(super) fn doc_keys(&self) -> anyhow::Result<&DocKeys> {
        Ok(self.group.as_ref().context(NO_KEYS)?.doc_keys())
    }

    /// Brings the group up to date: applies the commits since this folder
    /// last looked, adopts new links after a rotation, and joins (or joins
    /// again) when the saved state is missing or too old to follow.
    ///
    /// Works with a retired token, which is how a folder that was offline
    /// during a rotation finds out what happened.
    pub async fn follow_group(&mut self) -> anyhow::Result<()> {
        if let Some(ds) = self.follow().await? {
            ds.close().await;
        }
        Ok(())
    }

    /// [`Self::follow_group`], handing back the connection it ended on if
    /// that one is current (no rotation moved the token) and open, so a
    /// commit can go out on it without a second hello.
    async fn follow(&mut self) -> anyhow::Result<Option<Ds>> {
        let mut rejoin = self.group.is_none();
        for _ in 0..RESYNCS {
            if self.group.as_ref().is_some_and(|g| !g.is_active()) {
                return Err(SyncError::Removed.into());
            }
            if rejoin {
                Box::pin(self.join_again()).await?;
            }
            match Box::pin(self.catch_up()).await? {
                Followed::Current(ds) => return Ok(ds.map(|ds| *ds)),
                Followed::Rejoin => rejoin = true,
            }
        }
        bail!("the project's group was reset again and again; try again later")
    }

    /// An external join. With a group on file the device stays the same, so
    /// the new leaf replaces the old one instead of joining it.
    async fn join_again(&mut self) -> anyhow::Result<()> {
        // The device outlives the group state (see `StateDir::save_device`),
        // so a folder whose mls.bin was damaged still replaces its old leaf.
        let device = match &self.group {
            Some(group) => Some(group.device().duplicate()),
            None => self.state.load_device(),
        };
        let device = device.unwrap_or_else(Device::generate);
        // Before the join, so a refused or interrupted attempt keeps it.
        self.state.save_device(&device)?;
        let link = self.config.link();
        let group = join_group(&self.api, &link, device, &self.identity).await?;
        self.state.save_mls(&group)?;
        self.group = Some(group);
        Ok(())
    }

    async fn catch_up(&mut self) -> anyhow::Result<Followed> {
        let group = self.group.as_mut().context(NO_KEYS)?;
        let incarnation = u64::from(group.incarnation());
        let mut rotated = false;
        let mut open = None;
        let mut rejoin = false;
        // A retired token reads the log only up to the rotation that retired
        // it, so each rotation found there moves on to the token it handed
        // out, until the folder is at the head.
        loop {
            let mut ds = Ds::connect(
                &self.config.server,
                &self.config.token,
                incarnation,
                group.epoch(),
            )
            .await?;
            if ds.ready.incarnation != incarnation {
                ds.close().await;
                return Ok(Followed::Rejoin);
            }
            let mut hop = false;
            while group.epoch() < ds.ready.head {
                let msg = match tokio::time::timeout(COMMIT_SILENCE, ds.next()).await {
                    Ok(msg) => msg?,
                    Err(_) => {
                        rejoin = true;
                        break;
                    }
                };
                let (epoch, commit, envelope) = match msg {
                    ServerMessage::Commit {
                        epoch,
                        commit,
                        envelope,
                    } => (epoch, commit, envelope),
                    ServerMessage::Reinitialized { .. } => {
                        rejoin = true;
                        break;
                    }
                    ServerMessage::Refused { code, .. } => {
                        bail!("following the project's group: {}", refusal_text(code))
                    }
                    _ => continue,
                };
                match group.process_commit(epoch, &commit, envelope.as_deref()) {
                    Ok(Outcome::Advanced | Outcome::AlreadyApplied) => {}
                    Ok(Outcome::Rotated(rotation)) => {
                        adopt(&mut self.config, &rotation);
                        // Before the group state: a crash in between replays
                        // the rotation, but losing the new link would lock the
                        // folder out.
                        self.state.save_config(&self.config)?;
                        self.resolved = None;
                        rotated = true;
                        hop = true;
                        break;
                    }
                    Ok(Outcome::Removed) => {
                        self.state.save_mls(group)?;
                        ds.close().await;
                        return Err(SyncError::Removed.into());
                    }
                    Ok(Outcome::Invalid(why)) => {
                        self.warnings.push(format!(
                            "the project's member group is stalled ({why}); an editor has to reset it before links can rotate again. Syncing the document still works"
                        ));
                        break;
                    }
                    // A gap: the commits in between were pruned from the log.
                    Err(MlsError::Epoch { .. }) => {
                        rejoin = true;
                        break;
                    }
                    Err(MlsError::NotActive) => return Err(SyncError::Removed.into()),
                    Err(err) => return Err(err).context("applying a group commit"),
                }
            }
            let head = ds.ready.head;
            if rejoin {
                ds.close().await;
                return Ok(Followed::Rejoin);
            }
            if !hop {
                open = Some(Box::new(ds));
                break;
            }
            // The connection speaks for the token before the rotation.
            ds.close().await;
            if group.epoch() >= head {
                break;
            }
        }
        // Only now: with several rotations to apply, the server holds the
        // keyring of the last one, which the earlier steps would not agree
        // with.
        if rotated || group.needs_keyring() {
            let boot = self.api.mls_bootstrap(&self.config.token).await?;
            group
                .set_keyring(&boot.keyring)
                .context("reading the rotated keyring")?;
        }
        self.state.save_mls(group)?;
        Ok(Followed::Current(open))
    }

    /// Fetches the keyring the server holds and applies it. False when the
    /// group has not reached its generation yet, which only following the
    /// group's commits can fix.
    pub(super) async fn refresh_keyring(&mut self) -> anyhow::Result<bool> {
        let boot = self.api.mls_bootstrap(&self.config.token).await?;
        let group = self.group.as_mut().context(NO_KEYS)?;
        if group.set_keyring(&boot.keyring).is_err() {
            return Ok(false);
        }
        self.state.save_mls(group)?;
        Ok(true)
    }

    /// The members as of the last time the group was followed.
    pub fn members(&self) -> anyhow::Result<Vec<MemberInfo>> {
        Ok(self.group.as_ref().context(NO_KEYS)?.members()?)
    }

    /// Removes the members whose device keys are `members` and rotates the
    /// links so what they hold stops working. The new links are in
    /// [`Session::config`] afterwards.
    ///
    /// Members are named by key and looked up in the group as it is right
    /// before the commit: a leaf number seen earlier may belong to someone
    /// else by now, since a removed member's leaf is handed to the next
    /// joiner.
    pub async fn remove_members(&mut self, members: &[PublicKey]) -> anyhow::Result<()> {
        self.rotate(|group| {
            let current = group.members()?;
            let leaves = members
                .iter()
                .map(|key| {
                    current
                        .iter()
                        .find(|m| &m.sig_pub == key)
                        .map(|m| m.leaf)
                        .context("that member is already gone; see `typstry members`")
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            Ok(group.remove_and_rotate(&leaves)?)
        })
        .await
    }

    /// Replaces the links without removing anyone.
    pub async fn reset_links(&mut self) -> anyhow::Result<()> {
        self.rotate(|group| Ok(group.reset_links()?)).await
    }

    /// Makes a rotation commit and gets it accepted.
    ///
    /// The commit is saved with the group state before it is sent. If the
    /// reply is lost, whether it landed is unknown, so nothing is discarded
    /// on a transport error: the next run follows the log, which echoes the
    /// commit back if it landed (adopting the new links), and otherwise
    /// sends the saved commit again.
    async fn rotate(
        &mut self,
        build: impl Fn(&mut ProjectGroup) -> anyhow::Result<SubmitPayload>,
    ) -> anyhow::Result<()> {
        if !self.can_write() {
            bail!("only editors can do that, and this folder has a view-only link");
        }
        for _ in 0..COMMIT_ATTEMPTS {
            let was_pending = self.group.as_ref().is_some_and(|g| g.has_pending());
            let token = self.config.token.clone();
            // Built on the newest epoch, or the commit would lose the race
            // before it started.
            let mut followed = self.follow().await?;
            let group = self.group.as_mut().context(NO_KEYS)?;
            if was_pending && !group.has_pending() && self.config.token != token {
                // The log showed an earlier attempt of ours landed, and
                // following adopted its links. Doing it again would rotate
                // twice.
                if let Some(ds) = followed {
                    ds.close().await;
                }
                self.warnings.push(
                    "finished a rotation an earlier run had started; the links are the new ones"
                        .to_owned(),
                );
                self.resolved = None;
                return Ok(());
            }
            // Following hands back its connection short of the head only when
            // the group met a commit it refuses. A commit built there can only
            // lose, so retrying would just report a race that is not one.
            if let Some(ds) = followed.take_if(|ds| group.epoch() < ds.ready.head) {
                ds.close().await;
                bail!(
                    "the project's member group is stalled; an editor has to reset it before members can be removed or the links reset"
                );
            }
            let mut ds = match followed {
                Some(ds) => ds,
                None => {
                    Ds::connect(
                        &self.config.server,
                        &self.config.token,
                        u64::from(group.incarnation()),
                        group.epoch(),
                    )
                    .await?
                }
            };
            if ds.ready.permission != DsPermission::Write {
                ds.close().await;
                bail!("the server treats this link as read-only");
            }
            let payload = match group.pending_submit() {
                Some(pending) => pending.clone(),
                None => build(group)?,
            };
            let rotate = payload
                .rotate
                .clone()
                .context("a rotation carries new tokens")?;
            self.state.save_mls(group)?;
            let reply = ds.request(1, &payload.into_message(1)).await;
            ds.close().await;
            match reply {
                Ok(Reply::Accepted) => {
                    let rotation = group
                        .confirm_pending()?
                        .context("the confirmed commit did not rotate the links")?;
                    debug_assert_eq!(rotation.tokens.edit.as_deref(), Some(&*rotate.edit_token));
                    adopt(&mut self.config, &rotation);
                    self.state.save_config(&self.config)?;
                    self.state.save_mls(group)?;
                    self.resolved = None;
                    return Ok(());
                }
                // Either another commit won the epoch or ours landed and
                // the reply was lost. Following the log tells which: it
                // confirms our commit when it echoes, and drops it when
                // another one took the epoch.
                Ok(Reply::Conflict) => tokio::time::sleep(jitter(1)).await,
                Ok(Reply::Refused(code)) => {
                    group.discard_pending()?;
                    self.state.save_mls(group)?;
                    bail!("the server refused the change: {}", refusal_text(code));
                }
                Err(err) => {
                    return Err(err).context(
                        "no answer to the change, so it may or may not have gone through; \
                         run the command again to finish it",
                    );
                }
            }
        }
        bail!("other members kept changing the project's group; try again")
    }
}

/// Switches `config` to the links of a rotation.
fn adopt(config: &mut Config, rotation: &Rotation) {
    config.key = rotation.link.to_base64url().to_string();
    match &rotation.tokens.edit {
        Some(edit) => {
            config.token = edit.clone();
            config.view_token = Some(rotation.tokens.view.clone());
            config.permission = Permission::Write;
        }
        // Not sent the edit link, e.g. a viewer: the view link is all there
        // is, and there is no other token to remember.
        None => {
            config.token = rotation.tokens.view.clone();
            config.view_token = None;
            config.permission = Permission::Read;
        }
    }
}
