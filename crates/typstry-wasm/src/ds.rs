//! The delivery service codec as plain JavaScript objects.
//!
//! Messages are tagged by a `type` field and use camelCase names, with byte
//! strings as `Uint8Array`. The structs here mirror `typstry_wire::ds` one
//! to one; they exist so the wire crate stays free of serde.

use serde::{Deserialize, Serialize};
use typstry_wire::ds::{
    ClientMessage, DS_PATH, DS_VERSION, Permission, RefusalCode, Rotate, ServerMessage,
};
use wasm_bindgen::prelude::*;

use crate::error::{from_serde, invalid};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RotateDto {
    pub edit_token: String,
    pub view_token: String,
    #[serde(with = "serde_bytes")]
    pub next_owner_key: [u8; 32],
    #[serde(with = "serde_bytes")]
    pub owner_proof: [u8; 64],
}

impl From<RotateDto> for Rotate {
    fn from(r: RotateDto) -> Self {
        Self {
            edit_token: r.edit_token,
            view_token: r.view_token,
            next_owner_key: r.next_owner_key,
            owner_proof: r.owner_proof,
        }
    }
}

impl From<Rotate> for RotateDto {
    fn from(r: Rotate) -> Self {
        Self {
            edit_token: r.edit_token,
            view_token: r.view_token,
            next_owner_key: r.next_owner_key,
            owner_proof: r.owner_proof,
        }
    }
}

/// What a client sends. Messages that expect an answer carry a `req` the
/// answer repeats; the payloads of the group return it as 0 for the caller
/// to replace.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientDto {
    Hello {
        token: String,
        incarnation: u64,
        since_epoch: u64,
    },
    Submit {
        req: u64,
        epoch: u64,
        #[serde(with = "serde_bytes")]
        commit: Vec<u8>,
        #[serde(with = "serde_bytes")]
        group_info: Vec<u8>,
        #[serde(default, with = "serde_bytes")]
        keyring: Option<Vec<u8>>,
        #[serde(default, with = "serde_bytes")]
        envelope: Option<Vec<u8>>,
        #[serde(default)]
        rotate: Option<RotateDto>,
    },
    Init {
        req: u64,
        #[serde(with = "serde_bytes")]
        group_id: Vec<u8>,
        #[serde(with = "serde_bytes")]
        group_info: Vec<u8>,
        #[serde(with = "serde_bytes")]
        keyring: Vec<u8>,
        #[serde(with = "serde_bytes")]
        owner_key: [u8; 32],
    },
    Reset {
        req: u64,
        incarnation: u64,
        #[serde(with = "serde_bytes")]
        group_id: Vec<u8>,
        #[serde(with = "serde_bytes")]
        group_info: Vec<u8>,
        #[serde(with = "serde_bytes")]
        keyring: Vec<u8>,
    },
    Fetch {
        since: u64,
    },
}

impl From<ClientDto> for ClientMessage {
    fn from(dto: ClientDto) -> Self {
        match dto {
            ClientDto::Hello {
                token,
                incarnation,
                since_epoch,
            } => Self::Hello {
                token,
                incarnation,
                since_epoch,
            },
            ClientDto::Submit {
                req,
                epoch,
                commit,
                group_info,
                keyring,
                envelope,
                rotate,
            } => Self::Submit {
                req,
                epoch,
                commit,
                group_info,
                keyring,
                envelope,
                rotate: rotate.map(Rotate::from),
            },
            ClientDto::Init {
                req,
                group_id,
                group_info,
                keyring,
                owner_key,
            } => Self::Init {
                req,
                group_id,
                group_info,
                keyring,
                owner_key,
            },
            ClientDto::Reset {
                req,
                incarnation,
                group_id,
                group_info,
                keyring,
            } => Self::Reset {
                req,
                incarnation,
                group_id,
                group_info,
                keyring,
            },
            ClientDto::Fetch { since } => Self::Fetch { since },
        }
    }
}

impl From<ClientMessage> for ClientDto {
    fn from(message: ClientMessage) -> Self {
        match message {
            ClientMessage::Hello {
                token,
                incarnation,
                since_epoch,
            } => Self::Hello {
                token,
                incarnation,
                since_epoch,
            },
            ClientMessage::Submit {
                req,
                epoch,
                commit,
                group_info,
                keyring,
                envelope,
                rotate,
            } => Self::Submit {
                req,
                epoch,
                commit,
                group_info,
                keyring,
                envelope,
                rotate: rotate.map(RotateDto::from),
            },
            ClientMessage::Init {
                req,
                group_id,
                group_info,
                keyring,
                owner_key,
            } => Self::Init {
                req,
                group_id,
                group_info,
                keyring,
                owner_key,
            },
            ClientMessage::Reset {
                req,
                incarnation,
                group_id,
                group_info,
                keyring,
            } => Self::Reset {
                req,
                incarnation,
                group_id,
                group_info,
                keyring,
            },
            ClientMessage::Fetch { since } => Self::Fetch { since },
        }
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDto {
    Write,
    Read,
    Retired,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RefusalDto {
    Malformed,
    Forbidden,
    NoGroup,
    GroupExists,
    WrongIncarnation,
    BadCommit,
    Retired,
    Internal,
    RateLimited,
    NotOwner,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerDto {
    Ready {
        incarnation: u64,
        head: u64,
        permission: PermissionDto,
        #[serde(default)]
        retired: Option<u64>,
    },
    Commit {
        epoch: u64,
        #[serde(with = "serde_bytes")]
        commit: Vec<u8>,
        #[serde(default, with = "serde_bytes")]
        envelope: Option<Vec<u8>>,
        /// For a rotation, the owner key the server moved on to.
        #[serde(default, with = "serde_bytes")]
        owner_key: Option<[u8; 32]>,
    },
    Accepted {
        req: u64,
    },
    Conflict {
        req: u64,
        head: u64,
    },
    Refused {
        req: u64,
        code: RefusalDto,
    },
    Reinitialized {
        incarnation: u64,
    },
}

impl From<ServerMessage> for ServerDto {
    fn from(message: ServerMessage) -> Self {
        match message {
            ServerMessage::Ready {
                incarnation,
                head,
                permission,
                retired,
            } => Self::Ready {
                incarnation,
                head,
                permission: match permission {
                    Permission::Write => PermissionDto::Write,
                    Permission::Read => PermissionDto::Read,
                    Permission::Retired => PermissionDto::Retired,
                },
                retired,
            },
            ServerMessage::Commit {
                epoch,
                commit,
                envelope,
                owner_key,
            } => Self::Commit {
                epoch,
                commit,
                envelope,
                owner_key,
            },
            ServerMessage::Accepted { req } => Self::Accepted { req },
            ServerMessage::Conflict { req, head } => Self::Conflict { req, head },
            ServerMessage::Refused { req, code } => Self::Refused {
                req,
                code: match code {
                    RefusalCode::Malformed => RefusalDto::Malformed,
                    RefusalCode::Forbidden => RefusalDto::Forbidden,
                    RefusalCode::NoGroup => RefusalDto::NoGroup,
                    RefusalCode::GroupExists => RefusalDto::GroupExists,
                    RefusalCode::WrongIncarnation => RefusalDto::WrongIncarnation,
                    RefusalCode::BadCommit => RefusalDto::BadCommit,
                    RefusalCode::Retired => RefusalDto::Retired,
                    RefusalCode::Internal => RefusalDto::Internal,
                    RefusalCode::RateLimited => RefusalDto::RateLimited,
                    RefusalCode::NotOwner => RefusalDto::NotOwner,
                },
            },
            ServerMessage::Reinitialized { incarnation } => Self::Reinitialized { incarnation },
        }
    }
}

/// Encodes a client message for the socket. Throws `Malformed` for an
/// object that is not one, and `Ds` for a message the codec refuses.
#[wasm_bindgen(js_name = encodeClientMessage)]
pub fn encode_client_message(
    #[wasm_bindgen(unchecked_param_type = "ClientMessage")] message: JsValue,
) -> Result<Vec<u8>, JsValue> {
    let dto: ClientDto = serde_wasm_bindgen::from_value(message).map_err(from_serde)?;
    Ok(ClientMessage::from(dto).encode())
}

/// Decodes a message from the server. Throws `Ds`, e.g. for a codec newer
/// than this build.
#[wasm_bindgen(js_name = decodeServerMessage, unchecked_return_type = "ServerMessage")]
pub fn decode_server_message(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let message = ServerMessage::decode(bytes).map_err(|e| invalid("Ds", e))?;
    serde_wasm_bindgen::to_value(&ServerDto::from(message)).map_err(from_serde)
}

/// Where the server serves the delivery service socket.
#[wasm_bindgen(js_name = dsPath)]
pub fn ds_path() -> String {
    DS_PATH.to_owned()
}

/// Version of the delivery service codec, checked in the handshake.
#[wasm_bindgen(js_name = dsVersion)]
pub fn ds_version() -> u8 {
    DS_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_messages_survive_the_object_form() {
        let message = ClientMessage::Submit {
            req: 4,
            epoch: 9,
            commit: vec![1, 2],
            group_info: vec![3],
            keyring: None,
            envelope: Some(vec![4]),
            rotate: Some(Rotate {
                edit_token: "e".into(),
                view_token: "v".into(),
                next_owner_key: [5; 32],
                owner_proof: [6; 64],
            }),
        };
        let dto = ClientDto::from(message.clone());
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains(r#""type":"submit""#), "{json}");
        assert!(json.contains(r#""groupInfo""#), "{json}");
        assert!(json.contains(r#""nextOwnerKey""#), "{json}");
        assert!(json.contains(r#""ownerProof""#), "{json}");
        let back: ClientDto = serde_json::from_str(&json).unwrap();
        assert_eq!(ClientMessage::from(back), message);

        let init = ClientMessage::Init {
            req: 1,
            group_id: vec![1],
            group_info: vec![2],
            keyring: vec![3],
            owner_key: [7; 32],
        };
        let json = serde_json::to_string(&ClientDto::from(init.clone())).unwrap();
        assert!(json.contains(r#""ownerKey""#), "{json}");
        let back: ClientDto = serde_json::from_str(&json).unwrap();
        assert_eq!(ClientMessage::from(back), init);
        // A key of the wrong length is refused, not padded.
        let short = json.replace(&format!("{:?}", [7u8; 32]).replace(' ', ""), "[7,7]");
        assert!(
            serde_json::from_str::<ClientDto>(&short).is_err(),
            "{short}"
        );
    }

    #[test]
    fn a_refusal_for_a_rotation_without_the_owner_key_has_a_name() {
        let message = ServerMessage::Refused {
            req: 2,
            code: RefusalCode::NotOwner,
        };
        let decoded = ServerMessage::decode(&message.encode()).unwrap();
        let json = serde_json::to_value(ServerDto::from(decoded)).unwrap();
        assert_eq!(json["code"], "notOwner");
    }

    #[test]
    fn server_messages_decode_to_objects() {
        let message = ServerMessage::Ready {
            incarnation: 1,
            head: 5,
            permission: Permission::Retired,
            retired: Some(3),
        };
        let decoded = ServerMessage::decode(&message.encode()).unwrap();
        let json = serde_json::to_value(ServerDto::from(decoded)).unwrap();
        assert_eq!(json["type"], "ready");
        assert_eq!(json["permission"], "retired");
        assert_eq!(json["retired"], 3);

        let message = ServerMessage::Commit {
            epoch: 4,
            commit: vec![1],
            envelope: None,
            owner_key: Some([7; 32]),
        };
        let decoded = ServerMessage::decode(&message.encode()).unwrap();
        let json = serde_json::to_value(ServerDto::from(decoded)).unwrap();
        assert_eq!(json["type"], "commit");
        assert_eq!(json["ownerKey"], serde_json::to_value([7u8; 32]).unwrap());
    }
}
