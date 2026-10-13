//! Following the project's MLS group: catching up on commits before the doc
//! connects, adopting rotated links, and the commits this folder makes
//! itself (removing members, resetting the links).
//!
//! The doc never waits for the group beyond the catch-up in
//! [`SpaceCore::connect`]: a stalled group only costs rotations, so it is a
//! warning, not an error.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Context, bail};
use typstry_wire::crypto::{DocKeys, PublicKey};
use typstry_wire::ds::{Permission as DsPermission, ServerMessage};
use typstry_wire::identity::PersonId;
use typstry_wire::mls::{
    IdentityStep, LeafKeys, MemberInfo, MlsError, Outcome, Role, Rotation, SpaceGroup,
    SubmitPayload,
};

use crate::api::Permission;
use crate::link::ShareLink;
use crate::mls::{Ds, Reply, jitter, join_group, profile_bytes, refusal_text};
use crate::state::{Config, StateDir};
use crate::{directory, user};
use typstry_doc::directory::State;

use super::{DocKind, SpaceCore, SyncError};

pub(super) const NO_KEYS: &str =
    "this folder has no group keys; run `typstry pull` to join the project again";

pub const NOT_OWNER: &str = "Only the project owner can remove members or reset links.";

pub const NO_OWNER_KEY: &str = "This device does not have the project's owner key yet. Open the \
     project on another of your devices that can remove members (`typstry pull` there) and it is \
     handed over. If none is left, the links can no longer be reset.";

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
    /// can still be used to submit a commit (see [`SpaceCore::follow`]).
    Current(Option<Box<Ds>>),
    /// The folder has to join again: its state cannot follow the group any
    /// more, or its leaf names a person this machine has left.
    Rejoin,
}

fn current(ds: Option<Ds>) -> Followed {
    Followed::Current(ds.map(Box::new))
}

impl SpaceCore {
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
        let followed = self.follow().await;
        match followed {
            Ok(Some(ds)) => ds.close().await,
            Ok(None) => {}
            Err(err) => {
                self.note_fatal(&err);
                return Err(err);
            }
        }
        Ok(())
    }

    /// Tells the directory when the project is lost for good: the person
    /// was removed from it, or its link is gone or replaced. Every command
    /// that talks to the server comes through [`Self::connect`] or
    /// [`Self::follow_group`], so this is the one place that sees it.
    pub(super) fn note_fatal(&mut self, err: &anyhow::Error) {
        if !self.kind.listed {
            return;
        }
        let state = match SyncError::fatal(err) {
            Some(SyncError::Removed) => State::Removed,
            Some(SyncError::UnknownLink | SyncError::LinkReplaced) => State::Gone,
            _ => return,
        };
        if let Err(err) =
            directory::record_status(&self.config.link(), &self.config.project_id, state)
        {
            self.warnings
                .push(format!("could not update your project directory: {err:#}"));
        }
    }

    /// [`Self::follow_group`], handing back the connection it ended on if
    /// that one is current (no rotation moved the token) and open, so a
    /// commit can go out on it without a second hello.
    async fn follow(&mut self) -> anyhow::Result<Option<Ds>> {
        let followed = self.follow_inner().await;
        // Following is where a key handed over or rotated in arrives.
        self.keep_owner_key();
        followed
    }

    async fn follow_inner(&mut self) -> anyhow::Result<Option<Ds>> {
        self.take_owner_keys();
        let mut rejoin = self.group.is_none();
        let mut switched = false;
        for _ in 0..RESYNCS {
            if self.group.as_ref().is_some_and(|g| !g.is_active()) {
                return Err(SyncError::Removed.into());
            }
            if rejoin {
                Box::pin(self.join_again()).await?;
            }
            match Box::pin(self.catch_up()).await? {
                Followed::Current(ds) => {
                    match Box::pin(self.refresh_identity(ds.map(|ds| *ds))).await? {
                        Followed::Current(ds) => return Ok(ds.map(|ds| *ds)),
                        // Once per run, so a join that keeps the old person
                        // cannot loop. If it fails, the folder syncs as the
                        // old person and the next run tries again.
                        Followed::Rejoin if !switched => {
                            switched = true;
                            if let Err(err) = Box::pin(self.join_again()).await {
                                self.warnings.push(format!(
                                    "could not move this folder over to your person: {err:#}"
                                ));
                                return Ok(None);
                            }
                        }
                        Followed::Rejoin => return Ok(None),
                    }
                }
                Followed::Rejoin => rejoin = true,
            }
        }
        bail!("the project's group was reset again and again; try again later")
    }

    /// Hands the group the owner keys this machine holds for the project,
    /// the directory's included, so a folder that joined before a key
    /// reached it can rotate without another owner device online to hand
    /// it over. A view-only folder could never use them.
    fn take_owner_keys(&mut self) {
        if !self.config.can_sign() {
            return;
        }
        let Some(group) = self.group.as_mut().filter(|g| g.is_active()) else {
            return;
        };
        if group.owner_secret().is_some() {
            return;
        }
        directory::import_owner_keys(&self.config.server, &self.config.project_id);
        group.keep_owner_secrets(&user::owner_keys(
            &self.config.server,
            &self.config.project_id,
        ));
    }

    /// An external join. With a group on file the device stays the same, so
    /// the new leaf replaces the old one instead of joining it.
    async fn join_again(&mut self) -> anyhow::Result<()> {
        // The device outlives the group state (see `StateDir::save_device`),
        // so a folder whose mls.bin was damaged still replaces its old leaf.
        let pinned = self.config.pinned_owner().map_err(|_| {
            anyhow::anyhow!(
                "the owner recorded in {} is damaged, so the project's owner cannot be \
                 checked; restore the file from a backup or clone the project again",
                self.state.dir().join("config.json").display()
            )
        })?;
        let device = match &self.group {
            Some(group) => Some(group.device().duplicate()),
            None => self.state.load_device(),
        };
        let device = device.unwrap_or_else(LeafKeys::generate);
        // Before the join, so a refused or interrupted attempt keeps it.
        self.state.save_device(&device)?;
        // A join leaf carries no shares, so a key not taken along here only
        // comes back once another owner device hands it over, if any is left.
        // The join picks whichever of these the server holds. A view-only
        // folder could never use the machine's keys, so it does not get them.
        let mut owner_keys = self.state.load_owner_keys();
        if self.config.can_sign() {
            // Keys of projects the person owns that this machine never opened.
            directory::import_owner_keys(&self.config.server, &self.config.project_id);
            owner_keys.extend_older(&user::owner_keys(
                &self.config.server,
                &self.config.project_id,
            ));
        }
        let link = self.config.link();
        if self.local.is_none() {
            self.local = Some(user::load_or_create_identity()?);
        }
        let local = self.local.as_ref().expect("loaded right above");
        let group = join_group(
            &self.api,
            &link,
            device,
            &self.identity,
            local,
            pinned,
            self.group.as_ref(),
            &owner_keys,
        )
        .await?;
        // The first join pins the project's owner for good.
        if self.config.owner_person.is_none()
            && let Some(owner) = group.owner_person()
        {
            self.config.pin_owner(&owner);
            self.state.save_config(&self.config)?;
        }
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
                let (epoch, commit, envelope, owner_key) = match msg {
                    ServerMessage::Commit {
                        epoch,
                        commit,
                        envelope,
                        owner_key,
                    } => (epoch, commit, envelope, owner_key),
                    ServerMessage::Reinitialized { .. } => {
                        rejoin = true;
                        break;
                    }
                    ServerMessage::Refused { code, .. } => {
                        bail!("following the project's group: {}", refusal_text(code))
                    }
                    _ => continue,
                };
                match group.process_commit(epoch, &commit, envelope.as_deref(), owner_key.as_ref())
                {
                    Ok(Outcome::Advanced | Outcome::AlreadyApplied) => {}
                    Ok(Outcome::Rotated(rotation)) => {
                        adopt_rotation(
                            self.kind,
                            &self.state,
                            &mut self.config,
                            &rotation,
                            typstry_doc::title(&self.doc).as_deref(),
                            group.generation().ok(),
                            &mut self.warnings,
                        )?;
                        self.resolved = None;
                        rotated = true;
                        hop = true;
                        break;
                    }
                    Ok(Outcome::Removed { person }) => {
                        self.state.save_mls(group)?;
                        ds.close().await;
                        // This folder cannot follow the group any more, so
                        // this is its last chance to hear why. Usually that
                        // is a revoke of this device, which the other
                        // devices of the person should not have to repeat.
                        if let Some(person) = person {
                            match user::merge_graph(&person) {
                                Ok(saved) => {
                                    if let Some(local) = &mut self.local {
                                        local.graph = saved;
                                    }
                                }
                                Err(err) => self.warnings.push(format!(
                                    "could not merge your devices from the group: {err:#}"
                                )),
                            }
                        }
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

    /// Folds what the group knows of this person's devices into the local
    /// graph, and puts the local graph's newer entries into this device's
    /// leaf, e.g. a device revoked since the leaf was last committed. Best
    /// effort: a lost race is tried again after catching up, and the next
    /// run does it if this one cannot. Hands back `ds` untouched when
    /// nothing was needed. [`Followed::Rejoin`] when this folder joined as
    /// another person than the machine is now, e.g. it was cloned before
    /// `typstry pair --replace`: such a leaf can only move over by joining
    /// again with the same leaf keys, viewers included.
    async fn refresh_identity(&mut self, mut ds: Option<Ds>) -> anyhow::Result<Followed> {
        if self.local.is_none() {
            self.local = user::load_identity()?;
        }
        for attempt in 1..=COMMIT_ATTEMPTS {
            let step = match self.identity_step() {
                Ok(Some(step)) => step,
                Ok(None) => return Ok(current(ds)),
                Err(err) => {
                    self.warnings.push(format!(
                        "could not merge your devices from the group: {err:#}"
                    ));
                    return Ok(current(ds));
                }
            };
            if step.rejoin {
                if let Some(ds) = ds {
                    ds.close().await;
                }
                return Ok(Followed::Rejoin);
            }
            // A viewer's commit is always refused, so don't open a
            // connection just to find that out.
            if !self.can_write() {
                return Ok(current(ds));
            }
            let space = self.person_space();
            let Some(local) = self.local.as_mut() else {
                return Ok(current(ds));
            };
            if let Some(merged) = &step.merged {
                match user::merge_graph(merged) {
                    Ok(saved) => local.graph = saved,
                    Err(err) => {
                        self.warnings.push(format!(
                            "could not merge your devices from the group: {err:#}"
                        ));
                        return Ok(current(ds));
                    }
                }
            }
            let group = self.group.as_mut().context(NO_KEYS)?;
            // The same commit hands the owner key to the owner devices that
            // lack it, which is the only way a newly paired one gets it.
            if group.has_pending() || !(step.needs_refresh || step.share_owner_key) {
                return Ok(current(ds));
            }
            let mut conn = match ds.take() {
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
            // A commit built behind the head can only lose.
            if conn.ready.permission != DsPermission::Write || group.epoch() < conn.ready.head {
                conn.close().await;
                return Ok(Followed::Current(None));
            }
            let payload = group.self_update(
                &profile_bytes(&self.identity),
                Some(&local.graph),
                space.as_ref(),
            )?;
            self.state.save_mls(group)?;
            let reply = conn.request(1, &payload.into_message(1)).await;
            conn.close().await;
            match reply? {
                Reply::Accepted => {
                    group.confirm_pending()?;
                    self.state.save_mls(group)?;
                    return Ok(Followed::Current(None));
                }
                Reply::Conflict => {
                    group.discard_pending()?;
                    self.state.save_mls(group)?;
                    if attempt == COMMIT_ATTEMPTS {
                        return Ok(Followed::Current(None));
                    }
                    tokio::time::sleep(jitter(attempt)).await;
                    match Box::pin(self.catch_up()).await? {
                        Followed::Current(next) => ds = next.map(|ds| *ds),
                        Followed::Rejoin => return Ok(Followed::Current(None)),
                    }
                }
                // Only a refresh: it shows on the next try.
                Reply::Refused(_) => {
                    group.discard_pending()?;
                    self.state.save_mls(group)?;
                    return Ok(Followed::Current(None));
                }
            }
        }
        Ok(Followed::Current(None))
    }

    /// What this device has to do to keep its identity in the group in
    /// line with its person, judged on the graph as this run last saw it
    /// (see [`SpaceGroup::identity_step`]). None while the machine is not
    /// a person.
    pub fn identity_step(&self) -> anyhow::Result<Option<IdentityStep>> {
        let group = self.group.as_ref().context(NO_KEYS)?;
        let Some(local) = &self.local else {
            return Ok(None);
        };
        Ok(Some(group.identity_step(
            &local.graph,
            self.person_space().as_ref(),
        )?))
    }

    /// The personal space pointer this leaf should carry, from the binding
    /// of this project's server.
    fn person_space(&self) -> Option<typstry_wire::mls::PersonSpace> {
        crate::space::pointer_for(&self.config.server, &self.config.project_id)
    }

    /// Fails unless this device is the project owner's, as of the last
    /// time the group was followed.
    pub fn ensure_owner(&self) -> anyhow::Result<()> {
        let is_owner = self
            .members()?
            .iter()
            .any(|m| m.is_self && m.role == Role::Owner);
        if is_owner { Ok(()) } else { bail!(NOT_OWNER) }
    }

    /// Whether this folder can remove members and reset the links: an
    /// owner device that holds the project's current owner key.
    pub fn holds_owner_key(&self) -> bool {
        self.group.as_ref().is_some_and(|g| g.holds_owner_key())
    }

    /// The devices the group shows as revoked, of anyone, which are still
    /// in it: only an owner device holding the owner key can remove them.
    pub fn revoked_in_group(&self) -> usize {
        self.group.as_ref().map_or(0, |g| g.revoked_leaves().len())
    }

    /// Leaves the owner keys this folder holds where the machine's other
    /// folders of the project find them when they join: all of them, since
    /// which is current is only what the server says. Best effort: they can
    /// still be handed the current one through the group.
    fn keep_owner_key(&mut self) {
        let Some(group) = self.group.as_ref() else {
            return;
        };
        let (server, id) = (&self.config.server, &self.config.project_id);
        if let Err(err) = user::remember_owner_keys(server, id, group.owner_secrets()) {
            self.warnings
                .push(format!("could not keep the project's owner key: {err:#}"));
        }
        // Only the current key: which of the held ones is the server's is
        // what the directory must not blur.
        if let Some(current) = group.owner_secret()
            && let Err(err) = directory::record_owner_keys(server, id, current)
        {
            self.warnings.push(format!(
                "could not share the project's owner key with your other devices: {err:#}"
            ));
        }
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

    /// Records this folder in the user's project list and directory, with
    /// the project's current title. A failure is only a warning: the lists
    /// are a convenience for pairing and `typstry list`, not part of the
    /// project.
    pub fn remember_project(&mut self) {
        if !self.kind.listed {
            return;
        }
        let title = typstry_doc::title(&self.doc);
        let link = self.config.link();
        let generation = self.group.as_ref().and_then(|g| g.generation().ok());
        let folder = user::remember_project(self.state.root(), &link, title.as_deref());
        // The server named this project for the token; an entry that files
        // it elsewhere would send other devices to the wrong place, but the
        // token itself still works, so it moves instead of being retired.
        let listed =
            directory::record_open(&link, &self.config.project_id, title.as_deref(), generation);
        if let Ok(true) = listed {
            self.warnings.push(
                "your project directory filed this project's link under another project; \
                 it was moved to this one"
                    .to_owned(),
            );
        }
        for err in [folder.err(), listed.err()].into_iter().flatten() {
            self.warnings.push(format!(
                "could not update the list of your projects: {err:#}"
            ));
        }
    }

    /// The members as of the last time the group was followed.
    pub fn members(&self) -> anyhow::Result<Vec<MemberInfo>> {
        Ok(self.group.as_ref().context(NO_KEYS)?.members()?)
    }

    /// Removes the members whose device keys are `members` and rotates the
    /// links so what they hold stops working. The new links are in
    /// [`SpaceCore::config`] afterwards.
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

    /// Removes every other device of `person` and rotates the links. The
    /// devices are looked up right before the commit, like in
    /// [`Self::remove_members`], so one that joined in between goes too.
    pub async fn remove_person(&mut self, person: &PersonId) -> anyhow::Result<()> {
        self.rotate(|group| {
            let leaves = group.leaves_of(person)?;
            if leaves.is_empty() {
                bail!("that person has no other devices in the project; see `typstry members`");
            }
            Ok(group.remove_and_rotate(&leaves)?)
        })
        .await
    }

    /// Removes the devices the group shows as revoked, of whichever person,
    /// and rotates the links. Only an owner device holding the owner key
    /// can; everyone else commits the revoke into their own leaf when
    /// following and leaves the removal to it. The revoke has to be in the
    /// group already, which following puts there. Returns how many devices
    /// went; with none to remove the links stay as they are.
    pub async fn remove_revoked(&mut self) -> anyhow::Result<usize> {
        let group = self.group.as_ref().context(NO_KEYS)?;
        // Counted again when the commit is built, after following: by then
        // another device may have removed some, or the refresh revealed more.
        let removed = AtomicUsize::new(group.revoked_leaves().len());
        if removed.load(Ordering::Relaxed) == 0 {
            return Ok(0);
        }
        self.rotate(|group| {
            let removal = group.remove_revoked()?;
            removed.store(removal.removed.len(), Ordering::Relaxed);
            Ok(removal.submit)
        })
        .await?;
        Ok(removed.into_inner())
    }

    /// Removes the leaves of revoked devices, e.g. ones a recovery key or
    /// another person's device revoked, when this folder holds the owner
    /// key; otherwise only says that they are still there. Best effort: a
    /// failure is a warning and the next run tries again. Returns whether
    /// the links were replaced.
    pub(super) async fn remove_revoked_devices(&mut self) -> bool {
        if !self.can_write() {
            return false;
        }
        let revoked = self.revoked_in_group();
        if revoked == 0 {
            return false;
        }
        if !self.holds_owner_key() {
            self.warnings.push(format!(
                "{revoked} revoked device(s) are still in the project and keep their access until \
                 a device that holds the project's owner key opens it (`typstry pull` there)"
            ));
            return false;
        }
        match self.remove_revoked().await {
            Ok(0) => false,
            Ok(count) => {
                self.warnings.push(format!(
                    "removed {count} revoked device(s) from the project and replaced its links"
                ));
                true
            }
            Err(err) => {
                self.warnings.push(format!(
                    "could not remove the revoked devices from the project yet ({err:#})"
                ));
                false
            }
        }
    }

    /// The person that owns the project, as far as the group shows it.
    pub fn owner_person(&self) -> Option<PersonId> {
        self.group.as_ref()?.owner_person()
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
        build: impl Fn(&mut SpaceGroup) -> anyhow::Result<SubmitPayload>,
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
                None => build(group).map_err(|err| match err.downcast_ref::<MlsError>() {
                    Some(MlsError::NotOwner) => anyhow::anyhow!(NOT_OWNER),
                    Some(MlsError::NoOwnerKey) => anyhow::anyhow!(NO_OWNER_KEY),
                    // Following fetches the keyring after a rotation, so
                    // this only happens when the server's lags the group.
                    Some(MlsError::KeyringBehind) => anyhow::anyhow!(
                        "this folder does not have the project's current keys yet, so the \
                         links cannot be replaced now; run `typstry pull` and try again in a \
                         moment"
                    ),
                    _ => err,
                })?,
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
                    adopt_rotation(
                        self.kind,
                        &self.state,
                        &mut self.config,
                        &rotation,
                        typstry_doc::title(&self.doc).as_deref(),
                        group.generation().ok(),
                        &mut self.warnings,
                    )?;
                    self.state.save_mls(group)?;
                    self.resolved = None;
                    self.keep_owner_key();
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

/// Switches `config` to the links of a rotation and saves it, then updates
/// the stored link of the folder at `root` and the directory: the new link
/// in, the old one retired. Spaces the directory does not list have
/// neither. Only saving the config can fail; the lists are warnings.
fn adopt_rotation(
    kind: DocKind,
    state: &StateDir,
    config: &mut Config,
    rotation: &Rotation,
    title: Option<&str>,
    generation: Option<u32>,
    warnings: &mut Vec<String>,
) -> anyhow::Result<()> {
    let old_token = config.token.clone();
    adopt(config, rotation);
    // Before the group state, which the callers save next: a crash in
    // between replays the rotation, but losing the new link would lock the
    // folder out.
    state.save_config(config)?;
    if !kind.listed {
        return Ok(());
    }
    let link: ShareLink = config.link();
    // A headless project seat (see `devices revoke`) is its own root, not a
    // folder the person could open, so it stays out of the folder list.
    let folder = if state.root() == state.dir() {
        Ok(())
    } else {
        user::remember_project(state.root(), &link, None)
    };
    let listed =
        directory::record_rotation(&link, &config.project_id, title, generation, &old_token);
    for err in [folder.err(), listed.err()].into_iter().flatten() {
        warnings.push(format!(
            "could not update the list of your projects: {err:#}"
        ));
    }
    Ok(())
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
