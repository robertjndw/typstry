//! MLS (RFC 9420) membership for a space.
//!
//! The group gives a space what a share link alone cannot: a roster of
//! devices, each with its own signature key and a profile only members can
//! read, so authors are authenticated. It also lets the space's owner
//! remove members, and carries the new links to the members who remain after
//! a removal or a link reset. It does not encrypt documents. Records, blobs
//! and profiles are sealed under the doc keys of the
//! [`crate::crypto::Keyring`], which every link holder can reach anyway (see
//! the `crypto` module for why there is no per-epoch key for content). Doc
//! sync never waits on MLS.
//!
//! A [`SpaceGroup`] is one device's view of the group. Nobody is invited:
//! the link opens the sealed GroupInfo on the server and a newcomer joins
//! with an external commit. The server only orders commits, first one per
//! epoch wins, so every member runs the same [`policy`] on every staged
//! commit before merging it.
//!
//! Commits made here are not merged until the server says `Accepted`:
//! call [`SpaceGroup::confirm_pending`] then. A `Conflict` or a refusal
//! is the only reason to call [`SpaceGroup::discard_pending`]; after a
//! transport error the outcome is unknown, so keep the commit (it is saved
//! with the state) and let the log decide: when it echoes the commit
//! [`SpaceGroup::process_commit`] confirms it, and when another commit
//! won the epoch it discards ours. [`SpaceGroup::pending_submit`] returns
//! what to send again.
//!
//! A member can say whose device it is. Its leaf then carries an identity: a
//! binding by the member's [`DeviceKey`] of the leaf key, and the person's
//! [`PersonGraph`], sealed under the identity key of the keyring (see
//! [`crate::crypto::Keyring::identity_key`]). A device counts for a person as
//! the graph, merged over that person's leaves in the tree, says. Only a leaf
//! whose binding verifies and whose device the graph introduces adds its
//! graph to the merge, so a link holder cannot write into someone else's
//! graph. The leaf keeps its device for life and may only grow its graph.
//!
//! The owner is a person, not a key. The policy holds the owner's tag (see
//! [`crate::crypto::Keyring::owner_tag`]) and an owner is an editor whose
//! leaf identity resolves to that person: a verifying binding by a device
//! that the person's graph, merged over their leaves in the tree as it was
//! before the commit, counts as valid. So the creator's other devices are
//! owners as soon as they are paired, though they can only reset the links
//! once a device holding the space's owner key has handed it over, and a
//! device the person revokes stops being one as soon as any leaf carries the
//! revoke. If the leaves of one person carry graphs that cannot be merged
//! (past the caps), no leaf of that person is verified and nobody is owner
//! on their account, so a revoked device cannot pad its stale branch past
//! the caps to keep its standing; [`policy`] refuses a commit that would
//! put a leaf into that state.
//!
//! Only the owner removes members or rotates the links. Members refuse
//! anyone else's rotation, and the server, which cannot read the group,
//! swaps the tokens only for a rotation signed with the space's owner key
//! (see [`crate::owner`]). That key changes with every rotation, and its
//! secret travels from owner device to owner device in their leaves (see
//! [`owner_share`]): a device of the owner's person is an owner as soon as
//! it is paired, but it can rotate only once a device that holds the key has
//! handed it over ([`IdentityStep::share_owner_key`]). Which key is current
//! is what the server says, with the GroupInfo a device joins from and with
//! every rotation in the log ([`SpaceGroup::owner_key`]), never what the
//! group says; what it says picks a secret but never drops one
//! ([`OwnerSecrets`]). Revoked devices, of anyone, are removed by the owner's
//! devices ([`SpaceGroup::remove_revoked`]).
//!
//! Any editor can still reset a stalled group, and the reset keeps the tag,
//! the owner key and the tokens. Members pin the owner's person id
//! ([`SpaceGroup::owner_person`]) and whoever joins checks the group's tag
//! against it. A device that rejoins after a reset also checks that the new
//! group keeps the keyring and the owner it had, see
//! [`SpaceGroup::join_external_as`].

pub mod extensions;
pub mod owner_share;
pub mod person_share;
pub mod policy;
pub mod rotation;
pub mod storage;

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;

use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::{
    GroupId, LeafNode, LeafNodeIndex, MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY, MlsGroup,
    MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn, MlsMessageIn,
    ProcessedMessageContent, Proposal, ProtocolMessage, Sender as MlsSender, StagedCommit,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize, Serialize};
use zeroize::Zeroizing;

use self::extensions::{
    CIPHERSUITE, EditorInfo, Policy, capabilities, group_extensions, leaf_parameters, read_leaf,
    read_owner_shares, read_person_shares, read_policy,
};
use self::owner_share::{OwnerShares, ShareScope};
pub use self::person_share::PersonSpace;
use self::person_share::{PersonShares, sealable};
use self::policy::{CommitFacts, IdentityFacts, LeafFacts, LeafRole, Removal, Violation};
use self::rotation::{Binding, ROTATION_LABEL, Recipient, Tokens};
pub use self::storage::{LeafKeys, MLS_STATE_VERSION};
use crate::crypto::{
    CryptoError, DocKeys, GROUP_INFO_CONTEXT, IDENTITY_SEAL_CONTEXT, KEY_LEN, Keyring, LinkSecret,
    LocalSigner, PROFILE_CONTEXT, PresenceKey, PublicKey, SealKey, random, verify_attestation,
};
use crate::ds::{ClientMessage, Rotate};
use crate::identity::{
    DeviceKey, DeviceState, GraphError, LeafBinding, LeafIdentity, PersonGraph, PersonId,
};
use crate::mls_frame::{GROUP_ID_LEN, SPACE_ID_LEN, group_id_of, split_group_id};
pub use crate::owner::{Origin, OwnerSecret, OwnerSecrets};
use crate::owner::{OwnerKey, RotationClaim};
use crate::token;

/// Exporter label and context of the presence key.
const PRESENCE_LABEL: &str = "typstry presence";

#[derive(Debug, thiserror::Error)]
pub enum MlsError {
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error("MLS: {0}")]
    Mls(String),
    #[error("{0}")]
    Malformed(String),
    #[error("rotation envelope: {0}")]
    Envelope(String),
    #[error("only an editor with an edit link can do that")]
    NotEditor,
    #[error("only the project owner can do that")]
    NotOwner,
    /// An owner device that has not been handed the current owner key yet.
    #[error("this device does not hold the project's owner key")]
    NoOwnerKey,
    #[error("this device is no longer in the group")]
    NotActive,
    #[error("a commit is still waiting for the server")]
    Pending,
    #[error("no commit is waiting for the server")]
    NoPending,
    #[error("the commit is for epoch {got} but the group is at {expected}")]
    Epoch { expected: u64, got: u64 },
    #[error("the group does not match the link: {0}")]
    Mismatch(String),
    /// Kept apart from [`Self::Mismatch`]: a wrong link is the user's typo,
    /// a different owner is someone taking the space over.
    #[error("the group's owner {0}")]
    OwnerChanged(&'static str),
    /// A group this device rejoins after a reset or a gap does not keep
    /// the keyring it knew: someone with an edit link rebuilt it.
    #[error("the group's keyring does not keep the generations this device knew")]
    Rewritten,
    #[error("no device in the group is revoked")]
    NothingRevoked,
    #[error("no member at leaf {0}, or it is this device")]
    BadLeaf(u32),
    #[error("saved state was written by a newer typstry (format {0}); update typstry to read it")]
    NewerState(u8),
    #[error("the saved join was never confirmed by the server; join again")]
    Unconfirmed,
    #[error(transparent)]
    Identity(#[from] GraphError),
    #[error("this leaf has no identity of its own to build on")]
    NoIdentity,
}

pub(crate) fn mls(e: impl std::fmt::Display) -> MlsError {
    MlsError::Mls(e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// An editor that is a valid device of the owner's person.
    Owner,
    Editor,
    Viewer,
}

/// What a device brings to a space to be recognised as a person's: its
/// own key and the person graph that lists it.
pub struct LocalIdentity {
    pub device: DeviceKey,
    pub graph: PersonGraph,
}

/// Whose device a leaf claims to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Person {
    /// The leaf carries no identity.
    Anonymous,
    /// An identity that this device cannot open or read, whose binding does
    /// not vouch for this leaf's key, or whose device the person's graph
    /// does not list. Never shown as the claimed person.
    Unverified,
    /// A device of the person `id` vouches for the leaf's key and the
    /// person's graph, merged across all of their leaves in this space,
    /// lists it. `revoked` is its verdict there: the device was valid once
    /// and no longer is.
    Verified {
        id: PersonId,
        device: PublicKey,
        revoked: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberInfo {
    pub leaf: u32,
    pub role: Role,
    /// The decrypted profile, `None` when the member has none or this
    /// device lacks the keys of its generation.
    pub profile: Option<Vec<u8>>,
    pub is_self: bool,
    /// The device key that signs this member's records and presence.
    pub sig_pub: PublicKey,
    pub person: Person,
    /// The person's own profile from their merged graph, for a verified
    /// member. Unlike `profile` it is the same in every space.
    pub person_profile: Option<Vec<u8>>,
}

/// The new links a rotation hands to a remaining member.
#[derive(Debug)]
pub struct Rotation {
    pub link: LinkSecret,
    pub tokens: Tokens,
}

/// See [`SpaceGroup::identity_step`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityStep {
    /// The local graph with what the tree knows of the same person merged
    /// in. `None` when the tree adds nothing, so there is nothing to store.
    pub merged: Option<PersonGraph>,
    /// Whether the merged graph (else the local one) holds entries of this
    /// device's person that its own leaf lacks, or, given a personal space,
    /// the leaf's pointer to it is missing or is for another binding or
    /// other recovery keys than the person has now.
    pub needs_refresh: bool,
    /// Whether this device's leaf names another person than `local`, which
    /// lists the leaf's device as valid: the device switched persons since
    /// it joined, e.g. after it became a person of its own by opening a
    /// link before pairing. A leaf cannot change its person in a commit, so
    /// the way over is an external join with the same [`LeafKeys`], which
    /// replaces the old leaf.
    pub rejoin: bool,
    /// [`SpaceGroup::revoked_leaves`] of the tree as it is, for a device
    /// that can remove them: an owner that holds the owner key. Empty for
    /// everyone else, who leaves the removal to the owner.
    pub revoked: Vec<u32>,
    /// Whether this device holds the owner key and another owner device or
    /// recovery key of the owner's has no share of it in any owner's leaf
    /// yet. A [`SpaceGroup::self_update`] puts the shares in. Every
    /// holder sees the same tree, so once one of them has done it the
    /// others find nothing left to do.
    pub share_owner_key: bool,
}

/// What [`SpaceGroup::remove_revoked`] made.
#[derive(Debug, Clone)]
pub struct RevokedRemoval {
    pub submit: SubmitPayload,
    /// The leaves the commit removes.
    pub removed: Vec<u32>,
}

/// What [`SpaceGroup::process_commit`] found.
#[derive(Debug)]
pub enum Outcome {
    /// The commit was valid and merged.
    Advanced,
    /// Merged, and the keys rotated. Switch to the new link and tokens, and
    /// fetch the keyring ([`SpaceGroup::set_keyring`]) when
    /// [`SpaceGroup::needs_keyring`] says so. A member who was not sent
    /// the edit link gets a view link and no edit token. Also the result for
    /// this device's own rotation when the log echoes it before the
    /// `Accepted` reply was seen, in which case the keys are current already.
    Rotated(Box<Rotation>),
    /// The commit removed this device. The group is over for it. `person`
    /// is what the group knew of this device's person as it went, to merge
    /// into the local graph: a device removed because its person revoked it
    /// learns of the revoke here, as it can no longer follow the group.
    Removed { person: Option<PersonGraph> },
    /// The commit breaks the policy or could not be processed, and was not
    /// merged. The group is stalled until an editor resets it. Every member
    /// sees the same, since the server already picked this commit.
    Invalid(String),
    /// A commit for an epoch this device is past already.
    AlreadyApplied,
}

/// The first message of a space: creates its group on the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitPayload {
    pub group_id: Vec<u8>,
    pub group_info: Vec<u8>,
    pub keyring: Vec<u8>,
    /// The public owner key the server checks the first rotation against.
    pub owner_key: OwnerKey,
}

impl InitPayload {
    pub fn into_message(self, req: u64) -> ClientMessage {
        ClientMessage::Init {
            req,
            group_id: self.group_id,
            group_info: self.group_info,
            keyring: self.keyring,
            owner_key: self.owner_key,
        }
    }
}

/// What the server hands a device that joins: the sealed GroupInfo of the
/// head, the signed keyring and the owner key the server holds, all read
/// together.
#[derive(Debug, Clone, Copy)]
pub struct Bootstrap<'a> {
    pub group_info: &'a [u8],
    pub keyring: &'a [u8],
    pub owner_key: &'a OwnerKey,
}

/// Starts a new group when the old one is stuck. It carries no owner key:
/// the server keeps the one it has, so a reset by an editor cannot replace
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetPayload {
    /// The incarnation being replaced, which the server checks.
    pub incarnation: u64,
    pub group_id: Vec<u8>,
    pub group_info: Vec<u8>,
    pub keyring: Vec<u8>,
}

impl ResetPayload {
    pub fn into_message(self, req: u64) -> ClientMessage {
        ClientMessage::Reset {
            req,
            incarnation: self.incarnation,
            group_id: self.group_id,
            group_info: self.group_info,
            keyring: self.keyring,
        }
    }
}

/// A commit for the server, with what goes with it in the same transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitPayload {
    /// The epoch the commit extends.
    pub epoch: u64,
    pub commit: Vec<u8>,
    /// The sealed GroupInfo of the epoch the commit creates.
    pub group_info: Vec<u8>,
    /// A rotation's new signed keyring.
    pub keyring: Option<Vec<u8>>,
    pub envelope: Option<Vec<u8>>,
    /// A rotation's new tokens, which the server swaps in.
    pub rotate: Option<Rotate>,
}

impl SubmitPayload {
    pub fn into_message(self, req: u64) -> ClientMessage {
        ClientMessage::Submit {
            req,
            epoch: self.epoch,
            commit: self.commit,
            group_info: self.group_info,
            keyring: self.keyring,
            envelope: self.envelope,
            rotate: self.rotate,
        }
    }
}

/// The link, keys, tokens and owner key a rotation switches to once the
/// server accepts it.
struct Next {
    link: LinkSecret,
    keys: DocKeys,
    tokens: Tokens,
    owner: OwnerSecret,
}

enum Pending {
    /// A member commit staged in openmls, not merged.
    Commit {
        submit: SubmitPayload,
        next: Option<Box<Next>>,
        profile: Option<Vec<u8>>,
    },
    /// An external commit, already applied to the new group the joiner
    /// holds. If the server refuses it there is nothing to roll back to:
    /// the joiner starts over from a fresh GroupInfo.
    Join { submit: SubmitPayload },
}

pub struct SpaceGroup {
    provider: OpenMlsRustCrypto,
    group: MlsGroup,
    device: LeafKeys,
    link: LinkSecret,
    keys: DocKeys,
    group_id: Vec<u8>,
    /// The member's own profile as it was last committed.
    profile: Vec<u8>,
    /// The owner key secrets this device got, current or not. What the
    /// server says only picks one, it never drops any (see
    /// [`OwnerSecrets`]).
    owner: OwnerSecrets,
    /// The owner key the server holds as of this device's epoch, as the
    /// server last said: the secret in `owner` that derives it is the
    /// current one. `None` for a state saved before the device learnt it.
    owner_key: Option<OwnerKey>,
    pending: Option<Pending>,
    /// Set when a join was refused. The object is spent.
    dead: bool,
}

impl std::fmt::Debug for SpaceGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpaceGroup")
            .field("epoch", &self.epoch())
            .field("link", &self.link)
            .finish_non_exhaustive()
    }
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .use_ratchet_tree_extension(true)
        .build()
}

/// A group id is attacker-influenced (it comes out of a GroupInfo or a saved
/// state) and the incarnation is read off its tail, so its shape is checked
/// where it enters.
fn check_group_id(group_id: &[u8]) -> Result<(), MlsError> {
    if split_group_id(group_id).is_some() {
        Ok(())
    } else {
        Err(MlsError::Mismatch(format!(
            "a group id is {GROUP_ID_LEN} bytes, not {}",
            group_id.len()
        )))
    }
}

/// The sealed identity that makes the space's `leaf` a device of the
/// person in `local`. Refuses a device the graph does not list as valid,
/// which every other member would read as unverified anyway.
fn seal_identity(
    keyring: &Keyring,
    leaf: &LeafKeys,
    local: &LocalIdentity,
) -> Result<Vec<u8>, MlsError> {
    // A recovery device only signs graph entries; a leaf of it would be read
    // as unverified by everyone else anyway.
    if local.graph.device_state(&local.device.public()) != DeviceState::Valid
        || local.graph.is_recovery(&local.device.public())
    {
        return Err(MlsError::Identity(GraphError::NotValid));
    }
    let identity = LeafIdentity {
        binding: LeafBinding::new(&local.device, &leaf.signer_pub()),
        graph: local.graph.clone(),
    };
    Ok(keyring
        .identity_key()
        .seal(&identity.encode(), IDENTITY_SEAL_CONTEXT))
}

/// A leaf's identity, if it has one that opens and decodes.
fn open_identity(key: &SealKey, sealed: &[u8]) -> Option<LeafIdentity> {
    let bytes = key.open(sealed, IDENTITY_SEAL_CONTEXT).ok()?;
    LeafIdentity::decode(&bytes).ok()
}

fn leaf_identity(key: &SealKey, leaf: &LeafNode) -> Option<LeafIdentity> {
    read_leaf(leaf)
        .sealed_identity
        .and_then(|sealed| open_identity(key, &sealed))
}

/// Opening an identity decodes its graph and checks every signature in it,
/// so callers that judge a leaf more than one way open it once with this and
/// pass the result around.
fn identity_facts(key: &SealKey, leaf: &LeafNode) -> Option<IdentityFacts> {
    let sealed = read_leaf(leaf).sealed_identity?;
    let open = open_identity(key, &sealed);
    Some(IdentityFacts { sealed, open })
}

fn opened(identity: Option<&IdentityFacts>) -> Option<&LeafIdentity> {
    identity?.open.as_ref()
}

/// The leaves of the group's members, by index.
fn member_leaves(group: &MlsGroup) -> impl Iterator<Item = (LeafNodeIndex, &LeafNode)> {
    group
        .members()
        .filter_map(|member| Some((member.index, group.public_group().leaf(member.index)?)))
}

/// Every person's graph, merged over all the leaves of a tree that carry
/// one. A device's standing is judged on this, not on its own leaf's copy, so
/// a revocation that one leaf carries reaches the person's others.
///
/// Only a leaf that is one of the person's devices adds to it, see
/// [`vouched_graph`]. Anyone with a link can join with a copy of a person's
/// graph, and were that copy merged in, the leaf could fill the person's
/// graph up to the caps and leave them unable to add or revoke anything.
///
/// A person whose graphs do not merge, e.g. past the caps, maps to `None`
/// and is judged by nobody's copy: every leaf of that person reads
/// unverified. Merging is a union and the caps only grow with it, so which
/// leaves are visited first cannot change the outcome.
#[derive(Clone, Default)]
struct TreeGraphs(BTreeMap<PersonId, Option<PersonGraph>>);

impl TreeGraphs {
    fn of_tree(group: &MlsGroup, key: &SealKey) -> Self {
        Self::of_leaves(key, member_leaves(group).map(|(_, leaf)| leaf))
    }

    fn of_leaves<'l>(key: &SealKey, leaves: impl IntoIterator<Item = &'l LeafNode>) -> Self {
        let mut out = Self::default();
        for leaf in leaves {
            if let Some(identity) = leaf_identity(key, leaf) {
                out.absorb(&identity, signer_pub(leaf).as_ref());
            }
        }
        out
    }

    /// From each leaf's opened identity and its signature key.
    fn of_identities<'i>(
        identities: impl IntoIterator<Item = (&'i LeafIdentity, Option<&'i PublicKey>)>,
    ) -> Self {
        let mut out = Self::default();
        for (identity, sig_pub) in identities {
            out.absorb(identity, sig_pub);
        }
        out
    }

    /// Takes in the graph of a leaf with signature key `sig_pub`, if it
    /// vouches for that leaf.
    fn absorb(&mut self, identity: &LeafIdentity, sig_pub: Option<&PublicKey>) {
        let Some(graph) = vouched_graph(identity, sig_pub) else {
            return;
        };
        match self.0.entry(graph.id()) {
            Entry::Vacant(slot) => {
                slot.insert(Some(graph.clone()));
            }
            Entry::Occupied(mut slot) => {
                let merged = slot.get_mut().take().and_then(|mut known| {
                    known.merge(graph).ok()?;
                    Some(known)
                });
                *slot.get_mut() = merged;
            }
        }
    }

    /// The merged graph of `person`, `None` when no leaf carries one or
    /// they do not merge.
    fn get(&self, person: &PersonId) -> Option<&PersonGraph> {
        self.0.get(person)?.as_ref()
    }

    /// Whether the graph of a leaf merges with what the tree already knows
    /// of its person. One that does not vouch for its leaf never conflicts,
    /// as it is not taken in.
    fn accepts(&self, identity: &LeafIdentity, sig_pub: Option<&PublicKey>) -> bool {
        let Some(graph) = vouched_graph(identity, sig_pub) else {
            return true;
        };
        match self.0.get(&graph.id()) {
            None => true,
            Some(None) => false,
            Some(Some(known)) => known.clone().merge(graph).is_ok(),
        }
    }
}

/// The graph a leaf's identity may contribute to what the tree knows of its
/// person: only one whose binding signs this leaf's key and whose device the
/// graph itself counts as an ordinary device, valid or revoked. A revoked
/// device's leaf still counts, since its stale copy is how a conflict with
/// the person's other leaves comes to light.
fn vouched_graph<'i>(
    identity: &'i LeafIdentity,
    sig_pub: Option<&PublicKey>,
) -> Option<&'i PersonGraph> {
    let device = &identity.binding.device;
    let graph = &identity.graph;
    (sig_pub.is_some_and(|sig| identity.binding.verify(sig))
        && graph.introduces(device)
        && !graph.is_recovery(device))
    .then_some(graph)
}

/// The person graphs the leaves of a group carry, merged per person, read
/// off its sealed GroupInfo without joining. This is how a device that lost
/// all of its own state finds out which person a recovery key belongs to.
/// A person whose leaves do not merge is left out, as
/// [`SpaceGroup::members`] would read all of them unverified.
pub fn graphs_in_group_info(
    link: &LinkSecret,
    sealed_group_info: &[u8],
    keyring: &[u8],
) -> Result<Vec<PersonGraph>, MlsError> {
    let (keyring, _, tree) = tree_of_group_info(link, sealed_group_info, keyring)?;
    let graphs = TreeGraphs::of_leaves(&keyring.identity_key(), tree.leaves());
    Ok(graphs.0.into_values().flatten().collect())
}

/// The owner key share a space's tree holds for the recovery key
/// `recovery`, read off the bootstrap without joining, for a device that
/// recovers to take the key along into [`SpaceGroup::join_external_as`].
/// `None` when no leaf has one for the owner key the server holds.
///
/// Read before the join on purpose. The recovered graph revokes the
/// person's other devices, and once it is in the tree none of their leaves
/// is an owner any more, while theirs are the only shares there are. The
/// rule is the members' one otherwise, with one difference: a share counts
/// from any ordinary device of the owner's, revoked or not, as long as its
/// leaf is an attested editor. A recovery is for when those devices are
/// presumed in the wrong hands, and a revoke the recovery made elsewhere
/// already may have reached this tree. A stolen device can leave a share of
/// a key of its own making here, but only a share that derives the key the
/// server holds is taken, so that costs nothing.
pub fn owner_share_for_recovery(
    link: &LinkSecret,
    boot: Bootstrap<'_>,
    recovery: &DeviceKey,
) -> Result<Option<OwnerSecret>, MlsError> {
    let (keyring, info, tree) = tree_of_group_info(link, boot.group_info, boot.keyring)?;
    let policy = read_policy(info.group_context().extensions()).map_err(MlsError::Mismatch)?;
    let key = keyring.identity_key();
    let graphs = TreeGraphs::of_leaves(&key, tree.leaves());
    let view = OwnerView::new(&keyring, &policy, &graphs);
    let crypto = OpenMlsRustCrypto::default();
    Ok(tree.leaves().find_map(|leaf| {
        let identity = leaf_identity(&key, leaf);
        view.device_of(leaf, identity.as_ref())?;
        if editor_role(leaf, &policy, Standing::Existing) != LeafRole::Editor {
            return None;
        }
        let shares = read_owner_shares(leaf).filter(|s| s.owner_key == *boot.owner_key)?;
        let scope = ShareScope {
            group_id: info.group_id().as_slice(),
            sender: &signer_pub(leaf)?,
        };
        shares.open_recovery(crypto.crypto(), &scope, recovery)
    }))
}

/// Every personal space binding a space's tree holds for the recovery key
/// `recovery`, read off a sealed GroupInfo and its keyring without joining,
/// for a device that recovers through a link to any project of the
/// person's. See [`person_share`].
///
/// Only leaves of the recovery key's own person count, and only valid
/// devices of it, so a pointer comes from a device that was the person's.
/// An entry that does not open is skipped. Devices can disagree, e.g. two
/// personal spaces made on devices that never met, and a stolen device can
/// plant a pointer of its own, so this does not choose: it returns each
/// distinct pointer once, the one most leaves carry first, ties broken by
/// the rightmost leaf. The caller tries them in order and keeps the first
/// the server confirms.
pub fn person_spaces_for_recovery(
    link: &LinkSecret,
    sealed_group_info: &[u8],
    keyring: &[u8],
    recovery: &DeviceKey,
) -> Result<Vec<PersonSpace>, MlsError> {
    let (keyring, info, tree) = tree_of_group_info(link, sealed_group_info, keyring)?;
    let key = keyring.identity_key();
    let graphs = TreeGraphs::of_leaves(&key, tree.leaves());
    let public = recovery.public();
    let Some(graph) = graphs
        .0
        .values()
        .flatten()
        .find(|g| g.is_recovery(&public) && g.device_state(&public) == DeviceState::Valid)
    else {
        return Ok(Vec::new());
    };
    let crypto = OpenMlsRustCrypto::default();
    // (pointer, leaves carrying it, rightmost leaf position)
    let mut found: Vec<(PersonSpace, usize, usize)> = Vec::new();
    for (position, leaf) in tree.leaves().enumerate() {
        let opened = (|| {
            let signer = signer_pub(leaf)?;
            let identity = leaf_identity(&key, leaf)?;
            let device = identity.binding.device;
            if !(identity.binding.verify(&signer)
                && identity.graph.id() == graph.id()
                && graph.introduces(&device)
                && !graph.is_recovery(&device)
                && graph.device_state(&device) == DeviceState::Valid)
            {
                return None;
            }
            let scope = ShareScope {
                group_id: info.group_id().as_slice(),
                sender: &signer,
            };
            read_person_shares(leaf)?.open_recovery(crypto.crypto(), &scope, recovery)
        })();
        let Some(space) = opened else { continue };
        match found.iter_mut().find(|(s, _, _)| *s == space) {
            Some(entry) => {
                entry.1 += 1;
                entry.2 = position;
            }
            None => found.push((space, 1, position)),
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    Ok(found.into_iter().map(|(space, _, _)| space).collect())
}

/// The keyring, GroupInfo and verified ratchet tree of a sealed GroupInfo.
fn tree_of_group_info(
    link: &LinkSecret,
    sealed_group_info: &[u8],
    keyring: &[u8],
) -> Result<(Keyring, VerifiableGroupInfo, openmls::treesync::RatchetTree), MlsError> {
    let keyring = Keyring::open_verified(link, keyring)?;
    let info = parse_group_info(&link.gi_key().open(sealed_group_info, GROUP_INFO_CONTEXT)?)?;
    check_group_id(info.group_id().as_slice())?;
    let tree = info
        .extensions()
        .ratchet_tree()
        .ok_or_else(|| MlsError::Malformed("the GroupInfo carries no ratchet tree".into()))?
        .ratchet_tree()
        .clone()
        // Checks the leaf signatures and the structure of the tree, which the
        // join does the same way.
        .into_verified(
            info.ciphersuite(),
            OpenMlsRustCrypto::default().crypto(),
            info.group_id(),
        )
        .map_err(mls)?;
    Ok((keyring, info, tree))
}

/// `identity` is the leaf's, from [`identity_facts`].
fn person_of(identity: Option<&IdentityFacts>, graphs: &TreeGraphs, sig_pub: &PublicKey) -> Person {
    let Some(identity) = identity else {
        return Person::Anonymous;
    };
    let Some(identity) = &identity.open else {
        return Person::Unverified;
    };
    if !identity.binding.verify(sig_pub) {
        return Person::Unverified;
    }
    let id = identity.graph.id();
    let device = identity.binding.device;
    let Some(graph) = graphs.get(&id) else {
        return Person::Unverified;
    };
    if graph.is_recovery(&device) {
        return Person::Unverified;
    }
    match graph.device_state(&device) {
        DeviceState::Valid => Person::Verified {
            id,
            device,
            revoked: false,
        },
        DeviceState::Revoked => Person::Verified {
            id,
            device,
            revoked: true,
        },
        DeviceState::Unknown => Person::Unverified,
    }
}

/// One pass over a tree's identities, see [`SpaceGroup::tree_identities`].
struct TreeIdentities {
    own: LeafNodeIndex,
    leaves: Vec<(LeafNodeIndex, Option<PublicKey>, Option<IdentityFacts>)>,
    graphs: TreeGraphs,
    /// Every leaf the tree shows as an owner, with its signature key and the
    /// owner key shares it carries.
    owners: Vec<(LeafNodeIndex, PublicKey, Option<OwnerShares>)>,
    /// The valid recovery keys of the owner's person.
    recovery: Vec<PublicKey>,
}

impl TreeIdentities {
    fn own_identity(&self) -> Option<&LeafIdentity> {
        self.leaves
            .iter()
            .find(|(index, ..)| *index == self.own)
            .and_then(|(_, _, identity)| opened(identity.as_ref()))
    }

    fn persons(&self) -> impl Iterator<Item = (LeafNodeIndex, Person)> + '_ {
        self.leaves.iter().filter_map(|(index, sig_pub, identity)| {
            Some((
                *index,
                person_of(identity.as_ref(), &self.graphs, sig_pub.as_ref()?),
            ))
        })
    }

    fn revoked(&self) -> Vec<u32> {
        self.persons()
            .filter(|(index, person)| {
                *index != self.own && matches!(person, Person::Verified { revoked: true, .. })
            })
            .map(|(index, _)| index.u32())
            .collect()
    }

    /// Whether an owner leaf other than this device's, or a recovery key of
    /// the owner's, lacks a share of `owner_key` in every owner's leaf. A
    /// leaf that carries shares of that key holds the key itself, as the
    /// creator's does without ever being sent it.
    fn owner_share_missing(&self, owner_key: &OwnerKey) -> bool {
        let current: Vec<&OwnerShares> = self
            .owners
            .iter()
            .filter_map(|(_, _, shares)| shares.as_ref())
            .filter(|shares| shares.owner_key == *owner_key)
            .collect();
        let leaf_missing = self.owners.iter().any(|(index, signer, shares)| {
            *index != self.own
                && !shares.as_ref().is_some_and(|s| s.owner_key == *owner_key)
                && !current.iter().any(|shares| shares.covers_leaf(signer))
        });
        let recovery_missing = self
            .recovery
            .iter()
            .any(|key| !current.iter().any(|shares| shares.covers_recovery(key)));
        leaf_missing || recovery_missing
    }
}

fn signer_pub(leaf: &LeafNode) -> Option<PublicKey> {
    leaf.signature_key().as_slice().try_into().ok()
}

/// How old an editor attestation may be for its leaf to count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    /// A leaf that is already in the tree and unchanged. A rotation does not
    /// touch the leaves of the editors who stay, so they keep the
    /// attestation of the generation they joined or last refreshed in.
    Existing,
    /// A leaf a commit puts into the tree: a joiner's, or a member's new
    /// path leaf. It has to be attested for the current generation, or a
    /// removed editor could come back with an old attestation and a view
    /// link of the current one and be taken for an editor again.
    New,
}

/// X25519 public keys are 32 bytes. Anything else cannot be an HPKE key to
/// seal the edit link to, and is no editor.
const HPKE_PUB_LEN: usize = 32;

/// What the editor extension of a leaf makes its holder, judged against the
/// policy: a viewer, an editor, or invalid. Owners are editors too, see
/// [`leaf_role`].
fn editor_role(leaf: &LeafNode, policy: &Policy, standing: Standing) -> LeafRole {
    let editor = match read_leaf(leaf).editor {
        Ok(Some(editor)) => editor,
        Ok(None) => return LeafRole::Viewer,
        Err(_) => return LeafRole::Invalid,
    };
    let Some(signer) = signer_pub(leaf) else {
        return LeafRole::Invalid;
    };
    if standing == Standing::New && editor.generation != policy.generation() {
        return LeafRole::Invalid;
    }
    let attested = policy.attest_pub(editor.generation).is_some_and(|key| {
        verify_attestation(key, &signer, editor.generation, &editor.attestation)
    });
    if attested && editor.hpke_pub.len() == HPKE_PUB_LEN {
        LeafRole::Editor
    } else {
        LeafRole::Invalid
    }
}

/// `identity` is the leaf's opened identity.
fn leaf_role(
    leaf: &LeafNode,
    identity: Option<&LeafIdentity>,
    policy: &Policy,
    standing: Standing,
    owner: &OwnerView,
) -> LeafRole {
    match editor_role(leaf, policy, standing) {
        LeafRole::Editor if owner.owns(leaf, identity) => LeafRole::Owner,
        role => role,
    }
}

/// What is known of the owner's person from a tree: the graphs of all
/// leaves whose person matches the policy's tag, merged.
///
/// It is built from the tree alone, never from what a device keeps locally,
/// so every member reaches the same verdict. There is no owner when no leaf
/// is the owner's person, as after a reset until the owner's devices rejoin,
/// or when their graphs do not merge.
struct OwnerView(Option<PersonGraph>);

impl OwnerView {
    fn new(keyring: &Keyring, policy: &Policy, graphs: &TreeGraphs) -> Self {
        Self(
            graphs
                .0
                .iter()
                .find(|(id, _)| keyring.owner_tag(id) == policy.owner_tag)
                .and_then(|(_, graph)| graph.clone()),
        )
    }

    /// Whether the leaf's device is a valid device of the owner's person and
    /// its binding vouches for the leaf key. `identity` is the leaf's opened
    /// identity.
    fn owns(&self, leaf: &LeafNode, identity: Option<&LeafIdentity>) -> bool {
        self.device_of(leaf, identity)
            .is_some_and(|(graph, device)| graph.device_state(&device) == DeviceState::Valid)
    }

    /// The owner's graph and the leaf's device, when the leaf's binding
    /// vouches for it and the graph counts it as an ordinary device of the
    /// owner's, valid or revoked.
    fn device_of(
        &self,
        leaf: &LeafNode,
        identity: Option<&LeafIdentity>,
    ) -> Option<(&PersonGraph, PublicKey)> {
        let (Some(graph), Some(signer), Some(identity)) = (&self.0, signer_pub(leaf), identity)
        else {
            return None;
        };
        let device = identity.binding.device;
        (identity.binding.verify(&signer)
            && identity.graph.id() == graph.id()
            && graph.introduces(&device)
            && !graph.is_recovery(&device))
        .then_some((graph, device))
    }

    /// The owner's valid recovery keys, which owner key shares are sealed to
    /// as well.
    fn recovery_keys(&self) -> Vec<PublicKey> {
        self.0.as_ref().map_or_else(Vec::new, valid_recovery_keys)
    }
}

/// The valid recovery keys of a person's graph.
fn valid_recovery_keys(graph: &PersonGraph) -> Vec<PublicKey> {
    graph
        .devices()
        .into_iter()
        .filter(|d| d.recovery && d.state == DeviceState::Valid)
        .map(|d| d.device)
        .collect()
}

/// Refuses a group whose owner is not the person this device pinned.
fn check_owner(
    policy: &Policy,
    keyring: &Keyring,
    pinned: Option<PersonId>,
) -> Result<(), MlsError> {
    if pinned.is_some_and(|person| policy.owner_tag != keyring.owner_tag(&person)) {
        return Err(MlsError::OwnerChanged("is not the one this device pinned"));
    }
    Ok(())
}

/// What a joining leaf claims, which tests forge, and what the join checks
/// the group against.
#[derive(Default)]
struct JoinOptions {
    editor: Option<EditorInfo>,
    identity: Option<Vec<u8>>,
    /// The owner's person, as this device first saw it for the space.
    pinned_owner: Option<PersonId>,
    /// The owner key secrets the joiner takes along.
    owner: OwnerSecrets,
    lineage: Option<Lineage>,
}

/// What a device knew of a space before it rejoins, which the new group
/// has to keep (see [`SpaceGroup::join_external_as`]).
struct Lineage {
    keyring: Keyring,
    /// `None` when the old state had no readable policy.
    owner_tag: Option<[u8; KEY_LEN]>,
}

impl Lineage {
    fn check(&self, keyring: &Keyring, policy: &Policy) -> Result<(), MlsError> {
        if !keyring.extends(&self.keyring) {
            return Err(MlsError::Rewritten);
        }
        if self.owner_tag.is_some_and(|tag| tag != policy.owner_tag) {
            return Err(MlsError::OwnerChanged("is not the one this device knew"));
        }
        Ok(())
    }
}

fn parse_protocol(bytes: &[u8]) -> Result<ProtocolMessage, String> {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|e| e.to_string())?
        .try_into_protocol_message()
        .map_err(|e| e.to_string())
}

fn parse_group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, MlsError> {
    match MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(mls)?
        .extract()
    {
        MlsMessageBodyIn::GroupInfo(info) => Ok(info),
        _ => Err(MlsError::Malformed("not a GroupInfo".into())),
    }
}

/// Reads the facts the policy needs off a staged commit.
///
/// Everything is read from the tree as it is before the commit, plus the
/// graph of the sender's new path leaf for judging that leaf, and never from
/// local state, so that every member gets the same facts.
fn commit_facts<'a>(
    group: &MlsGroup,
    sender: &MlsSender,
    staged: &StagedCommit,
    before: &'a Policy,
    after: Option<&'a Policy>,
    keyring: &Keyring,
) -> Result<CommitFacts<'a>, String> {
    let tree = group.public_group();
    let judge = after.unwrap_or(before);
    let identity_key = keyring.identity_key();
    let graphs = TreeGraphs::of_tree(group, &identity_key);
    let owner = OwnerView::new(keyring, before, &graphs);
    let new_leaf = staged.update_path_leaf_node();
    let new_identity = new_leaf.and_then(|leaf| identity_facts(&identity_key, leaf));
    // What the tree knows once the new leaf is in. The removed leaves are
    // still counted: a device's standing does not depend on whether its own
    // leaf is about to go.
    let new_signer = new_leaf.and_then(signer_pub);
    let mut graphs_after = graphs.clone();
    if let Some(identity) = opened(new_identity.as_ref()) {
        graphs_after.absorb(identity, new_signer.as_ref());
    }
    // A graph of the owner's person that does not merge with the rest leaves
    // no owner, so the new leaf cannot be judged on its own copy.
    let owner_after = OwnerView::new(keyring, before, &graphs_after);
    let path_leaf = new_leaf.map(|leaf| {
        let open = opened(new_identity.as_ref());
        LeafFacts {
            signer: leaf.signature_key().as_slice().to_vec(),
            role: leaf_role(leaf, open, judge, Standing::New, &owner_after),
            mergeable: open.is_none_or(|identity| graphs.accepts(identity, new_signer.as_ref())),
            identity: new_identity,
        }
    });

    let (sender, sender_signer, sender_identity, same_key_leaves) = match sender {
        MlsSender::Member(index) => {
            let leaf = tree.leaf(*index).ok_or("sender is not in the tree")?;
            let identity = identity_facts(&identity_key, leaf);
            let role = leaf_role(
                leaf,
                opened(identity.as_ref()),
                before,
                Standing::Existing,
                &owner,
            );
            (
                policy::Sender::Member {
                    leaf: index.u32(),
                    role,
                },
                Some(leaf.signature_key().as_slice().to_vec()),
                identity,
                0,
            )
        }
        MlsSender::NewMemberCommit => {
            let same = path_leaf.as_ref().map_or(0, |leaf| {
                group
                    .members()
                    .filter(|m| m.signature_key == leaf.signer)
                    .count()
            });
            (policy::Sender::External, None, None, same)
        }
        _ => return Err("commit from a sender typstry does not use".into()),
    };

    let mut facts = CommitFacts {
        sender,
        sender_signer,
        sender_identity,
        before,
        after,
        adds: 0,
        updates: 0,
        group_context_proposals: 0,
        other_proposals: 0,
        removals: Vec::new(),
        same_key_leaves,
        path_leaf,
    };
    for queued in staged.queued_proposals() {
        match queued.proposal() {
            Proposal::Add(_) => facts.adds += 1,
            Proposal::Update(_) => facts.updates += 1,
            Proposal::GroupContextExtensions(_) => facts.group_context_proposals += 1,
            Proposal::ExternalInit(_) => {}
            Proposal::Remove(remove) => {
                let index = remove.removed();
                let leaf = tree.leaf(index).ok_or("removes a leaf that is not there")?;
                facts.removals.push(Removal {
                    leaf: index.u32(),
                    signer: leaf.signature_key().as_slice().to_vec(),
                });
            }
            _ => facts.other_proposals += 1,
        }
    }
    Ok(facts)
}

impl SpaceGroup {
    /// Creates the group of a new space from a fresh edit link: this
    /// device as the only member, generation 1 keys, and the payload for
    /// the server's `Init`.
    ///
    /// The creator's person becomes the space's owner for good, so a
    /// space cannot be created without an identity: it would have no owner
    /// to remove anyone. This device starts out holding the owner key, the
    /// public half of which goes to the server with the payload.
    pub fn create(
        link: &LinkSecret,
        profile: &[u8],
        identity: &LocalIdentity,
    ) -> Result<(Self, InitPayload), MlsError> {
        let space_id: [u8; SPACE_ID_LEN] = random();
        let keyring = Keyring::new(link);
        let policy = Policy::new(link.attest_pub(), keyring.owner_tag(&identity.graph.id()));
        let device = LeafKeys::generate();
        let sealed = seal_identity(&keyring, &device, identity)?;
        let owner = OwnerSecret::generate();
        let owner_key = owner.public();
        let (group, group_info, keyring_bytes) = Self::start(
            device,
            link,
            keyring,
            policy,
            group_id_of(&space_id, 0),
            profile,
            Some(sealed),
            (
                [(owner, Origin::Made)].into_iter().collect(),
                Some(owner_key),
            ),
        )?;
        let payload = InitPayload {
            group_id: group.group_id.clone(),
            group_info,
            keyring: keyring_bytes,
            owner_key,
        };
        Ok((group, payload))
    }

    /// The cleartext person id of the space's owner, i.e. the person in
    /// the tree whose tag the policy holds. Callers pin it the first time
    /// they see the space and pass it to later joins. `None` when none of
    /// the owner's devices is in the group, as after a reset until they
    /// rejoin.
    pub fn owner_person(&self) -> Option<PersonId> {
        let policy = self.policy().ok()?;
        let keyring = self.keys.keyring();
        let graphs = TreeGraphs::of_tree(&self.group, &keyring.identity_key());
        graphs
            .0
            .keys()
            .find(|id| keyring.owner_tag(id) == policy.owner_tag)
            .copied()
    }

    /// Starts over with a new group of the same space when the current one
    /// is stuck, e.g. after an invalid commit. The link, the keys, the device
    /// and the policy with its owner tag stay; only the roster is rebuilt, as
    /// everyone rejoins. Any editor may do it, so it never grants anyone the
    /// owner role: an owner is the owner's person, which this device's
    /// identity is only if it is one of theirs. This device's identity
    /// carries over; `identity` replaces it, e.g. to bring in a graph the
    /// group had not seen. So does the owner key it holds, which the server
    /// keeps through the reset.
    pub fn reset(
        &self,
        profile: &[u8],
        identity: Option<&LocalIdentity>,
    ) -> Result<(Self, ResetPayload), MlsError> {
        self.ensure_editor()?;
        let policy = self.policy()?;
        let sealed = match identity {
            Some(local) => Some(seal_identity(self.keys.keyring(), &self.device, local)?),
            None => self.own_identity(),
        };
        let incarnation = self.incarnation();
        let next = group_id_of(&self.space_id(), incarnation + 1);
        let (group, group_info, keyring) = Self::start(
            self.device.duplicate(),
            &self.link,
            self.keys.keyring().clone(),
            policy,
            next,
            profile,
            sealed,
            (self.owner.clone(), self.owner_key),
        )?;
        let payload = ResetPayload {
            incarnation: u64::from(incarnation),
            group_id: group.group_id.clone(),
            group_info,
            keyring,
        };
        Ok((group, payload))
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        device: LeafKeys,
        link: &LinkSecret,
        keyring: Keyring,
        policy: Policy,
        group_id: Vec<u8>,
        profile: &[u8],
        sealed_identity: Option<Vec<u8>>,
        (owner, owner_key): (OwnerSecrets, Option<OwnerKey>),
    ) -> Result<(Self, Vec<u8>, Vec<u8>), MlsError> {
        if !link.can_attest() {
            return Err(MlsError::NotEditor);
        }
        let keys = DocKeys::new(keyring);
        let provider = OpenMlsRustCrypto::default();
        let signer = device.signature_pair();
        let editor = editor_info(&device, link, policy.generation())?;
        let leaf_exts = extensions::leaf_extensions(
            Some(&editor),
            keys.seal(profile, PROFILE_CONTEXT),
            sealed_identity,
            None,
            None,
        )
        .map_err(MlsError::Malformed)?;
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .capabilities(capabilities())
            .with_group_context_extensions(group_extensions(&policy).map_err(MlsError::Malformed)?)
            .with_leaf_node_extensions(leaf_exts)
            .map_err(mls)?
            .build();
        let group = MlsGroup::new_with_group_id(
            &provider,
            &signer,
            &config,
            GroupId::from_slice(&group_id),
            device.credential(),
        )
        .map_err(mls)?;
        let group_info = sealed_group_info(&group, &provider, &signer, link)?;
        let keyring_bytes = keys.keyring().seal_signed(link)?;
        let this = Self {
            provider,
            group,
            device,
            link: link.clone(),
            keys,
            group_id,
            profile: profile.to_vec(),
            owner,
            owner_key,
            pending: None,
            dead: false,
        };
        Ok((this, group_info, keyring_bytes))
    }

    /// Joins an existing group with an external commit, as a new device.
    ///
    /// `pinned_owner` is the owner's person id as this device first saw it
    /// for the space, if it has one (see [`Self::owner_person`]): a group
    /// whose owner tag is not that person's is refused. An owner's device
    /// joins as the owner by presenting its identity, with no key to bring.
    pub fn join_external(
        link: &LinkSecret,
        boot: Bootstrap<'_>,
        profile: &[u8],
        identity: Option<&LocalIdentity>,
        pinned_owner: Option<PersonId>,
    ) -> Result<(Self, SubmitPayload), MlsError> {
        Self::join_external_as(
            LeafKeys::generate(),
            link,
            boot,
            profile,
            identity,
            pinned_owner,
            None,
            &OwnerSecrets::default(),
        )
    }

    /// [`Self::join_external`] with a known device. Rejoining with the
    /// device of lost or abandoned state is a resync: the commit replaces
    /// that device's old leaf. A different key would leave it behind.
    ///
    /// `previous` is the group state this device rejoins from, e.g. after a
    /// reset or a gap in the log, if it still has it. The new group has to
    /// keep what that one had: every generation of its keyring, unchanged,
    /// and its owner tag. Any editor can reset the group with a GroupInfo
    /// and keyring of their making, and this is what keeps such a reset from
    /// rewriting the space's history or its owner for those who knew it.
    ///
    /// The owner key secrets `previous` held are taken along, and so are
    /// `owner_keys` (copies kept beside the state, or one opened with
    /// [`owner_share_for_recovery`]), all of them whichever key the server
    /// says it holds: a server that names the wrong one must not get the
    /// right one dropped. The one that derives the server's key is used.
    /// Once joined, a share the tree holds for this leaf stands in when none
    /// does.
    ///
    /// The payload goes to the server as is. If it answers `Conflict`, call
    /// [`Self::discard_pending`], drop this value and join again from the
    /// GroupInfo of the new head.
    #[allow(clippy::too_many_arguments)]
    pub fn join_external_as(
        device: LeafKeys,
        link: &LinkSecret,
        boot: Bootstrap<'_>,
        profile: &[u8],
        identity: Option<&LocalIdentity>,
        pinned_owner: Option<PersonId>,
        previous: Option<&SpaceGroup>,
        owner_keys: &OwnerSecrets,
    ) -> Result<(Self, SubmitPayload), MlsError> {
        let keyring = Keyring::open_verified(link, boot.keyring)?;
        let editor = if link.can_attest() {
            Some(editor_info(&device, link, keyring.generation())?)
        } else {
            None
        };
        // Checked against what the GroupInfo says now, before the join is
        // built, so a wrong pin fails early; the verified policy is checked
        // again after.
        let policy = read_policy(
            parse_group_info(&link.gi_key().open(boot.group_info, GROUP_INFO_CONTEXT)?)?
                .group_context()
                .extensions(),
        )
        .map_err(MlsError::Mismatch)?;
        check_owner(&policy, &keyring, pinned_owner)?;
        let identity = identity
            .map(|local| seal_identity(&keyring, &device, local))
            .transpose()?;
        // The old state's own come first, as it knows best which are newer;
        // the copies fill what room is left, except for the one the server
        // holds, which is never left out for want of room.
        let mut owner = previous
            .map(|group| group.owner.clone())
            .unwrap_or_default();
        owner.take_from(owner_keys, boot.owner_key);
        owner.extend_older(owner_keys);
        let lineage = previous.map(|group| Lineage {
            keyring: group.keys.keyring().clone(),
            owner_tag: group.policy().ok().map(|policy| policy.owner_tag),
        });
        Self::join_with(
            device,
            link,
            boot,
            keyring,
            profile,
            JoinOptions {
                editor,
                identity,
                pinned_owner,
                owner,
                lineage,
            },
        )
    }

    /// The join with the leaf's claims and sealed identity chosen by the
    /// caller, which tests use to forge them.
    fn join_with(
        device: LeafKeys,
        link: &LinkSecret,
        boot: Bootstrap<'_>,
        keyring: Keyring,
        profile: &[u8],
        options: JoinOptions,
    ) -> Result<(Self, SubmitPayload), MlsError> {
        let info = parse_group_info(&link.gi_key().open(boot.group_info, GROUP_INFO_CONTEXT)?)?;
        let keys = DocKeys::new(keyring);
        let provider = OpenMlsRustCrypto::default();
        let signer = device.signature_pair();
        let params = leaf_parameters(
            options.editor.as_ref(),
            keys.seal(profile, PROFILE_CONTEXT),
            options.identity,
            None,
            None,
        )
        .map_err(MlsError::Malformed)?;
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(join_config())
            .build_group(&provider, info, device.credential())
            .map_err(mls)?
            .leaf_node_parameters(params)
            .load_psks(provider.storage())
            .map_err(mls)?
            .build(provider.rand(), provider.crypto(), &signer, |_| true)
            .map_err(mls)?
            .finalize(&provider)
            .map_err(mls)?;

        // The sealed GroupInfo is only as good as whoever could seal it, so
        // check that group and keyring are the same generation.
        let group_id = group.group_id().as_slice().to_vec();
        check_group_id(&group_id)?;
        let policy = read_policy(group.extensions()).map_err(MlsError::Mismatch)?;
        if policy.attest_pubs != keys.keyring().attest_pubs() {
            return Err(MlsError::Mismatch(
                "the group's generation differs from the keyring's".into(),
            ));
        }
        check_owner(&policy, keys.keyring(), options.pinned_owner)?;
        if let Some(lineage) = &options.lineage {
            lineage.check(keys.keyring(), &policy)?;
        }

        let commit = bundle.commit().tls_serialize_detached().map_err(mls)?;
        let submit = SubmitPayload {
            epoch: group.epoch().as_u64() - 1,
            commit,
            group_info: sealed_group_info(&group, &provider, &signer, link)?,
            keyring: None,
            envelope: None,
            rotate: None,
        };
        let mut this = Self {
            provider,
            group,
            device,
            link: link.clone(),
            keys,
            group_id,
            profile: profile.to_vec(),
            owner: options.owner,
            owner_key: Some(*boot.owner_key),
            pending: Some(Pending::Join {
                submit: submit.clone(),
            }),
            dead: false,
        };
        // A resync keeps the leaf key, so what the owner's devices sealed to
        // the old leaf opens for the new one.
        this.absorb_owner_share();
        Ok((this, submit))
    }

    pub fn group_id(&self) -> &[u8] {
        &self.group_id
    }

    /// The incarnation, the last four bytes of the group id.
    pub fn incarnation(&self) -> u32 {
        split_group_id(&self.group_id)
            .expect("the group id was checked on the way in")
            .1
    }

    fn space_id(&self) -> [u8; SPACE_ID_LEN] {
        split_group_id(&self.group_id)
            .expect("the group id was checked on the way in")
            .0
            .try_into()
            .expect("a space id has a fixed length")
    }

    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    /// Whether this device is still a member.
    pub fn is_active(&self) -> bool {
        !self.dead && self.group.is_active()
    }

    pub fn device(&self) -> &LeafKeys {
        &self.device
    }

    /// The link this device holds now, which changes on a rotation.
    pub fn link(&self) -> &LinkSecret {
        &self.link
    }

    /// The doc keys. After a rotation they are the old ones until
    /// [`Self::set_keyring`] gets the new keyring.
    pub fn doc_keys(&self) -> &DocKeys {
        &self.keys
    }

    pub fn generation(&self) -> Result<u32, MlsError> {
        Ok(self.policy()?.generation())
    }

    /// Whether the group has rotated past the keyring this device holds.
    pub fn needs_keyring(&self) -> bool {
        self.policy()
            .is_ok_and(|policy| policy.generation() > self.keys.generation())
    }

    /// Takes the keyring the server holds, after a rotation. It has to be
    /// signed by the link this device holds and agree with the group.
    pub fn set_keyring(&mut self, signed: &[u8]) -> Result<(), MlsError> {
        let keyring = Keyring::open_verified(&self.link, signed)?;
        if keyring.attest_pubs() != self.policy()?.attest_pubs {
            return Err(MlsError::Mismatch(
                "the keyring is not the group's generation".into(),
            ));
        }
        self.keys = DocKeys::new(keyring);
        Ok(())
    }

    /// A signer for records and presence. It attests with the current link,
    /// so editors can write and viewers cannot. Take a new one whenever the
    /// link may have changed.
    pub fn signer(&self) -> LocalSigner {
        let attestation = self.policy().ok().and_then(|policy| {
            let generation = policy.generation();
            self.link
                .attest(&self.device.signer_pub(), generation)
                .ok()
                .map(|attestation| (generation, attestation))
        });
        LocalSigner::from_key(self.device.signing_key().clone(), attestation)
    }

    /// This epoch's presence key.
    pub fn presence_key(&self) -> Result<PresenceKey, MlsError> {
        let secret = self
            .group
            .export_secret(self.provider.crypto(), PRESENCE_LABEL, &[], KEY_LEN)
            .map_err(mls)?;
        Ok(PresenceKey::new(
            self.epoch(),
            secret.try_into().expect("asked for 32 bytes"),
        ))
    }

    /// This device's leaf, which presence names it by.
    pub fn own_leaf(&self) -> u32 {
        self.group.own_leaf_index().u32()
    }

    /// The device key of each leaf in this epoch, for [`PresenceKey::open`].
    pub fn signer_of(&self, leaf: u32) -> Option<PublicKey> {
        signer_pub(self.group.public_group().leaf(LeafNodeIndex::new(leaf))?)
    }

    /// The leaf and device key of every member, without opening profiles
    /// the way [`Self::members`] does. Enough for a presence roster.
    pub fn signers(&self) -> impl Iterator<Item = (u32, PublicKey)> + '_ {
        member_leaves(&self.group)
            .filter_map(|(index, leaf)| Some((index.u32(), signer_pub(leaf)?)))
    }

    pub fn members(&self) -> Result<Vec<MemberInfo>, MlsError> {
        let policy = self.policy()?;
        let own = self.group.own_leaf_index();
        let identity_key = self.keys.keyring().identity_key();
        let leaves: Vec<_> = member_leaves(&self.group)
            .map(|(index, leaf)| {
                let identity = identity_facts(&identity_key, leaf);
                (index, leaf, signer_pub(leaf), identity)
            })
            .collect();
        let graphs =
            TreeGraphs::of_identities(leaves.iter().filter_map(|(_, _, sig, identity)| {
                Some((opened(identity.as_ref())?, sig.as_ref()))
            }));
        let owner = OwnerView::new(self.keys.keyring(), &policy, &graphs);
        let mut out = Vec::new();
        for (index, leaf, sig_pub, identity) in &leaves {
            let Some(sig_pub) = *sig_pub else {
                continue;
            };
            let identity = identity.as_ref();
            let role = match leaf_role(leaf, opened(identity), &policy, Standing::Existing, &owner)
            {
                LeafRole::Owner => Role::Owner,
                LeafRole::Editor => Role::Editor,
                _ => Role::Viewer,
            };
            let profile = read_leaf(leaf)
                .sealed_profile
                .and_then(|sealed| self.keys.open(&sealed, PROFILE_CONTEXT).ok());
            let person = person_of(identity, &graphs, &sig_pub);
            let person_profile = match person {
                Person::Verified { id, .. } => graphs
                    .get(&id)
                    .and_then(|graph| graph.profile())
                    .map(<[u8]>::to_vec),
                _ => None,
            };
            out.push(MemberInfo {
                leaf: index.u32(),
                role,
                profile,
                is_self: *index == own,
                sig_pub,
                person,
                person_profile,
            });
        }
        Ok(out)
    }

    /// The leaves, other than this device's own, that an identity ties to
    /// `person`. A removal of the person is a removal of all of them.
    pub fn leaves_of(&self, person: &PersonId) -> Result<Vec<u32>, MlsError> {
        Ok(self
            .members()?
            .into_iter()
            .filter(|m| {
                !m.is_self && matches!(m.person, Person::Verified { id, .. } if id == *person)
            })
            .map(|m| m.leaf)
            .collect())
    }

    /// What the tree's leaves together know of `person`: their graphs,
    /// merged. `None` when no leaf carries one, or when they do not merge.
    #[cfg(test)]
    pub fn person_graph(&self, person: &PersonId) -> Option<PersonGraph> {
        let key = self.keys.keyring().identity_key();
        TreeGraphs::of_tree(&self.group, &key).get(person).cloned()
    }

    /// This device's own leaf identity as it is in the tree.
    fn own_identity(&self) -> Option<Vec<u8>> {
        read_leaf(self.group.own_leaf_node()?).sealed_identity
    }

    /// What the tree knows of this device's own person once `staged` is in,
    /// including a revoke the commit's own path carries. Read before merging,
    /// since a commit that removes this device takes its view of the tree
    /// with it.
    fn own_person_after(&self, staged: &StagedCommit) -> Option<PersonGraph> {
        let person = self.own_identity_open()?.graph.id();
        let key = self.keys.keyring().identity_key();
        let mut graphs = TreeGraphs::of_tree(&self.group, &key);
        if let Some(leaf) = staged.update_path_leaf_node()
            && let Some(identity) = leaf_identity(&key, leaf)
        {
            graphs.absorb(&identity, signer_pub(leaf).as_ref());
        }
        graphs.get(&person).cloned()
    }

    fn own_identity_open(&self) -> Option<LeafIdentity> {
        let key = self.keys.keyring().identity_key();
        leaf_identity(&key, self.group.own_leaf_node()?)
    }

    /// Whether `local` knows entries of this device's person that its own
    /// leaf lacks, e.g. a device added or revoked since the leaf was last
    /// committed. [`Self::self_update`] with `local` puts them in.
    #[cfg(test)]
    pub fn needs_identity_refresh(&self, local: &PersonGraph) -> bool {
        self.is_active()
            && self.link.can_attest()
            && self
                .own_identity_open()
                .is_some_and(|own| own.graph.id() == local.id() && !own.graph.is_superset_of(local))
    }

    /// The leaves the tree shows as revoked devices, of whichever person,
    /// i.e. what [`Self::remove_revoked`] removes.
    pub fn revoked_leaves(&self) -> Vec<u32> {
        self.tree_identities().revoked()
    }

    /// What one device does to keep its identity in line with its person,
    /// decided in one pass over the tree. `local` is the person graph the
    /// device stores.
    ///
    /// Run it after catching up. Store [`IdentityStep::merged`] when there
    /// is one, commit [`Self::self_update`] with the graph it was judged on
    /// when [`IdentityStep::needs_refresh`] or
    /// [`IdentityStep::share_owner_key`], and remove
    /// [`IdentityStep::revoked`] with [`Self::remove_revoked`]. On
    /// [`IdentityStep::rejoin`] do none of that and join again with
    /// [`Self::join_external_as`] and the same device instead. A refresh
    /// changes the tree, which can make more leaves read revoked, so after
    /// committing one run this again rather than acting on the old answer.
    /// Whether the device may commit at all (a writer, nothing pending) is
    /// the caller's to check.
    ///
    /// Fails with [`MlsError::Identity`] when the tree's copy of the person
    /// does not merge with `local`, e.g. past the caps.
    pub fn identity_step(
        &self,
        local: &PersonGraph,
        space: Option<&PersonSpace>,
    ) -> Result<IdentityStep, MlsError> {
        let tree = self.tree_identities();
        let merged = match tree.graphs.get(&local.id()) {
            Some(seen) if !local.is_superset_of(seen) => {
                let mut merged = local.clone();
                merged.merge(seen)?;
                Some(merged)
            }
            _ => None,
        };
        let current = merged.as_ref().unwrap_or(local);
        let can_refresh = self.is_active() && self.link.can_attest();
        let needs_refresh = can_refresh
            && tree.own_identity().is_some_and(|own| {
                own.graph.id() == current.id() && !own.graph.is_superset_of(current)
            });
        // The personal space pointer is stale when it names another
        // binding or other recovery keys than the person has now. Judged
        // on the person's graph as merged, which is what the refresh will
        // seal to. Leaves that never had one and have no key to seal to are
        // fine as they are.
        let person_stale = can_refresh
            && space.is_some_and(|space| {
                let wanted = valid_recovery_keys(current);
                let carried = self.group.own_leaf_node().and_then(read_person_shares);
                match carried {
                    Some(carried) => !carried.is_current(space, &wanted),
                    None => !sealable(&wanted).is_empty(),
                }
            });
        let rejoin = self.is_active()
            && tree.own_identity().is_some_and(|own| {
                own.graph.id() != local.id()
                    && local.device_state(&own.binding.device) == DeviceState::Valid
            });
        // Same as holds_owner_key, but reuses the tree judged above.
        let holder = self.ensure_owner_key().is_ok()
            && self.ensure_editor().is_ok()
            && tree.owners.iter().any(|(index, ..)| *index == tree.own);
        Ok(IdentityStep {
            needs_refresh: needs_refresh || person_stale,
            rejoin,
            revoked: if holder { tree.revoked() } else { Vec::new() },
            share_owner_key: holder
                && self
                    .owner_key
                    .is_some_and(|key| tree.owner_share_missing(&key)),
            merged,
        })
    }

    /// Every member leaf with its identity opened once, and the graphs they
    /// carry merged per person.
    fn tree_identities(&self) -> TreeIdentities {
        let key = self.keys.keyring().identity_key();
        let leaves: Vec<_> = member_leaves(&self.group)
            .map(|(index, leaf)| (index, signer_pub(leaf), identity_facts(&key, leaf)))
            .collect();
        let graphs = TreeGraphs::of_identities(
            leaves
                .iter()
                .filter_map(|(_, sig, identity)| Some((opened(identity.as_ref())?, sig.as_ref()))),
        );
        let (owners, recovery) = match self.policy() {
            Ok(policy) => {
                let view = OwnerView::new(self.keys.keyring(), &policy, &graphs);
                let owners = member_leaves(&self.group)
                    .zip(&leaves)
                    .filter_map(|((index, leaf), (_, signer, identity))| {
                        let identity = opened(identity.as_ref());
                        let role = leaf_role(leaf, identity, &policy, Standing::Existing, &view);
                        (role == LeafRole::Owner)
                            .then(|| Some((index, (*signer)?, read_owner_shares(leaf))))
                            .flatten()
                    })
                    .collect();
                (owners, view.recovery_keys())
            }
            Err(_) => (Vec::new(), Vec::new()),
        };
        TreeIdentities {
            own: self.group.own_leaf_index(),
            leaves,
            graphs,
            owners,
            recovery,
        }
    }

    fn policy(&self) -> Result<Policy, MlsError> {
        read_policy(self.group.extensions()).map_err(MlsError::Malformed)
    }

    fn ensure_alive(&self) -> Result<(), MlsError> {
        if self.is_active() {
            Ok(())
        } else {
            Err(MlsError::NotActive)
        }
    }

    fn ensure_editor(&self) -> Result<(), MlsError> {
        self.ensure_alive()?;
        let leaf = self.group.own_leaf_node().ok_or(MlsError::NotActive)?;
        if self.link.can_attest()
            && editor_role(leaf, &self.policy()?, Standing::Existing) == LeafRole::Editor
        {
            Ok(())
        } else {
            Err(MlsError::NotEditor)
        }
    }

    /// Editor, and an owner by what the tree shows, which is what every
    /// other member judges by. A device the owner's person has only just
    /// paired is one as soon as its leaf is in the tree.
    fn ensure_owner(&self) -> Result<(), MlsError> {
        self.ensure_editor()?;
        let leaf = self.group.own_leaf_node().ok_or(MlsError::NotActive)?;
        let policy = self.policy()?;
        let keyring = self.keys.keyring();
        let key = keyring.identity_key();
        let graphs = TreeGraphs::of_tree(&self.group, &key);
        let owner = OwnerView::new(keyring, &policy, &graphs);
        let identity = leaf_identity(&key, leaf);
        let role = leaf_role(leaf, identity.as_ref(), &policy, Standing::Existing, &owner);
        if role == LeafRole::Owner {
            Ok(())
        } else {
            Err(MlsError::NotOwner)
        }
    }

    /// Whether this device can rotate: an owner by the tree, holding the
    /// secret of the owner key the server holds.
    pub fn holds_owner_key(&self) -> bool {
        // The key lookup first: most devices hold none, and the owner check
        // opens every leaf of the tree.
        self.ensure_owner_key().is_ok() && self.ensure_owner().is_ok()
    }

    /// The owner key secret that derives [`Self::owner_key`], if this
    /// device holds it.
    pub fn owner_secret(&self) -> Option<&OwnerSecret> {
        self.owner.find(&self.owner_key?)
    }

    /// Every owner key secret this device holds, current or not, for a
    /// client to keep beside the group state (see [`OwnerSecrets::encode`])
    /// and to take along into [`Self::join_external_as`]: a lost state must
    /// not take the only copy with it, and which one is current is only
    /// what the server says.
    pub fn owner_secrets(&self) -> &OwnerSecrets {
        &self.owner
    }

    /// Takes owner key secrets kept outside the group, like the copies in
    /// the person's directory, the same way a join takes them along. Local
    /// only, nothing is committed: which key is current is still what the
    /// server says, and a secret of no key it names is merely kept.
    pub fn keep_owner_secrets(&mut self, held: &OwnerSecrets) {
        if let Some(current) = self.owner_key {
            self.owner.take_from(held, &current);
        }
        self.owner.extend_older(held);
    }

    /// The owner key the server holds, as of this device's epoch: what it
    /// said with the GroupInfo this device joined from, and with each
    /// rotation in the log since.
    pub fn owner_key(&self) -> Option<OwnerKey> {
        self.owner_key
    }

    fn ensure_owner_key(&self) -> Result<(), MlsError> {
        self.owner_secret().map(drop).ok_or(MlsError::NoOwnerKey)
    }

    /// Takes the share of the server's owner key that an owner's leaf holds
    /// for this one, unless this device has that key already. Only a leaf
    /// the tree shows as an owner counts, and only a share that derives the
    /// server's key: anyone with an edit link can put shares in their leaf,
    /// and an owner device in the wrong hands can put in one of a key of its
    /// own making. Neither is a key the server knows, so neither can stand
    /// in for the real one or keep it from being taken. What it opens is
    /// added to what this device holds, never put in place of any of it: a
    /// server that names a stale key gets the stale share opened, and the
    /// newer secret has to survive that.
    fn absorb_owner_share(&mut self) {
        let Ok(policy) = self.policy() else {
            return;
        };
        let Some(current) = self.owner_key else {
            return;
        };
        if self.ensure_owner_key().is_ok() {
            return;
        }
        let own = self.group.own_leaf_index();
        let signer = self.device.signer_pub();
        // Runs after every commit, and most devices are never sent a share.
        // Judging owners opens every leaf's identity, so only do that once
        // some leaf actually carries a share of the current key for us.
        let offered: Vec<_> = member_leaves(&self.group)
            .filter(|(index, _)| *index != own)
            .filter_map(|(_, leaf)| {
                let shares = read_owner_shares(leaf)
                    .filter(|s| s.owner_key == current && s.covers_leaf(&signer))?;
                Some((leaf, shares))
            })
            .collect();
        if offered.is_empty() {
            return;
        }
        let key = self.keys.keyring().identity_key();
        let graphs = TreeGraphs::of_tree(&self.group, &key);
        let view = OwnerView::new(self.keys.keyring(), &policy, &graphs);
        let found = offered.into_iter().find_map(|(leaf, shares)| {
            let identity = leaf_identity(&key, leaf);
            if leaf_role(leaf, identity.as_ref(), &policy, Standing::Existing, &view)
                != LeafRole::Owner
            {
                return None;
            }
            let scope = ShareScope {
                group_id: &self.group_id,
                sender: &signer_pub(leaf)?,
            };
            shares.open_leaf(
                self.provider.crypto(),
                &scope,
                &signer,
                self.device.hpke_private(),
            )
        });
        if let Some(found) = found {
            self.owner.add(found, Origin::Received);
        }
    }

    /// The owner key shares of `secret` for this device's next leaf, sealed
    /// to every other owner leaf except `removed` and to the owner's
    /// recovery keys, as the tree shows them once the leaf carries
    /// `identity`. `None` when there is nobody to send them to.
    fn owner_shares_for(
        &self,
        secret: &OwnerSecret,
        policy: &Policy,
        identity: Option<&[u8]>,
        removed: &[LeafNodeIndex],
    ) -> Option<Vec<u8>> {
        let key = self.keys.keyring().identity_key();
        let mut graphs = TreeGraphs::of_tree(&self.group, &key);
        let own_signer = self.device.signer_pub();
        if let Some(open) = identity.and_then(|sealed| open_identity(&key, sealed)) {
            graphs.absorb(&open, Some(&own_signer));
        }
        let view = OwnerView::new(self.keys.keyring(), policy, &graphs);
        let own = self.group.own_leaf_index();
        let leaves: Vec<Recipient> = member_leaves(&self.group)
            .filter(|(index, _)| *index != own && !removed.contains(index))
            .filter_map(|(_, leaf)| {
                let identity = leaf_identity(&key, leaf);
                if leaf_role(leaf, identity.as_ref(), policy, Standing::Existing, &view)
                    != LeafRole::Owner
                {
                    return None;
                }
                Some(Recipient {
                    signer: signer_pub(leaf)?,
                    hpke_pub: read_leaf(leaf).editor.ok()??.hpke_pub,
                })
            })
            .collect();
        let recovery = view.recovery_keys();
        if leaves.is_empty() && recovery.is_empty() {
            return None;
        }
        let scope = ShareScope {
            group_id: &self.group_id,
            sender: &own_signer,
        };
        Some(OwnerShares::seal(self.provider.crypto(), &scope, secret, &leaves, &recovery).encode())
    }

    /// The encoded personal space pointer for this device's next leaf.
    /// With a `space`, sealed to the valid recovery keys of the person the
    /// leaf will show (`identity`, else the leaf's own), and `None` when
    /// there is none. Without, the pointer the leaf has now.
    fn person_shares_for(
        &self,
        space: Option<&PersonSpace>,
        identity: Option<&[u8]>,
    ) -> Option<Vec<u8>> {
        let own = self.group.own_leaf_node()?;
        let Some(space) = space else {
            return own
                .extensions()
                .unknown(extensions::EXT_PERSON_SHARES)
                .map(|ext| ext.0.clone());
        };
        let key = self.keys.keyring().identity_key();
        let graph = match identity {
            Some(sealed) => open_identity(&key, sealed)?.graph,
            None => leaf_identity(&key, own)?.graph,
        };
        let recovery = valid_recovery_keys(&graph);
        if sealable(&recovery).is_empty() {
            return None;
        }
        let scope = ShareScope {
            group_id: &self.group_id,
            sender: &self.device.signer_pub(),
        };
        Some(PersonShares::seal(self.provider.crypto(), &scope, space, &recovery).encode())
    }

    fn ensure_idle(&self) -> Result<(), MlsError> {
        self.ensure_alive()?;
        if self.pending.is_some() {
            return Err(MlsError::Pending);
        }
        Ok(())
    }

    /// Refreshes this editor's leaf: a new profile, and the attestation of
    /// the current link. Viewers cannot commit; they change their profile by
    /// joining again with the same device.
    ///
    /// The leaf keeps the identity it has, with its graph extended by `graph`
    /// when one is given (see [`Self::identity_step`]). The device and the
    /// person never change, and a graph of another person is refused.
    ///
    /// With a personal `space` the leaf's pointer to it is sealed anew to
    /// the person's recovery keys, as the identity the leaf will carry shows
    /// them. Without, whatever pointer the leaf has stays as it is: it is
    /// bound to the group and the leaf key, neither of which a refresh
    /// changes.
    pub fn self_update(
        &mut self,
        profile: &[u8],
        graph: Option<&PersonGraph>,
        space: Option<&PersonSpace>,
    ) -> Result<SubmitPayload, MlsError> {
        self.ensure_idle()?;
        self.ensure_editor()?;
        let policy = self.policy()?;
        let editor = editor_info(&self.device, &self.link, policy.generation())?;
        let identity = match graph {
            None => self.own_identity(),
            Some(graph) => Some(self.extended_identity(graph)?),
        };
        self.commit_leaf(Some(editor), profile, identity, space)
    }

    /// This leaf's identity with `graph` merged into its graph. The binding
    /// stays as it is, since only the device key can sign a new one.
    fn extended_identity(&self, graph: &PersonGraph) -> Result<Vec<u8>, MlsError> {
        let mut own = self.own_identity_open().ok_or(MlsError::NoIdentity)?;
        own.graph.merge(graph)?;
        Ok(self
            .keys
            .keyring()
            .identity_key()
            .seal(&own.encode(), IDENTITY_SEAL_CONTEXT))
    }

    /// A commit that only replaces this device's leaf. Whether the device
    /// may commit is the caller's business, and the policy of everyone
    /// else's. An owner that holds the owner key puts its shares in the new
    /// leaf, so every commit of it hands the key on.
    fn commit_leaf(
        &mut self,
        editor: Option<EditorInfo>,
        profile: &[u8],
        identity: Option<Vec<u8>>,
        space: Option<&PersonSpace>,
    ) -> Result<SubmitPayload, MlsError> {
        // Only the current one: the older ones stay with this device, and
        // sealing them would only hand out keys that sign nothing.
        let shares = match self.owner_secret() {
            Some(owner) if self.holds_owner_key() => {
                self.owner_shares_for(owner, &self.policy()?, identity.as_deref(), &[])
            }
            _ => None,
        };
        let person = self.person_shares_for(space, identity.as_deref());
        self.commit_leaf_with(editor, profile, identity, shares, person)
    }

    /// [`Self::commit_leaf`] with the owner shares chosen by the caller,
    /// which tests use to forge them.
    fn commit_leaf_with(
        &mut self,
        editor: Option<EditorInfo>,
        profile: &[u8],
        identity: Option<Vec<u8>>,
        shares: Option<Vec<u8>>,
        person_shares: Option<Vec<u8>>,
    ) -> Result<SubmitPayload, MlsError> {
        let params = leaf_parameters(
            editor.as_ref(),
            self.keys.seal(profile, PROFILE_CONTEXT),
            identity,
            shares,
            person_shares,
        )
        .map_err(MlsError::Malformed)?;
        let signer = self.device.signature_pair();
        let bundle = self
            .group
            .commit_builder()
            .leaf_node_parameters(params)
            .load_psks(self.provider.storage())
            .map_err(mls)?
            .use_ratchet_tree_extension(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &signer,
                |_| true,
            )
            .map_err(mls)?
            .stage_commit(&self.provider)
            .map_err(mls)?;
        let epoch = self.epoch();
        let commit = bundle.commit().tls_serialize_detached().map_err(mls)?;
        let info = bundle
            .into_group_info_msg()
            .ok_or_else(|| mls("no group info"))?;
        let info = info.tls_serialize_detached().map_err(mls)?;
        let submit = SubmitPayload {
            epoch,
            commit,
            group_info: self.link.gi_key().seal(&info, GROUP_INFO_CONTEXT),
            keyring: None,
            envelope: None,
            rotate: None,
        };
        self.pending = Some(Pending::Commit {
            submit: submit.clone(),
            next: None,
            profile: Some(profile.to_vec()),
        });
        Ok(submit)
    }

    /// Removes the members at `leaves` and rotates the keys in one commit,
    /// so what the removed members hold stops being the space's links.
    /// Only the remaining members learn the new ones (see [`rotation`]), and
    /// only the remaining owner devices the next owner key. Owner only, and
    /// [`MlsError::NoOwnerKey`] for an owner device that does not hold the
    /// current owner key yet.
    pub fn remove_and_rotate(&mut self, leaves: &[u32]) -> Result<SubmitPayload, MlsError> {
        self.ensure_idle()?;
        self.ensure_owner()?;
        self.ensure_owner_key()?;
        self.rotate(leaves)
    }

    /// [`Self::remove_and_rotate`] for every leaf the tree's merged graphs
    /// show as a revoked device, of whichever person, saying which leaves
    /// the commit removes. A revoke takes nothing away by itself: the device
    /// still holds the links and could rejoin with them, so only a rotation
    /// finishes it, and only the owner rotates. Others commit the revoke to
    /// their own leaf ([`Self::self_update`]) and leave the rest to the
    /// owner's devices, which run this whenever [`IdentityStep::revoked`]
    /// says so. Fails with [`MlsError::NothingRevoked`] if there is no such
    /// leaf.
    pub fn remove_revoked(&mut self) -> Result<RevokedRemoval, MlsError> {
        self.ensure_idle()?;
        self.ensure_owner()?;
        self.ensure_owner_key()?;
        let removed = self.revoked_leaves();
        if removed.is_empty() {
            return Err(MlsError::NothingRevoked);
        }
        let submit = self.rotate(&removed)?;
        Ok(RevokedRemoval { submit, removed })
    }

    /// The removal and rotation after the checks. Tests use it to make the
    /// commit a modified client would, so the other members' side is what
    /// gets exercised.
    fn rotate(&mut self, leaves: &[u32]) -> Result<SubmitPayload, MlsError> {
        self.rotate_with(leaves, self.own_identity())
    }

    /// [`Self::rotate`] with the sealed identity of the committer's new
    /// leaf chosen by the caller, which tests use to carry a revoke in the
    /// rotation that acts on it.
    fn rotate_with(
        &mut self,
        leaves: &[u32],
        identity: Option<Vec<u8>>,
    ) -> Result<SubmitPayload, MlsError> {
        let own = self.group.own_leaf_index();
        let mut removed = Vec::with_capacity(leaves.len());
        for &leaf in leaves {
            let index = LeafNodeIndex::new(leaf);
            if index == own || self.group.public_group().leaf(index).is_none() {
                return Err(MlsError::BadLeaf(leaf));
            }
            removed.push(index);
        }

        let policy = self.policy()?;
        let link = LinkSecret::generate_edit();
        let keyring = self.keys.keyring().next(&link);
        let next_policy = policy.next(link.attest_pub());
        let keys = DocKeys::new(keyring);
        let tokens = Tokens {
            edit: Some(token::generate()),
            view: token::generate(),
        };
        let next_owner = OwnerSecret::generate();
        let shares = self.owner_shares_for(&next_owner, &policy, identity.as_deref(), &removed);

        // Our own leaf moves to the new generation with the commit, so the
        // roster never shows the committer attested by a retired link.
        let generation = next_policy.generation();
        let editor = editor_info(&self.device, &link, generation)?;
        // A rotation keeps the leaf key and the group id, so the pointer
        // still opens as it is.
        let person = self.person_shares_for(None, None);
        let params = leaf_parameters(
            Some(&editor),
            keys.seal(&self.profile, PROFILE_CONTEXT),
            identity,
            shares,
            person,
        )
        .map_err(MlsError::Malformed)?;
        let recipients = self.remaining_editors(&policy, &removed);

        let signer = self.device.signature_pair();
        let bundle = self
            .group
            .commit_builder()
            .propose_removals(removed)
            .propose_group_context_extensions(
                group_extensions(&next_policy).map_err(MlsError::Malformed)?,
            )
            .map_err(mls)?
            .leaf_node_parameters(params)
            .load_psks(self.provider.storage())
            .map_err(mls)?
            .use_ratchet_tree_extension(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &signer,
                |_| true,
            )
            .map_err(mls)?
            .stage_commit(&self.provider)
            .map_err(mls)?;
        let epoch = self.epoch();
        let commit = bundle.commit().tls_serialize_detached().map_err(mls)?;
        let info = bundle
            .into_group_info_msg()
            .ok_or_else(|| mls("no group info"))?;
        let info = info.tls_serialize_detached().map_err(mls)?;

        let binding = Binding {
            group_id: &self.group_id,
            epoch: epoch + 1,
            commit: &commit,
        };
        let exporter = self
            .group
            .pending_commit()
            .ok_or_else(|| mls("commit was not staged"))?
            .export_secret(
                self.provider.crypto(),
                ROTATION_LABEL,
                &binding.digest(),
                KEY_LEN,
            )
            .map_err(mls)?;
        let envelope = rotation::seal(
            self.provider.crypto(),
            &exporter.try_into().expect("asked for 32 bytes"),
            &binding,
            &link,
            &tokens,
            &recipients,
        )?;

        // Sealed for the new link: that is who can join from now on.
        let group_info = link.gi_key().seal(&info, GROUP_INFO_CONTEXT);
        let keyring = keys.keyring().seal_signed(&link)?;
        let edit_token = tokens.edit.clone().expect("generated above");
        let next_owner_key = next_owner.public();
        let claim = RotationClaim {
            group_id: &self.group_id,
            epoch,
            commit: &commit,
            group_info: &group_info,
            keyring: &keyring,
            envelope: &envelope,
            edit_token: &edit_token,
            view_token: &tokens.view,
            next_owner_key: &next_owner_key,
        };
        // Without the current key there is nothing to sign with. Only the
        // checks of the public entry points keep such a device from getting
        // here, and the server refuses what it would send.
        let owner_proof = self
            .owner_secret()
            .or_else(|| self.owner.iter().next())
            .map_or([0; crate::owner::OWNER_PROOF_LEN], |owner| {
                owner.sign(&claim)
            });
        let submit = SubmitPayload {
            epoch,
            group_info,
            keyring: Some(keyring),
            envelope: Some(envelope),
            rotate: Some(Rotate {
                edit_token,
                view_token: tokens.view.clone(),
                next_owner_key,
                owner_proof,
            }),
            commit,
        };
        self.pending = Some(Pending::Commit {
            submit: submit.clone(),
            next: Some(Box::new(Next {
                link,
                keys,
                tokens,
                owner: next_owner,
            })),
            profile: None,
        });
        Ok(submit)
    }

    /// Replaces the links without removing anyone, for a link that leaked.
    /// Everyone in the group gets the new ones. Owner only, like a removal.
    pub fn reset_links(&mut self) -> Result<SubmitPayload, MlsError> {
        self.remove_and_rotate(&[])
    }

    /// The editors that stay and are not this device, with the keys the edit
    /// link is sent to.
    fn remaining_editors(&self, policy: &Policy, removed: &[LeafNodeIndex]) -> Vec<Recipient> {
        let own = self.group.own_leaf_index();
        self.group
            .members()
            .filter(|m| m.index != own && !removed.contains(&m.index))
            .filter_map(|m| {
                let leaf = self.group.public_group().leaf(m.index)?;
                if editor_role(leaf, policy, Standing::Existing) != LeafRole::Editor {
                    return None;
                }
                let editor = read_leaf(leaf).editor.ok()??;
                Some(Recipient {
                    signer: signer_pub(leaf)?,
                    hpke_pub: editor.hpke_pub,
                })
            })
            .collect()
    }

    /// The server accepted what this device submitted last: make it real.
    /// For a rotation this device made, returns the new link and tokens it
    /// switched to.
    pub fn confirm_pending(&mut self) -> Result<Option<Rotation>, MlsError> {
        let mut rotation = None;
        match self.pending.take().ok_or(MlsError::NoPending)? {
            Pending::Join { .. } => {}
            Pending::Commit { next, profile, .. } => {
                self.group
                    .merge_pending_commit(&self.provider)
                    .map_err(mls)?;
                if let Some(next) = next.map(|next| *next) {
                    let Next {
                        link,
                        keys,
                        tokens,
                        owner,
                    } = next;
                    self.link = link.clone();
                    self.keys = keys;
                    // What the server swapped in when it accepted: the
                    // proof it checked names this key and no other.
                    self.owner_key = Some(owner.public());
                    self.owner.add(owner, Origin::Made);
                    rotation = Some(Rotation { link, tokens });
                }
                if let Some(profile) = profile {
                    self.profile = profile;
                }
            }
        }
        Ok(rotation)
    }

    /// The server refused what was submitted, or another commit won the
    /// epoch: forget it. Not for a transport error, which leaves it unknown
    /// whether the commit landed. A refused join leaves this value spent,
    /// since the group it built never existed.
    pub fn discard_pending(&mut self) -> Result<(), MlsError> {
        match self.pending.take().ok_or(MlsError::NoPending)? {
            Pending::Join { .. } => self.dead = true,
            Pending::Commit { .. } => self
                .group
                .clear_pending_commit(self.provider.storage())
                .map_err(mls)?,
        }
        Ok(())
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// What was submitted last and is still waiting for the server, to send
    /// again after a lost reply. The server answers `Conflict` when the
    /// commit already landed; then catch up from the log instead of
    /// discarding.
    pub fn pending_submit(&self) -> Option<&SubmitPayload> {
        match self.pending.as_ref()? {
            Pending::Join { submit } | Pending::Commit { submit, .. } => Some(submit),
        }
    }

    /// Applies a commit from the server's log. `epoch` is the epoch it
    /// extends, `envelope` and `owner_key` what came with it; the server
    /// sends the owner key it moved on to with each rotation.
    ///
    /// `owner_key` only counts with a rotation the group takes, by someone
    /// else: a commit that rotates nothing moved no key on, whatever the
    /// server says, and for this device's own rotation the key is the one
    /// it signed for. That way a lie about the key lasts until the next
    /// rotation or join at most, and costs no secret either way (see
    /// [`OwnerSecrets`]). A rotation the group refuses leaves the group
    /// stuck before it, so whatever it moved the server on to comes with the
    /// bootstrap of the join that follows.
    ///
    /// The policy is checked before anything is merged; a refused commit
    /// leaves the group exactly as it was. A commit that wins an epoch this
    /// device had a commit pending for discards that commit first.
    pub fn process_commit(
        &mut self,
        epoch: u64,
        commit: &[u8],
        envelope: Option<&[u8]>,
        owner_key: Option<&OwnerKey>,
    ) -> Result<Outcome, MlsError> {
        let outcome = self.process_commit_inner(epoch, commit, envelope, owner_key)?;
        if !matches!(outcome, Outcome::AlreadyApplied | Outcome::Removed { .. }) {
            self.absorb_owner_share();
        }
        Ok(outcome)
    }

    fn process_commit_inner(
        &mut self,
        epoch: u64,
        commit: &[u8],
        envelope: Option<&[u8]>,
        owner_key: Option<&OwnerKey>,
    ) -> Result<Outcome, MlsError> {
        self.ensure_alive()?;
        let current = self.epoch();
        let ours = self
            .pending_submit()
            .is_some_and(|submit| submit.commit == commit);
        match &self.pending {
            Some(Pending::Join { .. }) => {
                // The joiner is already one epoch ahead of the commit it
                // made, which is the one the log delivers back.
                if epoch + 1 == current {
                    if !ours {
                        // Someone else's commit took the epoch.
                        self.discard_pending()?;
                        return Err(MlsError::NotActive);
                    }
                    self.confirm_pending()?;
                    return Ok(Outcome::Advanced);
                }
                // A commit extending the joiner's epoch only exists if the
                // join was accepted, whether or not the reply got through.
                if epoch == current {
                    self.confirm_pending()?;
                }
            }
            Some(Pending::Commit { .. }) if epoch == current => {
                if !ours {
                    self.discard_pending()?;
                } else {
                    return Ok(match self.confirm_pending()? {
                        Some(rotation) => Outcome::Rotated(Box::new(rotation)),
                        None => Outcome::Advanced,
                    });
                }
            }
            _ => {}
        }
        let current = self.epoch();
        if epoch < current {
            return Ok(Outcome::AlreadyApplied);
        }
        if epoch > current {
            return Err(MlsError::Epoch {
                expected: current,
                got: epoch,
            });
        }
        let invalid = |why: String| Ok(Outcome::Invalid(why));
        let message = match parse_protocol(commit) {
            Ok(message) => message,
            Err(why) => return invalid(why),
        };
        let processed = match self.group.process_message(&self.provider, message) {
            Ok(processed) => processed,
            Err(why) => return invalid(why.to_string()),
        };
        let sender = processed.sender().clone();
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return invalid("not a commit".into());
        };

        let before = self.policy()?;
        let after = read_policy(staged.group_context().extensions()).ok();
        let rotates = match commit_facts(
            &self.group,
            &sender,
            &staged,
            &before,
            after.as_ref(),
            self.keys.keyring(),
        )
        .map_err(Violation::Unreadable)
        .and_then(|facts| policy::check(&facts))
        {
            Ok(rotates) => rotates,
            Err(why) => return invalid(why.to_string()),
        };

        // The new links are read before merging, so a rotation whose shared
        // part is bad is refused by every member alike (see
        // `rotation::open`) and leaves the group where it was. Only a
        // member's own edit entry can fail privately, and that costs it the
        // edit link, not the commit.
        let mut opened = None;
        if rotates && !staged.self_removed() {
            let after = after.as_ref().expect("a rotation has a policy");
            match self.open_envelope(&staged, commit, envelope, after) {
                Ok(link) => opened = Some(link),
                Err(why) => return invalid(why),
            }
        }

        if rotates {
            // A rotation the server took without saying where it moved the
            // key leaves this device not knowing it, rather than trusting
            // the one before, which signs nothing any more.
            self.owner_key = owner_key.copied();
        }
        let person = if staged.self_removed() {
            self.own_person_after(&staged)
        } else {
            None
        };
        self.group
            .merge_staged_commit(&self.provider, *staged)
            .map_err(mls)?;
        if !self.group.is_active() {
            return Ok(Outcome::Removed { person });
        }
        Ok(match opened {
            Some(rotation::Opened { link, tokens }) => {
                self.link = link.clone();
                Outcome::Rotated(Box::new(Rotation { link, tokens }))
            }
            None => Outcome::Advanced,
        })
    }

    fn open_envelope(
        &self,
        staged: &StagedCommit,
        commit: &[u8],
        envelope: Option<&[u8]>,
        after: &Policy,
    ) -> Result<rotation::Opened, String> {
        let envelope = envelope.ok_or("a rotation came without its envelope")?;
        let binding = Binding {
            group_id: &self.group_id,
            epoch: self.epoch() + 1,
            commit,
        };
        let exporter = staged
            .export_secret(
                self.provider.crypto(),
                ROTATION_LABEL,
                &binding.digest(),
                KEY_LEN,
            )
            .map_err(|e| e.to_string())?;
        let opened = rotation::open(
            self.provider.crypto(),
            &exporter.try_into().expect("asked for 32 bytes"),
            &binding,
            &self.device.signer_pub(),
            self.device.hpke_private(),
            envelope,
        )
        .map_err(|e| e.to_string())?;
        // A link that is not the group's newest attestation key would leave
        // this device unable to read or write anything.
        if after.attest_pubs.last() != Some(&opened.link.attest_pub()) {
            return Err("the envelope's link does not belong to the new generation".into());
        }
        Ok(opened)
    }

    /// Saves everything needed to come back to this group: the device, the
    /// link, the keyring, the profile and openmls' own state.
    ///
    /// A commit waiting for the server is saved with it, including the new
    /// link of a rotation, since the `Accepted` reply may be lost and the
    /// log is what settles it (see [`Self::process_commit`]). A join waiting
    /// for the server saves as unconfirmed and refuses to load.
    pub fn export_state(&self) -> Zeroizing<Vec<u8>> {
        let pending = match &self.pending {
            Some(Pending::Commit {
                submit,
                next,
                profile,
            }) => Some(storage::SavedPending {
                submit: submit.clone(),
                next: next.as_ref().map(|next| storage::SavedNext {
                    link: next.link.to_base64url(),
                    keyring: next.keys.keyring().export(),
                    tokens: next.tokens.clone(),
                    owner: next.owner.clone(),
                }),
                profile: profile.clone(),
            }),
            _ => None,
        };
        storage::encode(&storage::SavedState {
            group_id: self.group_id.clone(),
            device: self.device.duplicate(),
            link: self.link.to_base64url(),
            keyring: self.keys.keyring().export(),
            profile: self.profile.clone(),
            owner: self.owner.clone(),
            owner_key: self.owner_key,
            unconfirmed_join: matches!(self.pending, Some(Pending::Join { .. })),
            pending,
            entries: storage::dump(&self.provider),
        })
    }

    pub fn import_state(bytes: &[u8]) -> Result<Self, MlsError> {
        let state = storage::decode(bytes)?;
        if state.unconfirmed_join {
            return Err(MlsError::Unconfirmed);
        }
        check_group_id(&state.group_id)?;
        let provider = storage::restore(state.entries);
        let mut group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&state.group_id))
            .map_err(mls)?
            .ok_or_else(|| MlsError::Malformed("saved state has no group".into()))?;
        let pending = match state.pending {
            Some(saved) if group.pending_commit().is_some() => {
                let next = saved
                    .next
                    .map(|next| -> Result<_, MlsError> {
                        Ok(Box::new(Next {
                            link: LinkSecret::from_base64url(&next.link)?,
                            keys: DocKeys::new(Keyring::import(&next.keyring)?),
                            tokens: next.tokens,
                            owner: next.owner,
                        }))
                    })
                    .transpose()?;
                Some(Pending::Commit {
                    submit: saved.submit,
                    next,
                    profile: saved.profile,
                })
            }
            Some(_) => {
                return Err(MlsError::Malformed(
                    "saved state has a pending commit openmls does not".into(),
                ));
            }
            None => {
                // openmls keeps a staged commit of its own; without our
                // record of it there is nothing to send or confirm.
                if group.pending_commit().is_some() {
                    group
                        .clear_pending_commit(provider.storage())
                        .map_err(mls)?;
                }
                None
            }
        };
        Ok(Self {
            provider,
            group,
            device: state.device,
            link: LinkSecret::from_base64url(&state.link)?,
            keys: DocKeys::new(Keyring::import(&state.keyring)?),
            group_id: state.group_id,
            profile: state.profile,
            owner: state.owner,
            owner_key: state.owner_key,
            pending,
            dead: false,
        })
    }
}

fn editor_info(
    device: &LeafKeys,
    link: &LinkSecret,
    generation: u32,
) -> Result<EditorInfo, MlsError> {
    Ok(EditorInfo {
        generation,
        attestation: link.attest(&device.signer_pub(), generation)?,
        hpke_pub: device.hpke_pub().to_vec(),
    })
}

fn sealed_group_info(
    group: &MlsGroup,
    provider: &OpenMlsRustCrypto,
    signer: &SignatureKeyPair,
    link: &LinkSecret,
) -> Result<Vec<u8>, MlsError> {
    let info = group
        .export_group_info(provider.crypto(), signer, true)
        .map_err(mls)?
        .tls_serialize_detached()
        .map_err(mls)?;
    Ok(link.gi_key().seal(&info, GROUP_INFO_CONTEXT))
}

#[cfg(test)]
mod tests;
