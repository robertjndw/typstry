//! The relay's paths and close reasons, so the web app does not spell them
//! out a second time.

use serde::Serialize;
use typstry_wire::relay::{self as wire, close_reason};
use wasm_bindgen::prelude::*;

use crate::error::from_serde;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseReasonsDto {
    expired: &'static str,
    no_channel: &'static str,
    rate_limited: &'static str,
    too_many_frames: &'static str,
    peer_left: &'static str,
}

/// The reasons the relay closes a socket with, by name.
#[wasm_bindgen(js_name = relayCloseReasons, unchecked_return_type = "RelayCloseReasons")]
pub fn relay_close_reasons() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&CloseReasonsDto {
        expired: close_reason::EXPIRED,
        no_channel: close_reason::NO_CHANNEL,
        rate_limited: close_reason::RATE_LIMITED,
        too_many_frames: close_reason::TOO_MANY_FRAMES,
        peer_left: close_reason::PEER_LEFT,
    })
    .map_err(from_serde)
}

/// Where `POST` allocates a relay channel.
#[wasm_bindgen(js_name = relayApiPath)]
pub fn relay_api_path() -> String {
    wire::RELAY_API_PATH.into()
}

/// The relay socket, joined with `?channel=N`.
#[wasm_bindgen(js_name = relayWsPath)]
pub fn relay_ws_path() -> String {
    wire::RELAY_WS_PATH.into()
}

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export interface RelayCloseReasons {
  /** The channel outlived its lifetime. */
  expired: string;
  /** Unknown, expired and full channels look the same from outside. */
  noChannel: string;
  /** The peer sent frames faster than the server allows. */
  rateLimited: string;
  /** More was sent to a peer that has not joined yet than the server holds. */
  tooManyFrames: string;
  /** The other peer closed its socket. */
  peerLeft: string;
}
"#;
