//! Links, keyrings and the encryption of records and blobs.

use serde::{Deserialize, Serialize};
use typstry_wire::crypto::{
    self as wire, BLOB_OVERHEAD, CryptoError, PRESENCE_CONTEXT, RecordSigner,
};
use typstry_wire::elo::Record;
use wasm_bindgen::prelude::*;

use crate::error::{from_crypto, from_serde, invalid};

/// What a share link holds: the view key and the attestation key, and for an
/// edit link the secret both come from.
#[wasm_bindgen]
pub struct LinkSecret {
    pub(crate) inner: wire::LinkSecret,
}

#[wasm_bindgen]
impl LinkSecret {
    #[wasm_bindgen(js_name = generateEdit)]
    pub fn generate_edit() -> LinkSecret {
        Self {
            inner: wire::LinkSecret::generate_edit(),
        }
    }

    /// Throws `MalformedKey`, or `NewerVersion` for a kind of secret only a
    /// newer typstry knows.
    pub fn parse(raw: &str) -> Result<LinkSecret, JsValue> {
        wire::LinkSecret::from_base64url(raw)
            .map(|inner| Self { inner })
            .map_err(from_crypto)
    }

    /// The shareable form: the edit secret for an edit link, else the view
    /// secret.
    #[wasm_bindgen(js_name = toBase64url)]
    pub fn to_base64url(&self) -> String {
        self.inner.to_base64url().to_string()
    }

    #[wasm_bindgen(js_name = viewSecret)]
    pub fn view_secret(&self) -> String {
        self.inner.view_secret().to_string()
    }

    #[wasm_bindgen(js_name = canAttest)]
    pub fn can_attest(&self) -> bool {
        self.inner.can_attest()
    }

    #[wasm_bindgen(js_name = attestPub)]
    pub fn attest_pub(&self) -> Vec<u8> {
        self.inner.attest_pub().to_vec()
    }

    /// A short public tag of the link, safe to log.
    pub fn fingerprint(&self) -> String {
        self.inner.fingerprint()
    }
}

/// What a link fragment holds: `"edit"`, `"view"`, `"newer"` for a kind
/// only a newer typstry knows, or `undefined` for anything unusable.
#[wasm_bindgen(js_name = secretKind)]
pub fn secret_kind(raw: &str) -> Option<String> {
    match wire::LinkSecret::from_base64url(raw) {
        Ok(link) if link.can_attest() => Some("edit".into()),
        Ok(_) => Some("view".into()),
        Err(CryptoError::NewerVersion(_)) => Some("newer".into()),
        Err(_) => None,
    }
}

/// First byte of sealed blobs and presence, and of a record's body.
#[wasm_bindgen(js_name = sealVersion)]
pub fn seal_version() -> u8 {
    wire::SEAL_VERSION
}

#[wasm_bindgen(js_name = recordVersion)]
pub fn record_version() -> u8 {
    wire::RECORD_VERSION
}

/// Bytes a sealed blob adds to its plaintext.
#[wasm_bindgen(js_name = blobOverhead)]
pub fn blob_overhead() -> usize {
    BLOB_OVERHEAD
}

/// The doc keys of every generation of a project.
#[wasm_bindgen]
pub struct Keyring {
    pub(crate) inner: wire::Keyring,
}

#[wasm_bindgen]
impl Keyring {
    /// The keyring of a new project: generation 1 under `link`.
    pub fn generate(link: &LinkSecret) -> Keyring {
        Self {
            inner: wire::Keyring::new(&link.inner),
        }
    }

    /// The keyring after a rotation to `link`: everything up to now plus a
    /// fresh doc key for the next generation.
    pub fn next(&self, link: &LinkSecret) -> Keyring {
        Self {
            inner: self.inner.next(&link.inner),
        }
    }

    /// Checks the keyring's signature against the link, opens it and checks
    /// that the link is the newest generation's. Throws `BadSignature`,
    /// `Decrypt`, `KeyMismatch`, `NewerVersion`, `Truncated` or
    /// `MalformedKeyring`.
    #[wasm_bindgen(js_name = openVerified)]
    pub fn open_verified(link: &LinkSecret, bytes: &[u8]) -> Result<Keyring, JsValue> {
        wire::Keyring::open_verified(&link.inner, bytes)
            .map(|inner| Self { inner })
            .map_err(from_crypto)
    }

    /// Seals the keyring under the link and signs it. Edit links only.
    #[wasm_bindgen(js_name = sealSigned)]
    pub fn seal_signed(&self, link: &LinkSecret) -> Result<Vec<u8>, JsValue> {
        self.inner.seal_signed(&link.inner).map_err(from_crypto)
    }

    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> u32 {
        self.inner.generation()
    }

    /// The keyring unprotected, for this device's own storage only.
    pub fn export(&self) -> Vec<u8> {
        self.inner.export().to_vec()
    }

    pub fn import(bytes: &[u8]) -> Result<Keyring, JsValue> {
        wire::Keyring::import(bytes)
            .map(|inner| Self { inner })
            .map_err(from_crypto)
    }
}

/// Signs records and presence for one device.
#[wasm_bindgen]
pub struct Signer {
    pub(crate) inner: Box<dyn RecordSigner>,
}

#[wasm_bindgen]
impl Signer {
    /// A fresh device key that the edit link attests for `generation`. The
    /// stand-in for a group member's leaf key, for a client that has no
    /// group state. Throws `ReadOnly` for a view link.
    pub fn attested(link: &LinkSecret, generation: u32) -> Result<Signer, JsValue> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| invalid("Random", e))?;
        let signer =
            wire::LocalSigner::try_attested(seed, &link.inner, generation).map_err(from_crypto)?;
        Ok(Self {
            inner: Box::new(signer),
        })
    }

    /// The Ed25519 key that records and presence from this device verify
    /// under.
    #[wasm_bindgen(getter, js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.inner.public_key().to_vec()
    }

    /// Whether this device may write records of `generation`.
    #[wasm_bindgen(js_name = canWrite)]
    pub fn can_write(&self, generation: u32) -> bool {
        self.inner.attestation(generation).is_some()
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct VvEntry {
    pub peer: String,
    pub counter: u32,
}

/// A record after decryption.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecordDto {
    Delta {
        peer: String,
        start: u32,
        end: u32,
        #[serde(with = "serde_bytes")]
        plaintext: Vec<u8>,
        #[serde(with = "serde_bytes")]
        signer: Vec<u8>,
    },
    Snapshot {
        vv: Vec<VvEntry>,
        #[serde(with = "serde_bytes")]
        plaintext: Vec<u8>,
        #[serde(with = "serde_bytes")]
        signer: Vec<u8>,
    },
}

impl From<wire::DecryptedRecord> for RecordDto {
    fn from(out: wire::DecryptedRecord) -> Self {
        let signer = out.signer_pub.to_vec();
        // Loro counters fit i32, which the parser enforces.
        match out.record {
            Record::Delta { peer, start, end } => Self::Delta {
                peer: peer.to_string(),
                start: start as u32,
                end: end as u32,
                plaintext: out.plaintext,
                signer,
            },
            Record::Snapshot { vv } => {
                let mut vv: Vec<_> = vv
                    .into_iter()
                    .map(|(peer, counter)| VvEntry {
                        peer: peer.to_string(),
                        counter: counter as u32,
                    })
                    .collect();
                vv.sort_by(|a, b| a.peer.cmp(&b.peer));
                Self::Snapshot {
                    vv,
                    plaintext: out.plaintext,
                    signer,
                }
            }
        }
    }
}

fn peer_id(peer: &str) -> Result<u64, JsValue> {
    peer.parse()
        .map_err(|_| invalid("MalformedRecord", format!("{peer:?} is not a peer id")))
}

/// A keyring's keys put to work on records, blobs and presence.
#[wasm_bindgen]
pub struct DocKeys {
    pub(crate) inner: wire::DocKeys,
}

#[wasm_bindgen]
impl DocKeys {
    #[wasm_bindgen(constructor)]
    pub fn new(keyring: &Keyring) -> DocKeys {
        Self {
            inner: wire::DocKeys::new(keyring.inner.clone()),
        }
    }

    /// The generation new data is written in.
    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> u32 {
        self.inner.generation()
    }

    /// The fingerprint sent in clear with every record of the current
    /// generation.
    #[wasm_bindgen(getter, js_name = keyId)]
    pub fn key_id(&self) -> String {
        self.inner.key_id().to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn keyring(&self) -> Keyring {
        Keyring {
            inner: self.inner.keyring().clone(),
        }
    }

    /// Encrypts and signs the Loro updates for ops `[start, end)` of `peer`.
    /// Throws `ReadOnly` when `signer` cannot write the current generation.
    #[wasm_bindgen(js_name = encryptDelta)]
    pub fn encrypt_delta(
        &self,
        signer: &Signer,
        peer: &str,
        start: u32,
        end: u32,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        if end <= start {
            return Err(invalid(
                "MalformedRecord",
                format!("delta span {start}..{end} is empty"),
            ));
        }
        self.inner
            .encrypt_delta(
                signer.inner.as_ref(),
                peer_id(peer)?,
                start.into(),
                end.into(),
                plaintext,
            )
            .map_err(from_crypto)
    }

    /// Encrypts and signs a snapshot covering `vv`, an array of
    /// `{ peer, counter }` in any order.
    #[wasm_bindgen(js_name = encryptSnapshot)]
    pub fn encrypt_snapshot(
        &self,
        signer: &Signer,
        #[wasm_bindgen(unchecked_param_type = "{ peer: string; counter: number }[]")] vv: JsValue,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let entries: Vec<VvEntry> = serde_wasm_bindgen::from_value(vv).map_err(from_serde)?;
        let vv = entries
            .iter()
            .map(|e| Ok((peer_id(&e.peer)?, u64::from(e.counter))))
            .collect::<Result<Vec<_>, JsValue>>()?;
        self.inner
            .encrypt_snapshot(signer.inner.as_ref(), &vv, plaintext)
            .map_err(from_crypto)
    }

    /// Parses, verifies and decrypts one record. Throws `KeyMismatch`,
    /// `UnknownGeneration` (fetch the keyring again), `NotEditor`,
    /// `BadSignature`, `Decrypt`, `NewerVersion`, `Truncated` or
    /// `MalformedRecord`.
    #[wasm_bindgen(js_name = decryptRecord, unchecked_return_type = "DecryptedRecord")]
    pub fn decrypt_record(&self, record: &[u8]) -> Result<JsValue, JsValue> {
        let out = self.inner.decrypt_record(record).map_err(from_crypto)?;
        serde_wasm_bindgen::to_value(&RecordDto::from(out)).map_err(from_serde)
    }

    #[wasm_bindgen(js_name = sealBlob)]
    pub fn seal_blob(&self, plaintext: &[u8]) -> Vec<u8> {
        self.inner.seal_blob(plaintext)
    }

    #[wasm_bindgen(js_name = openBlob)]
    pub fn open_blob(&self, sealed: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.open_blob(sealed).map_err(from_crypto)
    }

    /// Presence under the doc key, for a client without a group epoch to
    /// seal it under. Not signed, so it says nothing about who sent it.
    #[wasm_bindgen(js_name = sealPresence)]
    pub fn seal_presence(&self, plaintext: &[u8]) -> Vec<u8> {
        self.inner.seal(plaintext, PRESENCE_CONTEXT)
    }

    #[wasm_bindgen(js_name = openPresence)]
    pub fn open_presence(&self, sealed: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .open(sealed, PRESENCE_CONTEXT)
            .map_err(from_crypto)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_throwaway_editor_writes_records_its_keyring_accepts() {
        let link = wire::LinkSecret::generate_edit();
        let keys = wire::DocKeys::new(wire::Keyring::new(&link));
        let signer = Signer::attested(
            &LinkSecret {
                inner: link.clone(),
            },
            keys.generation(),
        )
        .ok()
        .unwrap();
        assert!(signer.can_write(1));
        assert!(!signer.can_write(2));
        let record = keys
            .encrypt_delta(signer.inner.as_ref(), 7, 0, 3, b"ops")
            .unwrap();
        let out = RecordDto::from(keys.decrypt_record(&record).unwrap());
        assert_eq!(
            out,
            RecordDto::Delta {
                peer: "7".into(),
                start: 0,
                end: 3,
                plaintext: b"ops".to_vec(),
                signer: signer.inner.public_key().to_vec(),
            }
        );
    }

    #[test]
    fn secret_kinds() {
        let link = wire::LinkSecret::generate_edit();
        assert_eq!(secret_kind(&link.to_base64url()).as_deref(), Some("edit"));
        assert_eq!(secret_kind(&link.view_secret()).as_deref(), Some("view"));
        assert_eq!(secret_kind("nope"), None);
    }
}
