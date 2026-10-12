//! Pairing two devices of one person, for the browser.
//!
//! The state machine is `typstry_wire::pairing`; this is its surface for
//! JavaScript. The socket to the relay stays in TypeScript: feed every
//! binary frame to [`Pairing::handle`] and send what comes back.

use serde::{Deserialize, Serialize};
use typstry_wire::crypto::PublicKey;
use typstry_wire::pairing::{self as wire, Event, Grant, GrantedSpace};
use wasm_bindgen::prelude::*;

use crate::error::{from_code, from_pair, from_serde, invalid};

/// The code a person reads off one device and types into the other.
#[wasm_bindgen]
pub struct PairingCode {
    inner: wire::Code,
}

#[wasm_bindgen]
impl PairingCode {
    /// A fresh code for the relay channel the server just allocated. Throws
    /// `BadCode` for a number outside the channel range.
    pub fn generate(channel: u16) -> Result<PairingCode, JsValue> {
        wire::Code::generate(channel)
            .map(|inner| Self { inner })
            .map_err(from_code)
    }

    /// Accepts a bare code or a link with the code in its fragment. Throws
    /// `BadCode`.
    pub fn parse(link_or_code: &str) -> Result<PairingCode, JsValue> {
        wire::Code::from_link_or_code(link_or_code)
            .map(|inner| Self { inner })
            .map_err(from_code)
    }

    #[wasm_bindgen(js_name = toString)]
    pub fn to_js_string(&self) -> String {
        self.inner.to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn channel(&self) -> u16 {
        self.inner.channel()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceDto {
    token: String,
    secret: String,
    #[serde(with = "serde_bytes")]
    owner_secrets: Vec<u8>,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum EventDto {
    Verified,
    AwaitApproval {
        device_name: String,
        #[serde(with = "serde_bytes")]
        device_pub: Vec<u8>,
    },
    Granted {
        #[serde(with = "serde_bytes")]
        graph: Vec<u8>,
        holder_name: String,
        space: SpaceDto,
    },
    Rejected,
}

impl From<Event> for EventDto {
    fn from(event: Event) -> Self {
        match event {
            Event::Verified => Self::Verified,
            Event::AwaitApproval {
                device_name,
                device_pub,
            } => Self::AwaitApproval {
                device_name,
                device_pub: device_pub.to_vec(),
            },
            Event::Granted(grant) => Self::Granted {
                holder_name: grant.holder_name,
                graph: grant.graph,
                space: SpaceDto {
                    token: grant.space.token,
                    secret: grant.space.secret.to_string(),
                    owner_secrets: grant.space.owner_secrets.to_vec(),
                },
            },
            Event::Rejected => Self::Rejected,
        }
    }
}

#[derive(Serialize)]
struct StepDto {
    #[serde(with = "serde_bytes")]
    send: Option<Vec<u8>>,
    event: Option<EventDto>,
}

/// One side of a pairing. One code allows one attempt: after any error every
/// call throws `finished`.
#[wasm_bindgen]
pub struct Pairing {
    inner: wire::Pairing,
    first: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl Pairing {
    /// The side that is a device of the person already.
    #[wasm_bindgen(js_name = startHolder)]
    pub fn start_holder(code: &PairingCode) -> Pairing {
        let (inner, first) = wire::Pairing::start_holder(&code.inner);
        Self {
            inner,
            first: Some(first),
        }
    }

    /// The side that wants to join. `deviceName` is what the holder's user
    /// sees and `devicePub` the `DeviceKey.publicKey` the holder adds to the
    /// graph. Throws `Malformed` for an empty or overlong name or a key that
    /// is not 32 bytes.
    #[wasm_bindgen(js_name = startNew)]
    pub fn start_new(
        code: &PairingCode,
        device_name: &str,
        device_pub: &[u8],
    ) -> Result<Pairing, JsValue> {
        let device_pub = PublicKey::try_from(device_pub)
            .map_err(|_| invalid("Malformed", "a device key is 32 bytes"))?;
        let (inner, first) =
            wire::Pairing::start_new(&code.inner, device_name, &device_pub).map_err(from_pair)?;
        Ok(Self {
            inner,
            first: Some(first),
        })
    }

    /// The frame to send as soon as the socket opens. Only the first call
    /// returns it.
    #[wasm_bindgen(js_name = firstFrame)]
    pub fn first_frame(&mut self) -> Option<Vec<u8>> {
        self.first.take()
    }

    /// Feeds one frame from the relay. Returns `{ send?, event? }`. Throws
    /// `WrongCode`, `RoleConflict`, `Unexpected`, `Finished`, `Tampered`,
    /// `NewerVersion` or `Malformed`, after which the pairing is over.
    #[wasm_bindgen(unchecked_return_type = "PairingStep")]
    pub fn handle(&mut self, frame: &[u8]) -> Result<JsValue, JsValue> {
        let step = self.inner.handle(frame).map_err(from_pair)?;
        serde_wasm_bindgen::to_value(&StepDto {
            send: step.send,
            event: step.event.map(Into::into),
        })
        .map_err(from_serde)
    }

    /// Holder only, after `awaitApproval`: the frame that hands over the
    /// person's `graph` (a `PersonGraph.encode`, with the new device added),
    /// `holderName`, how the new device should label this one, and `space`,
    /// the person's personal space, whose directory lists their projects.
    /// The name is fitted as `fitDeviceName` does, so the limit never fails
    /// the grant; a name with nothing printable throws `Malformed`, as does a
    /// space that is not a token, an edit secret and owner secrets.
    pub fn approve(
        &mut self,
        graph: &[u8],
        holder_name: &str,
        #[wasm_bindgen(unchecked_param_type = "PairingSpace")] space: JsValue,
    ) -> Result<Vec<u8>, JsValue> {
        let holder_name = wire::fit_device_name(holder_name)
            .ok_or_else(|| invalid("Malformed", "the holder's name is empty"))?;
        let space: SpaceDto = serde_wasm_bindgen::from_value(space).map_err(from_serde)?;
        let space =
            GrantedSpace::new(space.token, space.secret, space.owner_secrets).map_err(from_pair)?;
        self.inner
            .approve(&Grant::new(holder_name, graph.to_vec(), space))
            .map_err(from_pair)
    }

    /// Holder only, after `awaitApproval`: the frame that turns the device
    /// away.
    pub fn reject(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.reject().map_err(from_pair)
    }
}

/// Whether the pairing takes `name` as a device name: not empty, at most
/// `maxDeviceNameLen()` bytes of UTF-8, no control characters.
#[wasm_bindgen(js_name = validDeviceName)]
pub fn valid_device_name(name: &str) -> bool {
    wire::valid_device_name(name)
}

/// `name` made valid: control characters become spaces, the ends are
/// trimmed and it is cut to the byte limit on a character boundary.
/// Undefined when nothing is left.
#[wasm_bindgen(js_name = fitDeviceName)]
pub fn fit_device_name(name: &str) -> Option<String> {
    wire::fit_device_name(name)
}

/// The most bytes of UTF-8 a device name may have.
#[wasm_bindgen(js_name = maxDeviceNameLen)]
pub fn max_device_name_len() -> usize {
    wire::MAX_DEVICE_NAME_LEN
}

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export type PairingSpace = {
  token: string;
  secret: string;
  ownerSecrets: Uint8Array;
};
export type PairingEvent =
  | { type: "verified" }
  | { type: "awaitApproval"; deviceName: string; devicePub: Uint8Array }
  | {
      type: "granted";
      graph: Uint8Array;
      holderName: string;
      space: PairingSpace;
    }
  | { type: "rejected" };
export type PairingStep = { send?: Uint8Array; event?: PairingEvent };
"#;
