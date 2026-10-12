//! One device's view of a project's MLS group.
//!
//! A thin layer over `typstry_wire::mls::ProjectGroup`: the operations that
//! make a commit hand back a message for the delivery service, as a plain
//! object ready for `encodeClientMessage` once the caller has set its `req`.
//! The caller owns persistence and locking: save [`Group::export_state`]
//! after every change, and never run two operations on one group at once.

use serde::Serialize;
use typstry_wire::identity::{self, person_fingerprint};
use typstry_wire::mls::{self, LocalIdentity, Outcome, OwnerSecrets, ProjectGroup, Role};
use typstry_wire::owner::{self, RotationClaim};
use wasm_bindgen::prelude::*;

use crate::ds::ClientDto;
use crate::error::{from_crypto, from_graph, from_mls, from_serde};
use crate::keys::{DocKeys, LinkSecret, Signer, device_key};
use crate::presence::PresenceKey;

fn num(value: f64) -> Result<u64, JsValue> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
    {
        Ok(value as u64)
    } else {
        Err(crate::error::invalid(
            "Malformed",
            format!("{value} is not a counter"),
        ))
    }
}

/// The person graphs (`PersonGraph.encode` bytes) the leaves of a project
/// carry, read from its sealed GroupInfo and keyring without joining. A
/// device that lost everything uses it to find the person a recovery key
/// belongs to.
#[wasm_bindgen(js_name = graphsInGroupInfo, unchecked_return_type = "Uint8Array[]")]
pub fn graphs_in_group_info(
    link: &LinkSecret,
    group_info: &[u8],
    keyring: &[u8],
) -> Result<JsValue, JsValue> {
    let graphs = mls::graphs_in_group_info(&link.inner, group_info, keyring).map_err(from_mls)?;
    Ok(graphs
        .iter()
        .map(|graph| js_sys::Uint8Array::from(graph.encode().as_slice()))
        .collect::<js_sys::Array>()
        .into())
}

/// The owner key share the project's tree holds for a recovery key
/// (`recoverySeed`, from `RecoveryKey.fromWords`), read from the bootstrap
/// (its sealed GroupInfo, keyring and the server's `ownerKey`) before
/// joining, as `ownerSecrets` bytes to keep (see `mergeOwnerSecrets`) and
/// pass to `joinExternalAs`. Undefined when there is none for the key the
/// server holds. Read it before the recovered device joins: its graph
/// revokes the devices whose leaves hold the shares.
#[wasm_bindgen(js_name = ownerShareForRecovery)]
pub fn owner_share_for_recovery(
    link: &LinkSecret,
    group_info: &[u8],
    keyring: &[u8],
    owner_key: &[u8],
    recovery_seed: &[u8],
) -> Result<Option<Vec<u8>>, JsValue> {
    let recovery = device_key(recovery_seed)?;
    let owner_key = owner_public(owner_key)?;
    let boot = mls::Bootstrap {
        group_info,
        keyring,
        owner_key: &owner_key,
    };
    let secret = mls::owner_share_for_recovery(&link.inner, boot, &recovery).map_err(from_mls)?;
    Ok(secret.map(|secret| OwnerSecrets::received(secret).encode().to_vec()))
}

/// `held` (`ownerSecrets` bytes, e.g. `ProjectGroup.ownerSecrets()`) added
/// to `kept` (the copy saved beside the state), as the bytes to save in
/// its place. Nothing in `kept` is dropped for what `held` lacks: which key
/// is current is only what the server says, and a copy must keep the one
/// it might have lied about. A damaged `kept` counts as empty. Undefined
/// when both are empty.
#[wasm_bindgen(js_name = mergeOwnerSecrets)]
pub fn merge_owner_secrets(
    kept: Option<Vec<u8>>,
    held: Option<Vec<u8>>,
) -> Result<Option<Vec<u8>>, JsValue> {
    let mut merged = kept
        .and_then(|bytes| OwnerSecrets::decode(&bytes).ok())
        .unwrap_or_default();
    merged.merge(&owner_secrets(held)?);
    Ok((!merged.is_empty()).then(|| merged.encode().to_vec()))
}

/// Whether `message`, a `submit` with `rotate`, is signed with the owner key
/// `ownerKey` (32 bytes, the `init`'s `ownerKey` or the last rotation's
/// `nextOwnerKey`) for the group `groupId`, the check the server makes
/// before it swaps the tokens. For test servers.
#[wasm_bindgen(js_name = verifyOwnerRotation)]
pub fn verify_owner_rotation(
    owner_key: &[u8],
    group_id: &[u8],
    #[wasm_bindgen(unchecked_param_type = "SubmitMessage")] message: JsValue,
) -> Result<bool, JsValue> {
    let dto: ClientDto = serde_wasm_bindgen::from_value(message).map_err(from_serde)?;
    let ClientDto::Submit {
        epoch,
        commit,
        group_info,
        keyring,
        envelope,
        rotate: Some(rotate),
        ..
    } = dto
    else {
        return Err(crate::error::invalid("Malformed", "not a rotation"));
    };
    let Ok(owner_key) = <[u8; owner::OWNER_KEY_LEN]>::try_from(owner_key) else {
        return Ok(false);
    };
    let claim = RotationClaim {
        group_id,
        epoch,
        commit: &commit,
        group_info: &group_info,
        keyring: keyring.as_deref().unwrap_or_default(),
        envelope: envelope.as_deref().unwrap_or_default(),
        edit_token: &rotate.edit_token,
        view_token: &rotate.view_token,
        next_owner_key: &rotate.next_owner_key,
    };
    Ok(owner::verify_rotation(
        &owner_key,
        &claim,
        &rotate.owner_proof,
    ))
}

fn owner_secrets(bytes: Option<Vec<u8>>) -> Result<OwnerSecrets, JsValue> {
    bytes.map_or_else(
        || Ok(OwnerSecrets::default()),
        |bytes| OwnerSecrets::decode(&bytes).map_err(from_crypto),
    )
}

/// A public owner key as the server hands it out.
fn owner_public(bytes: &[u8]) -> Result<owner::OwnerKey, JsValue> {
    bytes.try_into().map_err(|_| {
        crate::error::invalid(
            "Malformed",
            format!("an owner key is 32 bytes, not {}", bytes.len()),
        )
    })
}

/// The joins of [`Group::join_external_as`] and [`Group::rejoin_as`].
#[allow(clippy::too_many_arguments)]
fn join_as(
    previous: Option<&ProjectGroup>,
    leaf_keys: &LeafKeys,
    link: &LinkSecret,
    (group_info, keyring, owner_key): (&[u8], &[u8], &[u8]),
    profile: &[u8],
    identity: Option<LocalIdentity>,
    pinned_owner: Option<Vec<u8>>,
    owner_secret_bytes: Option<Vec<u8>>,
) -> Result<JsValue, JsValue> {
    let owner_key = owner_public(owner_key)?;
    let kept = owner_secrets(owner_secret_bytes)?;
    let (group, submit) = ProjectGroup::join_external_as(
        leaf_keys.inner.duplicate(),
        &link.inner,
        mls::Bootstrap {
            group_info,
            keyring,
            owner_key: &owner_key,
        },
        profile,
        identity.as_ref(),
        pinned_person(pinned_owner)?,
        previous,
        &kept,
    )
    .map_err(from_mls)?;
    pair(group, submit.into_message(0).into())
}

/// A project's leaf keys, which outlive the group state, so a device that
/// lost its state can rejoin as itself (a resync) instead of leaving a ghost
/// leaf behind. Per project, unlike the `DeviceKey` of the person.
#[wasm_bindgen]
pub struct LeafKeys {
    inner: mls::LeafKeys,
}

#[wasm_bindgen]
impl LeafKeys {
    pub fn generate() -> LeafKeys {
        Self {
            inner: mls::LeafKeys::generate(),
        }
    }

    pub fn export(&self) -> Vec<u8> {
        self.inner.export().to_vec()
    }

    pub fn import(bytes: &[u8]) -> Result<LeafKeys, JsValue> {
        mls::LeafKeys::import(bytes)
            .map(|inner| Self { inner })
            .map_err(from_mls)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokensDto {
    edit: Option<String>,
    view: String,
}

/// The new links of a rotation. `link` is the new edit secret for a member
/// who was sent it, else the view secret, and `viewSecret` is the view
/// secret either way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RotationDto {
    link: String,
    view_secret: String,
    can_edit: bool,
    tokens: TokensDto,
}

impl From<mls::Rotation> for RotationDto {
    fn from(rotation: mls::Rotation) -> Self {
        Self {
            link: rotation.link.to_base64url().to_string(),
            view_secret: rotation.link.view_secret().to_string(),
            can_edit: rotation.link.can_attest(),
            tokens: TokensDto {
                edit: rotation.tokens.edit,
                view: rotation.tokens.view,
            },
        }
    }
}

/// What `processCommit` found.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum OutcomeDto {
    Advanced,
    Rotated(RotationDto),
    Removed {
        #[serde(with = "serde_bytes")]
        person: Option<Vec<u8>>,
    },
    Invalid {
        reason: String,
    },
    AlreadyApplied,
}

impl From<Outcome> for OutcomeDto {
    fn from(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Advanced => Self::Advanced,
            Outcome::Rotated(rotation) => Self::Rotated((*rotation).into()),
            Outcome::Removed { person } => Self::Removed {
                person: person.map(|graph| graph.encode()),
            },
            Outcome::Invalid(reason) => Self::Invalid { reason },
            Outcome::AlreadyApplied => Self::AlreadyApplied,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberDto {
    leaf: u32,
    role: &'static str,
    #[serde(with = "serde_bytes")]
    profile: Option<Vec<u8>>,
    is_self: bool,
    #[serde(with = "serde_bytes")]
    sig_pub: Vec<u8>,
    person_state: &'static str,
    #[serde(with = "serde_bytes")]
    person_id: Option<Vec<u8>>,
    person_fingerprint: Option<String>,
    #[serde(with = "serde_bytes")]
    device_pub: Option<Vec<u8>>,
    device_revoked: bool,
    #[serde(with = "serde_bytes")]
    person_profile: Option<Vec<u8>>,
}

#[derive(Serialize)]
struct RemovalDto {
    message: ClientDto,
    removed: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityStepDto {
    #[serde(with = "serde_bytes")]
    merged: Option<Vec<u8>>,
    needs_refresh: bool,
    rejoin: bool,
    revoked: Vec<u32>,
    share_owner_key: bool,
}

/// What a device brings to a project: its `DeviceKey.export` and the
/// `PersonGraph.encode` that lists it. Bytes rather than the classes, because
/// wasm-bindgen would move them out of the caller's objects.
fn local_identity(device_seed: &[u8], graph: &[u8]) -> Result<LocalIdentity, JsValue> {
    Ok(LocalIdentity {
        device: device_key(device_seed)?,
        graph: graph_of(graph)?,
    })
}

/// [`local_identity`] where a device may have none, as when it joins a
/// project it only views. Both or neither.
fn identity_of(
    device_seed: Option<Vec<u8>>,
    graph: Option<Vec<u8>>,
) -> Result<Option<LocalIdentity>, JsValue> {
    match (device_seed, graph) {
        (None, None) => Ok(None),
        (Some(seed), Some(graph)) => local_identity(&seed, &graph).map(Some),
        _ => Err(crate::error::invalid(
            "Malformed",
            "a device key and a person graph go together",
        )),
    }
}

fn graph_of(bytes: &[u8]) -> Result<identity::PersonGraph, JsValue> {
    identity::PersonGraph::decode(bytes).map_err(from_graph)
}

fn pinned_person(bytes: Option<Vec<u8>>) -> Result<Option<identity::PersonId>, JsValue> {
    bytes.map(|bytes| person_id(&bytes)).transpose()
}

fn person_id(bytes: &[u8]) -> Result<identity::PersonId, JsValue> {
    identity::PersonId::try_from(bytes)
        .map_err(|_| crate::error::invalid("MalformedKey", "not a person id".to_string()))
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(from_serde)
}

/// `{ group, message }`, for the calls that make a group and a first
/// message for the server together.
fn pair(group: ProjectGroup, message: ClientDto) -> Result<JsValue, JsValue> {
    let out = js_sys::Object::new();
    js_sys::Reflect::set(&out, &"group".into(), &Group { inner: group }.into())?;
    js_sys::Reflect::set(&out, &"message".into(), &to_js(&message)?)?;
    Ok(out.into())
}

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export type Unsent<T> = Omit<T, "req">;
export type ClientMessage =
  | { type: "hello"; token: string; incarnation: number; sinceEpoch: number }
  | {
      type: "submit";
      req: number;
      epoch: number;
      commit: Uint8Array;
      groupInfo: Uint8Array;
      keyring?: Uint8Array;
      envelope?: Uint8Array;
      rotate?: {
        editToken: string;
        viewToken: string;
        /** The public owner key that replaces the current one, 32 bytes. */
        nextOwnerKey: Uint8Array;
        /** The current owner key's signature over the submission, 64 bytes. */
        ownerProof: Uint8Array;
      };
    }
  | {
      type: "init";
      req: number;
      groupId: Uint8Array;
      groupInfo: Uint8Array;
      keyring: Uint8Array;
      /** The public owner key the first rotation is checked against. */
      ownerKey: Uint8Array;
    }
  | {
      type: "reset";
      req: number;
      incarnation: number;
      groupId: Uint8Array;
      groupInfo: Uint8Array;
      keyring: Uint8Array;
    }
  | { type: "fetch"; since: number };
export type ServerMessage =
  | {
      type: "ready";
      incarnation: number;
      head: number;
      permission: "write" | "read" | "retired";
      retired?: number;
    }
  | {
      type: "commit";
      epoch: number;
      commit: Uint8Array;
      envelope?: Uint8Array;
      /** For a rotation, the owner key the server moved on to, 32 bytes. */
      ownerKey?: Uint8Array;
    }
  | { type: "accepted"; req: number }
  | { type: "conflict"; req: number; head: number }
  | {
      type: "refused";
      req: number;
      code:
        | "malformed"
        | "forbidden"
        | "noGroup"
        | "groupExists"
        | "wrongIncarnation"
        | "badCommit"
        | "retired"
        | "internal"
        | "rateLimited"
        | "notOwner";
    }
  | { type: "reinitialized"; incarnation: number };
export type SubmitMessage = Extract<ClientMessage, { type: "submit" }>;
export type InitMessage = Extract<ClientMessage, { type: "init" }>;
export type ResetMessage = Extract<ClientMessage, { type: "reset" }>;
export interface Rotation {
  link: string;
  viewSecret: string;
  canEdit: boolean;
  tokens: { edit?: string; view: string };
}
export type Outcome =
  | { type: "advanced" }
  | ({ type: "rotated" } & Rotation)
  /** `person`: the group's copy of this device's person at removal, to merge into the stored graph. */
  | { type: "removed"; person?: Uint8Array }
  | { type: "invalid"; reason: string }
  | { type: "alreadyApplied" };
export interface Member {
  leaf: number;
  role: "owner" | "editor" | "viewer";
  profile?: Uint8Array;
  isSelf: boolean;
  sigPub: Uint8Array;
  personState: "anonymous" | "verified" | "unverified";
  /** The verified person's id, else undefined. */
  personId?: Uint8Array;
  personFingerprint?: string;
  /** The device key that vouched for this leaf, for a verified person. */
  devicePub?: Uint8Array;
  /** The person's merged graph in this project shows the device revoked. */
  deviceRevoked: boolean;
  /** The verified person's own profile bytes from their graph. */
  personProfile?: Uint8Array;
}
export interface RevokedRemoval {
  message: Unsent<SubmitMessage>;
  /** The leaves the commit removes. */
  removed: number[];
}
export interface IdentityStep {
  /** The stored graph with the group's copy merged in, if that adds anything. */
  merged?: Uint8Array;
  needsRefresh: boolean;
  /** The leaf names another person than the graph, which lists its device. */
  rejoin: boolean;
  /** Revoked leaves of anyone, for `removeRevoked`; empty unless this device holds the owner key. */
  revoked: number[];
  /** This device holds the owner key and another owner device lacks it: `selfUpdate` hands it over. */
  shareOwnerKey: boolean;
}
export interface DecryptedDelta {
  kind: "delta";
  peer: string;
  start: number;
  end: number;
  plaintext: Uint8Array;
  signer: Uint8Array;
}
export interface DecryptedSnapshot {
  kind: "snapshot";
  vv: { peer: string; counter: number }[];
  plaintext: Uint8Array;
  signer: Uint8Array;
}
export type DecryptedRecord = DecryptedDelta | DecryptedSnapshot;
export interface Opened {
  leaf: number;
  signer: Uint8Array;
  plaintext: Uint8Array;
}
export interface Joined<M> {
  group: ProjectGroup;
  message: M;
}
"#;

/// One device's view of a project's group.
#[wasm_bindgen(js_name = ProjectGroup)]
pub struct Group {
    inner: ProjectGroup,
}

#[wasm_bindgen(js_class = ProjectGroup)]
impl Group {
    /// Creates the group of a new project from a fresh edit link. Returns
    /// `{ group, message }`, the message being the server's `init`. The
    /// creator's person becomes the project's owner, so the device key and
    /// graph are not optional.
    #[wasm_bindgen(unchecked_return_type = "Joined<InitMessage>")]
    pub fn create(
        link: &LinkSecret,
        profile: &[u8],
        device_seed: &[u8],
        graph: &[u8],
    ) -> Result<JsValue, JsValue> {
        let identity = local_identity(device_seed, graph)?;
        let (group, init) =
            ProjectGroup::create(&link.inner, profile, &identity).map_err(from_mls)?;
        pair(group, init.into_message(0).into())
    }

    /// Joins with an external commit as a new device, from the bootstrap:
    /// the sealed GroupInfo, the keyring and the server's `ownerKey`.
    /// Returns `{ group, message }` with the `submit` for the server. Call
    /// `confirmPending` once the server answers `accepted`; on `conflict`,
    /// drop the group and join again from the newer GroupInfo. `pinnedOwner`
    /// is the owner's person id as first seen for the project
    /// (`ownerPerson`), which the group must still have (else
    /// `OwnerChanged`). A device of the owner joins as the owner by bringing
    /// its identity.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = joinExternal, unchecked_return_type = "Joined<SubmitMessage>")]
    pub fn join_external(
        link: &LinkSecret,
        group_info: &[u8],
        keyring: &[u8],
        owner_key: &[u8],
        profile: &[u8],
        device_seed: Option<Vec<u8>>,
        graph: Option<Vec<u8>>,
        pinned_owner: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        let identity = identity_of(device_seed, graph)?;
        let owner_key = owner_public(owner_key)?;
        let (group, submit) = ProjectGroup::join_external(
            &link.inner,
            mls::Bootstrap {
                group_info,
                keyring,
                owner_key: &owner_key,
            },
            profile,
            identity.as_ref(),
            pinned_person(pinned_owner)?,
        )
        .map_err(from_mls)?;
        pair(group, submit.into_message(0).into())
    }

    /// [`Self::join_external`] as a known device. Rejoining with the device
    /// of lost state replaces that device's old leaf. `ownerSecrets` are
    /// the owner key secrets this device kept (`ownerSecrets()` bytes saved
    /// beside the state, or from `ownerShareForRecovery`), all taken along
    /// whichever key the server names. A device that still has its old
    /// group joins with `rejoinAs` instead.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = joinExternalAs, unchecked_return_type = "Joined<SubmitMessage>")]
    pub fn join_external_as(
        leaf_keys: &LeafKeys,
        link: &LinkSecret,
        group_info: &[u8],
        keyring: &[u8],
        owner_key: &[u8],
        profile: &[u8],
        device_seed: Option<Vec<u8>>,
        graph: Option<Vec<u8>>,
        pinned_owner: Option<Vec<u8>>,
        owner_secrets: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        join_as(
            None,
            leaf_keys,
            link,
            (group_info, keyring, owner_key),
            profile,
            identity_of(device_seed, graph)?,
            pinned_owner,
            owner_secrets,
        )
    }

    /// [`Self::join_external_as`] from this group's state, e.g. after a
    /// reset or a gap in the log: the new group has to keep this one's
    /// keyring and owner (else `Mismatch` or `OwnerChanged`), and the owner
    /// key secrets this group holds are taken along with `ownerSecrets`.
    /// This group is left as it is.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = rejoinAs, unchecked_return_type = "Joined<SubmitMessage>")]
    pub fn rejoin_as(
        &self,
        leaf_keys: &LeafKeys,
        link: &LinkSecret,
        group_info: &[u8],
        keyring: &[u8],
        owner_key: &[u8],
        profile: &[u8],
        device_seed: Option<Vec<u8>>,
        graph: Option<Vec<u8>>,
        pinned_owner: Option<Vec<u8>>,
        owner_secrets: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        join_as(
            Some(&self.inner),
            leaf_keys,
            link,
            (group_info, keyring, owner_key),
            profile,
            identity_of(device_seed, graph)?,
            pinned_owner,
            owner_secrets,
        )
    }

    /// Starts over with a new group of the same project when this one is
    /// stuck. Returns `{ group, message }` with the `reset`. The leaf keeps
    /// its identity unless `deviceSeed` and `graph` give a new one.
    #[wasm_bindgen(unchecked_return_type = "Joined<ResetMessage>")]
    pub fn reset(
        &self,
        profile: &[u8],
        device_seed: Option<Vec<u8>>,
        graph: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        let identity = identity_of(device_seed, graph)?;
        let (group, reset) = self
            .inner
            .reset(profile, identity.as_ref())
            .map_err(from_mls)?;
        pair(group, reset.into_message(0).into())
    }

    /// Applies a commit from the server's log; `epoch` is the epoch it
    /// extends, `envelope` and `ownerKey` what the `commit` message carried.
    /// Throws `Epoch` when it does not follow this group's.
    #[wasm_bindgen(js_name = processCommit, unchecked_return_type = "Outcome")]
    pub fn process_commit(
        &mut self,
        epoch: f64,
        commit: &[u8],
        envelope: Option<Vec<u8>>,
        owner_key: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        let owner_key = owner_key.as_deref().map(owner_public).transpose()?;
        let outcome = self
            .inner
            .process_commit(num(epoch)?, commit, envelope.as_deref(), owner_key.as_ref())
            .map_err(from_mls)?;
        to_js(&OutcomeDto::from(outcome))
    }

    /// Merges the commit the server accepted. For a rotation this device
    /// made, returns the new link and tokens it switched to.
    #[wasm_bindgen(js_name = confirmPending, unchecked_return_type = "Rotation | undefined")]
    pub fn confirm_pending(&mut self) -> Result<JsValue, JsValue> {
        let rotation = self.inner.confirm_pending().map_err(from_mls)?;
        to_js(&rotation.map(RotationDto::from))
    }

    /// What was submitted last and still waits for the server, to send again
    /// after a lost reply (the server answers `conflict` when it already
    /// landed). `processCommit` settles it from the log: it confirms the
    /// commit when the log echoes it and drops it when another won the
    /// epoch. Only a `conflict` or a refusal that is not about this commit's
    /// epoch is a reason for `discardPending`, never a transport error.
    #[wasm_bindgen(js_name = pendingSubmit, unchecked_return_type = "Unsent<SubmitMessage> | undefined")]
    pub fn pending_submit(&self) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .inner
                .pending_submit()
                .map(|submit| ClientDto::from(submit.clone().into_message(0))),
        )
    }

    /// Whether a submit waits for the server, without building the message
    /// `pendingSubmit` returns.
    #[wasm_bindgen(getter, js_name = hasPendingSubmit)]
    pub fn has_pending_submit(&self) -> bool {
        self.inner.pending_submit().is_some()
    }

    /// Drops the pending commit after the server refused it or another one
    /// beat it to its epoch. Not for a transport error, after which it is
    /// unknown whether the commit landed.
    #[wasm_bindgen(js_name = discardPending)]
    pub fn discard_pending(&mut self) -> Result<(), JsValue> {
        self.inner.discard_pending().map_err(from_mls)
    }

    /// Removes the members at `leaves` and rotates the links. Returns the
    /// `submit` for the server. Throws `NotOwner` for anyone but the owner
    /// and `NoOwnerKey` for an owner device that was not handed the owner
    /// key yet (see `holdsOwnerKey`).
    #[wasm_bindgen(js_name = removeAndRotate, unchecked_return_type = "Unsent<SubmitMessage>")]
    pub fn remove_and_rotate(&mut self, leaves: Vec<u32>) -> Result<JsValue, JsValue> {
        let submit = self.inner.remove_and_rotate(&leaves).map_err(from_mls)?;
        to_js(&ClientDto::from(submit.into_message(0)))
    }

    /// Removes every leaf the group's merged graphs show as a revoked
    /// device, of whichever person, and rotates the links. Owner only, like
    /// `removeAndRotate`, with the same errors; anyone else commits the
    /// revoke to its own leaf with `selfUpdate(profile, graph)` and leaves
    /// the removal to the owner. Returns `{ message, removed }` with the
    /// leaves the commit removes. Throws `NothingRevoked` when there is
    /// nothing to remove.
    #[wasm_bindgen(js_name = removeRevoked, unchecked_return_type = "RevokedRemoval")]
    pub fn remove_revoked(&mut self) -> Result<JsValue, JsValue> {
        let removal = self.inner.remove_revoked().map_err(from_mls)?;
        to_js(&RemovalDto {
            message: ClientDto::from(removal.submit.into_message(0)),
            removed: removal.removed,
        })
    }

    /// What to do to keep this device's identity in line with its person,
    /// in one pass over the tree, given `graph`, the `PersonGraph.encode`
    /// stored here. Returns `{ merged?, needsRefresh, rejoin, revoked,
    /// shareOwnerKey }`: on `rejoin` join again with `joinExternalAs` and the
    /// same leaf keys and do nothing else; otherwise store `merged` when set,
    /// commit `selfUpdate(profile, merged ?? graph)` when `needsRefresh` or
    /// `shareOwnerKey`, and `removeRevoked` when `revoked` is not empty.
    /// After committing a refresh ask again, as it can change `revoked`.
    /// Throws what merging throws when the group's copy of the person does
    /// not merge with `graph`.
    #[wasm_bindgen(js_name = identityStep, unchecked_return_type = "IdentityStep")]
    pub fn identity_step(&self, graph: &[u8]) -> Result<JsValue, JsValue> {
        let step = self
            .inner
            .identity_step(&graph_of(graph)?)
            .map_err(from_mls)?;
        to_js(&IdentityStepDto {
            merged: step.merged.map(|graph| graph.encode()),
            needs_refresh: step.needs_refresh,
            rejoin: step.rejoin,
            revoked: step.revoked,
            share_owner_key: step.share_owner_key,
        })
    }

    /// Rotates the links without removing anyone.
    #[wasm_bindgen(js_name = resetLinks, unchecked_return_type = "Unsent<SubmitMessage>")]
    pub fn reset_links(&mut self) -> Result<JsValue, JsValue> {
        let submit = self.inner.reset_links().map_err(from_mls)?;
        to_js(&ClientDto::from(submit.into_message(0)))
    }

    /// Refreshes this editor's leaf with a new profile. With a `graph` (a
    /// `PersonGraph.encode`) the leaf's graph is extended by it; throws
    /// `ForeignGraph` for another person's and `NoIdentity` for a leaf that
    /// has none.
    #[wasm_bindgen(js_name = selfUpdate, unchecked_return_type = "Unsent<SubmitMessage>")]
    pub fn self_update(
        &mut self,
        profile: &[u8],
        graph: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        let graph = graph.map(|bytes| graph_of(&bytes)).transpose()?;
        let submit = self
            .inner
            .self_update(profile, graph.as_ref())
            .map_err(from_mls)?;
        to_js(&ClientDto::from(submit.into_message(0)))
    }

    #[wasm_bindgen(unchecked_return_type = "Member[]")]
    pub fn members(&self) -> Result<JsValue, JsValue> {
        let members: Vec<_> = self
            .inner
            .members()
            .map_err(from_mls)?
            .into_iter()
            .map(|m| {
                let (person_state, id, device, device_revoked) = match m.person {
                    mls::Person::Anonymous => ("anonymous", None, None, false),
                    mls::Person::Unverified => ("unverified", None, None, false),
                    mls::Person::Verified {
                        id,
                        device,
                        revoked,
                    } => ("verified", Some(id), Some(device), revoked),
                };
                MemberDto {
                    leaf: m.leaf,
                    role: match m.role {
                        Role::Owner => "owner",
                        Role::Editor => "editor",
                        Role::Viewer => "viewer",
                    },
                    profile: m.profile,
                    is_self: m.is_self,
                    sig_pub: m.sig_pub.to_vec(),
                    person_state,
                    person_fingerprint: id.as_ref().map(person_fingerprint),
                    person_id: id.map(|id| id.to_vec()),
                    device_pub: device.map(|device| device.to_vec()),
                    device_revoked,
                    person_profile: m.person_profile,
                }
            })
            .collect();
        to_js(&members)
    }

    /// The leaves of a verified person other than this device, for removing
    /// them all in one commit. Resolve it at commit time: leaves move.
    #[wasm_bindgen(js_name = leavesOf)]
    pub fn leaves_of(&self, person: &[u8]) -> Result<Vec<u32>, JsValue> {
        self.inner.leaves_of(&person_id(person)?).map_err(from_mls)
    }

    /// This epoch's presence key, with the roster and signer it needs.
    #[wasm_bindgen(js_name = presenceKey)]
    pub fn presence_key(&self) -> Result<PresenceKey, JsValue> {
        let key = self.inner.presence_key().map_err(from_mls)?;
        let roster = self.inner.signers().collect();
        Ok(PresenceKey::new(
            key,
            Box::new(self.inner.signer()),
            self.inner.own_leaf(),
            roster,
        ))
    }

    /// A signer for records. It attests with the current link, so editors
    /// can write and viewers cannot. Take a new one after a rotation.
    pub fn signer(&self) -> Signer {
        Signer {
            inner: Box::new(self.inner.signer()),
        }
    }

    /// The doc keys the group holds. Take them again after `setKeyring`.
    #[wasm_bindgen(js_name = docKeys)]
    pub fn doc_keys(&self) -> DocKeys {
        DocKeys {
            inner: self.inner.doc_keys().clone(),
        }
    }

    /// The link the group currently holds, which changes with a rotation.
    pub fn link(&self) -> LinkSecret {
        LinkSecret {
            inner: self.inner.link().clone(),
        }
    }

    #[wasm_bindgen(js_name = leafKeys)]
    pub fn leaf_keys(&self) -> LeafKeys {
        LeafKeys {
            inner: self.inner.device().duplicate(),
        }
    }

    /// The project owner's person id, i.e. the person in the group whose tag
    /// the policy holds. Pin it the first time a project is seen and pass it
    /// as `pinnedOwner` to later joins. Undefined while none of the owner's
    /// devices is in the group, as after a reset.
    #[wasm_bindgen(js_name = ownerPerson)]
    pub fn owner_person(&self) -> Option<Vec<u8>> {
        self.inner.owner_person().map(|id| id.to_vec())
    }

    /// Every owner key secret this device holds, current or not, as bytes
    /// to merge into the copy kept beside the group state (one may be the
    /// only copy, see `mergeOwnerSecrets`) and to pass to `joinExternalAs`
    /// when rejoining. Undefined when it holds none.
    #[wasm_bindgen(js_name = ownerSecrets)]
    pub fn owner_secrets(&self) -> Option<Vec<u8>> {
        let held = self.inner.owner_secrets();
        (!held.is_empty()).then(|| held.encode().to_vec())
    }

    /// Whether this device can rotate: an owner that holds the current
    /// owner key.
    #[wasm_bindgen(getter, js_name = holdsOwnerKey)]
    pub fn holds_owner_key(&self) -> bool {
        self.inner.holds_owner_key()
    }

    /// Whether the group rotated past the keyring this device holds.
    #[wasm_bindgen(js_name = needsKeyring)]
    pub fn needs_keyring(&self) -> bool {
        self.inner.needs_keyring()
    }

    /// Takes the signed keyring the server holds after a rotation.
    #[wasm_bindgen(js_name = setKeyring)]
    pub fn set_keyring(&mut self, signed: &[u8]) -> Result<(), JsValue> {
        self.inner.set_keyring(signed).map_err(from_mls)
    }

    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> f64 {
        self.inner.epoch() as f64
    }

    #[wasm_bindgen(getter)]
    pub fn incarnation(&self) -> u32 {
        self.inner.incarnation()
    }

    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> Result<u32, JsValue> {
        self.inner.generation().map_err(from_mls)
    }

    #[wasm_bindgen(getter, js_name = isActive)]
    pub fn is_active(&self) -> bool {
        self.inner.is_active()
    }

    /// Everything needed to come back to this group, secrets included. A
    /// commit still waiting for the server is part of it, with the new link
    /// of a rotation.
    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> Vec<u8> {
        self.inner.export_state().to_vec()
    }

    /// Throws `NewerVersion` for state a newer build wrote and `Unconfirmed`
    /// for a join the server never accepted.
    #[wasm_bindgen(js_name = importState)]
    pub fn import_state(bytes: &[u8]) -> Result<Group, JsValue> {
        ProjectGroup::import_state(bytes)
            .map(|inner| Self { inner })
            .map_err(from_mls)
    }
}

#[cfg(test)]
mod tests {
    use typstry_wire::crypto::LinkSecret;
    use typstry_wire::mls::rotation::Tokens;

    use super::*;

    #[test]
    fn a_rotation_is_the_same_object_in_an_outcome_and_a_confirmation() {
        let rotation = || mls::Rotation {
            link: LinkSecret::generate_edit(),
            tokens: Tokens {
                edit: Some("e".into()),
                view: "v".into(),
            },
        };
        let json =
            serde_json::to_value(OutcomeDto::from(Outcome::Rotated(Box::new(rotation())))).unwrap();
        assert_eq!(json["type"], "rotated");
        assert_eq!(json["canEdit"], true);
        assert_eq!(json["tokens"]["edit"], "e");
        assert!(json["viewSecret"].is_string() && json["link"].is_string());

        let json = serde_json::to_value(RotationDto::from(rotation())).unwrap();
        assert!(json.get("type").is_none());
        assert_eq!(json["tokens"]["view"], "v");
    }
}
