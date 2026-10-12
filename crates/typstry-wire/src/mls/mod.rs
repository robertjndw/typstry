//! MLS (RFC 9420) membership for a project.
//!
//! The group gives a project what a share link alone cannot: a roster of
//! devices, each with its own signature key and a profile only members can
//! read, so authors are authenticated. It also lets editors remove members,
//! and carries the new links to the members who remain after a removal or
//! a reset. It does not encrypt documents. Records, blobs and profiles are sealed under the
//! doc keys of the [`crate::crypto::Keyring`], which every link holder can
//! reach anyway (see the `crypto` module for why there is no per-epoch key
//! for content). Doc sync never waits on MLS.
//!
//! A [`ProjectGroup`] is one device's view of the group. Nobody is invited:
//! the link opens the sealed GroupInfo on the server and a newcomer joins
//! with an external commit. The server only orders commits, first one per
//! epoch wins, so every member runs the same [`policy`] on every staged
//! commit before merging it.
//!
//! Commits made here are not merged until the server says `Accepted`:
//! call [`ProjectGroup::confirm_pending`] then. A `Conflict` or a refusal
//! is the only reason to call [`ProjectGroup::discard_pending`]; after a
//! transport error the outcome is unknown, so keep the commit (it is saved
//! with the state) and let the log decide: when it echoes the commit
//! [`ProjectGroup::process_commit`] confirms it, and when another commit
//! won the epoch it discards ours. [`ProjectGroup::pending_submit`] returns
//! what to send again.

pub mod extensions;
pub mod policy;
pub mod rotation;
pub mod storage;

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
    read_policy,
};
use self::policy::{CommitFacts, LeafFacts, LeafRole, Removal, Violation};
use self::rotation::{Binding, ROTATION_LABEL, Recipient, Tokens};
pub use self::storage::{Device, MLS_STATE_VERSION};
use crate::crypto::{
    CryptoError, DocKeys, GROUP_INFO_CONTEXT, KEY_LEN, Keyring, LinkSecret, LocalSigner,
    PROFILE_CONTEXT, PresenceKey, PublicKey, random, verify_attestation,
};
use crate::ds::{ClientMessage, Rotate};
use crate::mls_frame::{GROUP_ID_LEN, PROJECT_ID_LEN, group_id_of, split_group_id};
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
    #[error("no member at leaf {0}, or it is this device")]
    BadLeaf(u32),
    #[error("saved state was written by a newer typstry (format {0}); update typstry to read it")]
    NewerState(u8),
    #[error("the saved join was never confirmed by the server; join again")]
    Unconfirmed,
}

pub(crate) fn mls(e: impl std::fmt::Display) -> MlsError {
    MlsError::Mls(e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Editor,
    Viewer,
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
}

/// The new links a rotation hands to a remaining member.
#[derive(Debug)]
pub struct Rotation {
    pub link: LinkSecret,
    pub tokens: Tokens,
}

/// What [`ProjectGroup::process_commit`] found.
#[derive(Debug)]
pub enum Outcome {
    /// The commit was valid and merged.
    Advanced,
    /// Merged, and the keys rotated. Switch to the new link and tokens, and
    /// fetch the keyring ([`ProjectGroup::set_keyring`]) when
    /// [`ProjectGroup::needs_keyring`] says so. A member who was not sent
    /// the edit link gets a view link and no edit token. Also the result for
    /// this device's own rotation when the log echoes it before the
    /// `Accepted` reply was seen, in which case the keys are current already.
    Rotated(Box<Rotation>),
    /// The commit removed this device. The group is over for it.
    Removed,
    /// The commit breaks the policy or could not be processed, and was not
    /// merged. The group is stalled until an editor resets it. Every member
    /// sees the same, since the server already picked this commit.
    Invalid(String),
    /// A commit for an epoch this device is past already.
    AlreadyApplied,
}

/// The first message of a project: creates its group on the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitPayload {
    pub group_id: Vec<u8>,
    pub group_info: Vec<u8>,
    pub keyring: Vec<u8>,
}

impl InitPayload {
    pub fn into_message(self, req: u64) -> ClientMessage {
        ClientMessage::Init {
            req,
            group_id: self.group_id,
            group_info: self.group_info,
            keyring: self.keyring,
        }
    }
}

/// Starts a new group when the old one is stuck.
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

/// The link, keys and tokens a rotation switches to once the server accepts
/// it.
struct Next {
    link: LinkSecret,
    keys: DocKeys,
    tokens: Tokens,
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

pub struct ProjectGroup {
    provider: OpenMlsRustCrypto,
    group: MlsGroup,
    device: Device,
    link: LinkSecret,
    keys: DocKeys,
    group_id: Vec<u8>,
    /// The member's own profile as it was last committed.
    profile: Vec<u8>,
    pending: Option<Pending>,
    /// Set when a join was refused. The object is spent.
    dead: bool,
}

impl std::fmt::Debug for ProjectGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectGroup")
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

fn leaf_role(leaf: &LeafNode, policy: &Policy, standing: Standing) -> LeafRole {
    let info = read_leaf(leaf);
    let editor = match info.editor {
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
fn commit_facts<'a>(
    group: &MlsGroup,
    sender: &MlsSender,
    staged: &StagedCommit,
    before: &'a Policy,
    after: Option<&'a Policy>,
) -> Result<CommitFacts<'a>, String> {
    let tree = group.public_group();
    let judge = after.unwrap_or(before);
    let path_leaf = staged.update_path_leaf_node().map(|leaf| LeafFacts {
        signer: leaf.signature_key().as_slice().to_vec(),
        role: leaf_role(leaf, judge, Standing::New),
    });

    let (sender, sender_signer, same_key_leaves) = match sender {
        MlsSender::Member(index) => {
            let leaf = tree.leaf(*index).ok_or("sender is not in the tree")?;
            (
                policy::Sender::Member {
                    leaf: index.u32(),
                    role: leaf_role(leaf, before, Standing::Existing),
                },
                Some(leaf.signature_key().as_slice().to_vec()),
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
            (policy::Sender::External, None, same)
        }
        _ => return Err("commit from a sender typstry does not use".into()),
    };

    let mut facts = CommitFacts {
        sender,
        sender_signer,
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

impl ProjectGroup {
    /// Creates the group of a new project from a fresh edit link: this
    /// device as the only member, generation 1 keys, and the payload for
    /// the server's `Init`.
    pub fn create(link: &LinkSecret, profile: &[u8]) -> Result<(Self, InitPayload), MlsError> {
        let project_id: [u8; PROJECT_ID_LEN] = random();
        let keyring = Keyring::new(link);
        let policy = Policy::new(link.attest_pub());
        let (group, group_info, keyring_bytes) = Self::start(
            Device::generate(),
            link,
            keyring,
            policy,
            group_id_of(&project_id, 0),
            profile,
        )?;
        let payload = InitPayload {
            group_id: group.group_id.clone(),
            group_info,
            keyring: keyring_bytes,
        };
        Ok((group, payload))
    }

    /// Starts over with a new group of the same project when the current one
    /// is stuck, e.g. after an invalid commit. The link, the keys and the
    /// device stay; only the roster is rebuilt, as everyone rejoins.
    pub fn reset(&self, profile: &[u8]) -> Result<(Self, ResetPayload), MlsError> {
        self.ensure_editor()?;
        let policy = self.policy()?;
        let incarnation = self.incarnation();
        let next = group_id_of(&self.project_id(), incarnation + 1);
        let (group, group_info, keyring) = Self::start(
            self.device.duplicate(),
            &self.link,
            self.keys.keyring().clone(),
            policy,
            next,
            profile,
        )?;
        let payload = ResetPayload {
            incarnation: u64::from(incarnation),
            group_id: group.group_id.clone(),
            group_info,
            keyring,
        };
        Ok((group, payload))
    }

    fn start(
        device: Device,
        link: &LinkSecret,
        keyring: Keyring,
        policy: Policy,
        group_id: Vec<u8>,
        profile: &[u8],
    ) -> Result<(Self, Vec<u8>, Vec<u8>), MlsError> {
        if !link.can_attest() {
            return Err(MlsError::NotEditor);
        }
        let keys = DocKeys::new(keyring);
        let provider = OpenMlsRustCrypto::default();
        let signer = device.signature_pair();
        let editor = editor_info(&device, link, policy.generation())?;
        let leaf_exts =
            extensions::leaf_extensions(Some(&editor), keys.seal(profile, PROFILE_CONTEXT))
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
            pending: None,
            dead: false,
        };
        Ok((this, group_info, keyring_bytes))
    }

    /// Joins an existing group with an external commit, as a new device.
    pub fn join_external(
        link: &LinkSecret,
        sealed_group_info: &[u8],
        keyring: &[u8],
        profile: &[u8],
    ) -> Result<(Self, SubmitPayload), MlsError> {
        Self::join_external_as(
            Device::generate(),
            link,
            sealed_group_info,
            keyring,
            profile,
        )
    }

    /// [`Self::join_external`] with a known device. Rejoining with the
    /// device of lost or abandoned state is a resync: the commit replaces
    /// that device's old leaf. A different key would leave it behind.
    ///
    /// The payload goes to the server as is. If it answers `Conflict`, call
    /// [`Self::discard_pending`], drop this value and join again from the
    /// GroupInfo of the new head.
    pub fn join_external_as(
        device: Device,
        link: &LinkSecret,
        sealed_group_info: &[u8],
        keyring: &[u8],
        profile: &[u8],
    ) -> Result<(Self, SubmitPayload), MlsError> {
        let keyring = Keyring::open_verified(link, keyring)?;
        let editor = if link.can_attest() {
            Some(editor_info(&device, link, keyring.generation())?)
        } else {
            None
        };
        Self::join_with(device, link, sealed_group_info, keyring, profile, editor)
    }

    /// The join with the leaf's editor claim chosen by the caller, which
    /// tests use to forge one.
    fn join_with(
        device: Device,
        link: &LinkSecret,
        sealed: &[u8],
        keyring: Keyring,
        profile: &[u8],
        editor: Option<EditorInfo>,
    ) -> Result<(Self, SubmitPayload), MlsError> {
        let info = parse_group_info(&link.gi_key().open(sealed, GROUP_INFO_CONTEXT)?)?;
        let keys = DocKeys::new(keyring);
        let provider = OpenMlsRustCrypto::default();
        let signer = device.signature_pair();
        let params = leaf_parameters(editor.as_ref(), keys.seal(profile, PROFILE_CONTEXT))
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

        let commit = bundle.commit().tls_serialize_detached().map_err(mls)?;
        let submit = SubmitPayload {
            epoch: group.epoch().as_u64() - 1,
            commit,
            group_info: sealed_group_info(&group, &provider, &signer, link)?,
            keyring: None,
            envelope: None,
            rotate: None,
        };
        let this = Self {
            provider,
            group,
            device,
            link: link.clone(),
            keys,
            group_id,
            profile: profile.to_vec(),
            pending: Some(Pending::Join {
                submit: submit.clone(),
            }),
            dead: false,
        };
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

    fn project_id(&self) -> [u8; PROJECT_ID_LEN] {
        split_group_id(&self.group_id)
            .expect("the group id was checked on the way in")
            .0
            .try_into()
            .expect("a project id has a fixed length")
    }

    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    /// Whether this device is still a member.
    pub fn is_active(&self) -> bool {
        !self.dead && self.group.is_active()
    }

    pub fn device(&self) -> &Device {
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
        self.group.members().filter_map(|member| {
            let leaf = self.group.public_group().leaf(member.index)?;
            Some((member.index.u32(), signer_pub(leaf)?))
        })
    }

    pub fn members(&self) -> Result<Vec<MemberInfo>, MlsError> {
        let policy = self.policy()?;
        let own = self.group.own_leaf_index();
        let mut out = Vec::new();
        for member in self.group.members() {
            let Some(leaf) = self.group.public_group().leaf(member.index) else {
                continue;
            };
            let Some(sig_pub) = signer_pub(leaf) else {
                continue;
            };
            let role = match leaf_role(leaf, &policy, Standing::Existing) {
                LeafRole::Editor => Role::Editor,
                _ => Role::Viewer,
            };
            let profile = read_leaf(leaf)
                .sealed_profile
                .and_then(|sealed| self.keys.open(&sealed, PROFILE_CONTEXT).ok());
            out.push(MemberInfo {
                leaf: member.index.u32(),
                role,
                profile,
                is_self: member.index == own,
                sig_pub,
            });
        }
        Ok(out)
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
            && leaf_role(leaf, &self.policy()?, Standing::Existing) == LeafRole::Editor
        {
            Ok(())
        } else {
            Err(MlsError::NotEditor)
        }
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
    pub fn self_update(&mut self, profile: &[u8]) -> Result<SubmitPayload, MlsError> {
        self.ensure_idle()?;
        self.ensure_editor()?;
        let editor = editor_info(&self.device, &self.link, self.policy()?.generation())?;
        self.commit_leaf(Some(editor), profile)
    }

    /// A commit that only replaces this device's leaf. Whether the device
    /// may commit is the caller's business, and the policy of everyone
    /// else's.
    fn commit_leaf(
        &mut self,
        editor: Option<EditorInfo>,
        profile: &[u8],
    ) -> Result<SubmitPayload, MlsError> {
        let params = leaf_parameters(editor.as_ref(), self.keys.seal(profile, PROFILE_CONTEXT))
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
    /// so what the removed members hold stops being the project's links.
    /// Only the remaining members learn the new ones (see [`rotation`]).
    pub fn remove_and_rotate(&mut self, leaves: &[u32]) -> Result<SubmitPayload, MlsError> {
        self.ensure_idle()?;
        self.ensure_editor()?;
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

        // Our own leaf moves to the new generation with the commit, so the
        // roster never shows the committer attested by a retired link.
        let editor = editor_info(&self.device, &link, next_policy.generation())?;
        let params = leaf_parameters(Some(&editor), keys.seal(&self.profile, PROFILE_CONTEXT))
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

        let submit = SubmitPayload {
            epoch,
            // Sealed for the new link: that is who can join from now on.
            group_info: link.gi_key().seal(&info, GROUP_INFO_CONTEXT),
            keyring: Some(keys.keyring().seal_signed(&link)?),
            envelope: Some(envelope),
            rotate: Some(Rotate {
                edit_token: tokens.edit.clone().expect("generated above"),
                view_token: tokens.view.clone(),
            }),
            commit,
        };
        self.pending = Some(Pending::Commit {
            submit: submit.clone(),
            next: Some(Box::new(Next { link, keys, tokens })),
            profile: None,
        });
        Ok(submit)
    }

    /// Replaces the links without removing anyone, for a link that leaked.
    /// Everyone in the group gets the new ones.
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
                if leaf_role(leaf, policy, Standing::Existing) != LeafRole::Editor {
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
                if let Some(Next { link, keys, tokens }) = next.map(|next| *next) {
                    self.link = link.clone();
                    self.keys = keys;
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
    /// extends, `envelope` what came with it.
    ///
    /// The policy is checked before anything is merged; a refused commit
    /// leaves the group exactly as it was. A commit that wins an epoch this
    /// device had a commit pending for discards that commit first.
    pub fn process_commit(
        &mut self,
        epoch: u64,
        commit: &[u8],
        envelope: Option<&[u8]>,
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
        let rotates = match commit_facts(&self.group, &sender, &staged, &before, after.as_ref())
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

        self.group
            .merge_staged_commit(&self.provider, *staged)
            .map_err(mls)?;
        if !self.group.is_active() {
            return Ok(Outcome::Removed);
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
            pending,
            dead: false,
        })
    }
}

fn editor_info(
    device: &Device,
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
