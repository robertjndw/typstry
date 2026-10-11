//! Presence sealed under an MLS epoch.

use serde::Serialize;
use typstry_wire::crypto::{self as wire, PublicKey, RecordSigner};
use wasm_bindgen::prelude::*;

use crate::error::{from_crypto, from_serde};

/// An epoch's presence key with what it takes to speak and listen in that
/// epoch: this device's signer and leaf, and the epoch's roster. Take a new
/// one from the group whenever its epoch changes.
#[wasm_bindgen]
pub struct PresenceKey {
    key: wire::PresenceKey,
    signer: Box<dyn RecordSigner>,
    leaf: u32,
    roster: Vec<(u32, PublicKey)>,
}

impl PresenceKey {
    pub fn new(
        key: wire::PresenceKey,
        signer: Box<dyn RecordSigner>,
        leaf: u32,
        roster: Vec<(u32, PublicKey)>,
    ) -> Self {
        Self {
            key,
            signer,
            leaf,
            roster,
        }
    }
}

#[derive(Serialize)]
struct Opened {
    leaf: u32,
    #[serde(with = "serde_bytes")]
    signer: Vec<u8>,
    #[serde(with = "serde_bytes")]
    plaintext: Vec<u8>,
}

#[wasm_bindgen]
impl PresenceKey {
    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> f64 {
        self.key.epoch() as f64
    }

    /// Seals and signs `plaintext` as this device.
    pub fn seal(&self, plaintext: &[u8]) -> Vec<u8> {
        self.key.seal(self.signer.as_ref(), self.leaf, plaintext)
    }

    /// Opens an update of this epoch from a member, returning
    /// `{ leaf, signer, plaintext }`. Throws `WrongEpoch` (drop the update),
    /// `BadSignature` for a leaf that is not in the roster or a signature
    /// that does not match it, `Decrypt`, `Truncated` or `NewerVersion`.
    #[wasm_bindgen(unchecked_return_type = "Opened")]
    pub fn open(&self, sealed: &[u8]) -> Result<JsValue, JsValue> {
        let (leaf, plaintext) = self
            .key
            .open(sealed, |leaf| {
                self.roster
                    .iter()
                    .find(|(l, _)| *l == leaf)
                    .map(|(_, key)| *key)
            })
            .map_err(from_crypto)?;
        let signer = self
            .roster
            .iter()
            .find(|(l, _)| *l == leaf)
            .map(|(_, key)| key.to_vec())
            .unwrap_or_default();
        serde_wasm_bindgen::to_value(&Opened {
            leaf,
            signer,
            plaintext,
        })
        .map_err(from_serde)
    }
}
