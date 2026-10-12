//! One device's view of a project's MLS group.
//!
//! A thin layer over `typstry_wire::mls::ProjectGroup`: the operations that
//! make a commit hand back a message for the delivery service, as a plain
//! object ready for `encodeClientMessage` once the caller has set its `req`.
//! The caller owns persistence and locking: save [`Group::export_state`]
//! after every change, and never run two operations on one group at once.

use serde::Serialize;
use typstry_wire::mls::{self, Outcome, ProjectGroup, Role};
use wasm_bindgen::prelude::*;

use crate::ds::ClientDto;
use crate::error::{from_mls, from_serde};
use crate::keys::{DocKeys, LinkSecret, Signer};
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

/// A device identity that outlives the group state, so a device that lost
/// its state can rejoin as itself (a resync) instead of leaving a ghost
/// leaf behind.
#[wasm_bindgen]
pub struct Device {
    inner: mls::Device,
}

#[wasm_bindgen]
impl Device {
    pub fn generate() -> Device {
        Self {
            inner: mls::Device::generate(),
        }
    }

    pub fn export(&self) -> Vec<u8> {
        self.inner.export().to_vec()
    }

    pub fn import(bytes: &[u8]) -> Result<Device, JsValue> {
        mls::Device::import(bytes)
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
    Removed,
    Invalid { reason: String },
    AlreadyApplied,
}

impl From<Outcome> for OutcomeDto {
    fn from(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Advanced => Self::Advanced,
            Outcome::Rotated(rotation) => Self::Rotated((*rotation).into()),
            Outcome::Removed => Self::Removed,
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
      rotate?: { editToken: string; viewToken: string };
    }
  | {
      type: "init";
      req: number;
      groupId: Uint8Array;
      groupInfo: Uint8Array;
      keyring: Uint8Array;
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
  | { type: "commit"; epoch: number; commit: Uint8Array; envelope?: Uint8Array }
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
        | "rateLimited";
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
  | { type: "removed" }
  | { type: "invalid"; reason: string }
  | { type: "alreadyApplied" };
export interface Member {
  leaf: number;
  role: "editor" | "viewer";
  profile?: Uint8Array;
  isSelf: boolean;
  sigPub: Uint8Array;
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
    /// `{ group, message }`, the message being the server's `init`.
    #[wasm_bindgen(unchecked_return_type = "Joined<InitMessage>")]
    pub fn create(link: &LinkSecret, profile: &[u8]) -> Result<JsValue, JsValue> {
        let (group, init) = ProjectGroup::create(&link.inner, profile).map_err(from_mls)?;
        pair(group, init.into_message(0).into())
    }

    /// Joins with an external commit as a new device. Returns `{ group,
    /// message }` with the `submit` for the server. Call `confirmPending`
    /// once the server answers `accepted`; on `conflict`, drop the group and
    /// join again from the newer GroupInfo.
    #[wasm_bindgen(js_name = joinExternal, unchecked_return_type = "Joined<SubmitMessage>")]
    pub fn join_external(
        link: &LinkSecret,
        group_info: &[u8],
        keyring: &[u8],
        profile: &[u8],
    ) -> Result<JsValue, JsValue> {
        let (group, submit) =
            ProjectGroup::join_external(&link.inner, group_info, keyring, profile)
                .map_err(from_mls)?;
        pair(group, submit.into_message(0).into())
    }

    /// [`Self::join_external`] as a known device. Rejoining with the device
    /// of lost state replaces that device's old leaf.
    #[wasm_bindgen(js_name = joinExternalAs, unchecked_return_type = "Joined<SubmitMessage>")]
    pub fn join_external_as(
        device: &Device,
        link: &LinkSecret,
        group_info: &[u8],
        keyring: &[u8],
        profile: &[u8],
    ) -> Result<JsValue, JsValue> {
        let (group, submit) = ProjectGroup::join_external_as(
            device.inner.duplicate(),
            &link.inner,
            group_info,
            keyring,
            profile,
        )
        .map_err(from_mls)?;
        pair(group, submit.into_message(0).into())
    }

    /// Starts over with a new group of the same project when this one is
    /// stuck. Returns `{ group, message }` with the `reset`.
    #[wasm_bindgen(unchecked_return_type = "Joined<ResetMessage>")]
    pub fn reset(&self, profile: &[u8]) -> Result<JsValue, JsValue> {
        let (group, reset) = self.inner.reset(profile).map_err(from_mls)?;
        pair(group, reset.into_message(0).into())
    }

    /// Applies a commit from the server's log; `epoch` is the epoch it
    /// extends. Throws `Epoch` when it does not follow this group's.
    #[wasm_bindgen(js_name = processCommit, unchecked_return_type = "Outcome")]
    pub fn process_commit(
        &mut self,
        epoch: f64,
        commit: &[u8],
        envelope: Option<Vec<u8>>,
    ) -> Result<JsValue, JsValue> {
        let outcome = self
            .inner
            .process_commit(num(epoch)?, commit, envelope.as_deref())
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
    /// `submit` for the server.
    #[wasm_bindgen(js_name = removeAndRotate, unchecked_return_type = "Unsent<SubmitMessage>")]
    pub fn remove_and_rotate(&mut self, leaves: Vec<u32>) -> Result<JsValue, JsValue> {
        let submit = self.inner.remove_and_rotate(&leaves).map_err(from_mls)?;
        to_js(&ClientDto::from(submit.into_message(0)))
    }

    /// Rotates the links without removing anyone.
    #[wasm_bindgen(js_name = resetLinks, unchecked_return_type = "Unsent<SubmitMessage>")]
    pub fn reset_links(&mut self) -> Result<JsValue, JsValue> {
        let submit = self.inner.reset_links().map_err(from_mls)?;
        to_js(&ClientDto::from(submit.into_message(0)))
    }

    /// Refreshes this editor's leaf with a new profile.
    #[wasm_bindgen(js_name = selfUpdate, unchecked_return_type = "Unsent<SubmitMessage>")]
    pub fn self_update(&mut self, profile: &[u8]) -> Result<JsValue, JsValue> {
        let submit = self.inner.self_update(profile).map_err(from_mls)?;
        to_js(&ClientDto::from(submit.into_message(0)))
    }

    #[wasm_bindgen(unchecked_return_type = "Member[]")]
    pub fn members(&self) -> Result<JsValue, JsValue> {
        let members: Vec<_> = self
            .inner
            .members()
            .map_err(from_mls)?
            .into_iter()
            .map(|m| MemberDto {
                leaf: m.leaf,
                role: match m.role {
                    Role::Editor => "editor",
                    Role::Viewer => "viewer",
                },
                profile: m.profile,
                is_self: m.is_self,
                sig_pub: m.sig_pub.to_vec(),
            })
            .collect();
        to_js(&members)
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

    pub fn device(&self) -> Device {
        Device {
            inner: self.inner.device().duplicate(),
        }
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
