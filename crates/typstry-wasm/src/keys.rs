//! Links, keyrings and the encryption of records and blobs.

use serde::{Deserialize, Serialize};
use typstry_wire::crypto::{
    self as wire, BLOB_OVERHEAD, CryptoError, PRESENCE_CONTEXT, RecordSigner,
};
use typstry_wire::elo::Record;
use typstry_wire::identity;
use wasm_bindgen::prelude::*;

use crate::error::{
    from_adopt, from_crypto, from_graph, from_recover, from_recovery, from_serde, invalid,
};

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

/// The key one device signs for a person with. Keep its export on this
/// device only: it is never sent anywhere, and projects only see bindings
/// made with it.
#[wasm_bindgen]
pub struct DeviceKey {
    inner: identity::DeviceKey,
}

#[wasm_bindgen]
impl DeviceKey {
    pub fn generate() -> DeviceKey {
        Self {
            inner: identity::DeviceKey::generate(),
        }
    }

    /// Throws `MalformedKey` for anything but an `export`.
    pub fn import(bytes: &[u8]) -> Result<DeviceKey, JsValue> {
        identity::DeviceKey::import(bytes)
            .map(|inner| Self { inner })
            .map_err(from_crypto)
    }

    pub fn export(&self) -> Vec<u8> {
        self.inner.export().to_vec()
    }

    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.inner.public().to_vec()
    }
}

/// The public half of a `DeviceKey.export` seed, without making a
/// `DeviceKey` to free again. Throws `MalformedKey`.
#[wasm_bindgen(js_name = devicePublicKey)]
pub fn device_public_key(seed: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(device_key(seed)?.public().to_vec())
}

/// The device key from its `DeviceKey.export` bytes. Bytes rather than the
/// class, because wasm-bindgen would move the key out of the caller's object.
pub(crate) fn device_key(seed: &[u8]) -> Result<identity::DeviceKey, JsValue> {
    identity::DeviceKey::import(seed).map_err(from_crypto)
}

fn public_key(bytes: &[u8]) -> Result<wire::PublicKey, JsValue> {
    wire::PublicKey::try_from(bytes).map_err(|_| from_crypto(CryptoError::MalformedKey))
}

#[derive(Serialize)]
struct DeviceDto {
    #[serde(with = "serde_bytes", rename = "pub")]
    public: Vec<u8>,
    state: &'static str,
    recovery: bool,
}

/// Which device keys make up one person: a hash-linked set of signed entries
/// that merges by union. Devices sign with the seed they hold; the graph
/// refuses entries from a device that is not valid in it.
#[wasm_bindgen]
pub struct PersonGraph {
    pub(crate) inner: identity::PersonGraph,
}

#[wasm_bindgen]
impl PersonGraph {
    /// A new person whose first device is the one with `deviceSeed`.
    pub fn genesis(device_seed: &[u8]) -> Result<PersonGraph, JsValue> {
        Ok(Self {
            inner: identity::PersonGraph::genesis(&device_key(device_seed)?),
        })
    }

    /// Throws `Malformed`, `BadSignature`, `TooLarge`, or `NewerVersion` for
    /// a graph a newer typstry wrote.
    pub fn decode(bytes: &[u8]) -> Result<PersonGraph, JsValue> {
        identity::PersonGraph::decode(bytes)
            .map(|inner| Self { inner })
            .map_err(from_graph)
    }

    pub fn encode(&self) -> Vec<u8> {
        self.inner.encode()
    }

    /// Adds a device, signed by `deviceSeed`'s device. `recovery` marks it as
    /// a recovery device. Throws `NotValid` when the signer is not a valid
    /// device of the person.
    #[wasm_bindgen(js_name = addDevice)]
    pub fn add_device(
        &mut self,
        device_seed: &[u8],
        device_pub: &[u8],
        recovery: Option<bool>,
    ) -> Result<(), JsValue> {
        let flags = if recovery.unwrap_or(false) {
            identity::FLAG_RECOVERY
        } else {
            0
        };
        let kind = identity::EntryKind::AddDevice {
            device: public_key(device_pub)?,
            flags,
        };
        self.inner
            .append(&device_key(device_seed)?, kind)
            .map(drop)
            .map_err(from_graph)
    }

    /// Vouches for `devicePub` as an ordinary device, signed by
    /// `deviceSeed`'s device, the way pairing does. Returns whether an entry
    /// was added: false for a device that is valid already, so a retry does
    /// not add it twice. Throws `NotValid` when the signer is not valid, even
    /// with nothing to add, and `DeviceRevoked` for a device revoked before.
    pub fn vouch(&mut self, device_seed: &[u8], device_pub: &[u8]) -> Result<bool, JsValue> {
        self.inner
            .vouch(&device_key(device_seed)?, &public_key(device_pub)?)
            .map_err(from_graph)
    }

    /// Revokes a device for good, signed by `deviceSeed`'s device. Throws
    /// `NotValid` like `addDevice`.
    pub fn revoke(&mut self, device_seed: &[u8], device_pub: &[u8]) -> Result<(), JsValue> {
        let kind = identity::EntryKind::RevokeDevice {
            device: public_key(device_pub)?,
        };
        self.inner
            .append(&device_key(device_seed)?, kind)
            .map(drop)
            .map_err(from_graph)
    }

    /// Sets the person's own profile (the `{"name","color"}` JSON bytes),
    /// signed by `deviceSeed`'s device. Append one only when the profile
    /// really changed: entries stay in the graph for good and it holds 48.
    /// Throws `NotValid` for a signer that is not valid or is a recovery
    /// device, and `TooLarge` past 256 bytes or the graph's caps.
    #[wasm_bindgen(js_name = setProfile)]
    pub fn set_profile(&mut self, device_seed: &[u8], profile: &[u8]) -> Result<(), JsValue> {
        let kind = identity::EntryKind::SetProfile {
            profile: profile.to_vec(),
        };
        self.inner
            .append(&device_key(device_seed)?, kind)
            .map(drop)
            .map_err(from_graph)
    }

    /// The person's profile bytes, undefined while none was ever set.
    pub fn profile(&self) -> Option<Vec<u8>> {
        self.inner.profile().map(<[u8]>::to_vec)
    }

    /// The device that added `devicePub`, undefined for the first device.
    #[wasm_bindgen(js_name = addedBy)]
    pub fn added_by(&self, device_pub: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        Ok(self
            .inner
            .added_by(&public_key(device_pub)?)
            .map(|device| device.to_vec()))
    }

    /// The state of a device, `"valid"`, `"revoked"` or `"unknown"`.
    #[wasm_bindgen(js_name = deviceState)]
    pub fn device_state(&self, device_pub: &[u8]) -> Result<String, JsValue> {
        Ok(state_name(self.inner.device_state(&public_key(device_pub)?)).into())
    }

    /// Every valid or revoked device, sorted by key.
    #[wasm_bindgen(unchecked_return_type = "GraphDevice[]")]
    pub fn devices(&self) -> Result<JsValue, JsValue> {
        let devices: Vec<_> = self
            .inner
            .devices()
            .into_iter()
            .map(|info| DeviceDto {
                public: info.device.to_vec(),
                state: state_name(info.state),
                recovery: info.recovery,
            })
            .collect();
        serde_wasm_bindgen::to_value(&devices).map_err(from_serde)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryDto {
    #[serde(with = "serde_bytes")]
    device_seed: Vec<u8>,
    words: String,
}

/// A device key spelled as words, to keep on paper instead of a device.
/// Add it with `addDevice(seed, pub, true)`; it can then add and revoke
/// devices but never joins a project.
#[wasm_bindgen]
pub struct RecoveryKey;

#[wasm_bindgen]
impl RecoveryKey {
    #[wasm_bindgen(unchecked_return_type = "GeneratedRecoveryKey")]
    pub fn generate() -> Result<JsValue, JsValue> {
        let (key, words) = identity::RecoveryKey::generate();
        serde_wasm_bindgen::to_value(&RecoveryDto {
            device_seed: key.export().to_vec(),
            words,
        })
        .map_err(from_serde)
    }

    /// The `DeviceKey.export` bytes for `words`, in any case and with any
    /// spacing or hyphens. Throws `BadRecoveryWords` for a typo, a wrong
    /// count or a failed checksum.
    #[wasm_bindgen(js_name = fromWords)]
    pub fn from_words(words: &str) -> Result<Vec<u8>, JsValue> {
        identity::RecoveryKey::from_words(words)
            .map(|key| key.export().to_vec())
            .map_err(from_recovery)
    }
}

/// The graph to store when `incoming` (a `PersonGraph.encode`) arrives and
/// `stored` is what this device holds, `ownPub` being this device's key.
/// The same person merges; another person replaces the stored graph only
/// with `replace` or when this device is no longer valid in it, and only if
/// `incoming` lists this device. Throws `ForeignIdentity`, `NotListed`, or
/// what decoding or merging throws.
#[wasm_bindgen(js_name = adoptGraph)]
pub fn adopt_graph(
    stored: Option<Vec<u8>>,
    incoming: &[u8],
    own_pub: &[u8],
    replace: bool,
) -> Result<Vec<u8>, JsValue> {
    let stored = stored
        .map(|bytes| identity::PersonGraph::decode(&bytes))
        .transpose()
        .map_err(from_graph)?;
    let incoming = identity::PersonGraph::decode(incoming).map_err(from_graph)?;
    identity::adopt(stored.as_ref(), &incoming, &public_key(own_pub)?, replace)
        .map(|graph| graph.encode())
        .map_err(from_adopt)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RecoverOptionsDto {
    keep_others: bool,
    replace: bool,
}

#[derive(Serialize)]
struct RecoveredDto {
    #[serde(with = "serde_bytes")]
    graph: Vec<u8>,
    revoked: Vec<serde_bytes::ByteBuf>,
}

/// Makes the device `ownPub` a device of the person whose recovery key
/// `recoverySeed` (from `RecoveryKey.fromWords`) is, picked from `graphs`
/// (as `graphsInGroupInfo` returns them), and unless `keepOthers` revokes
/// the person's other ordinary devices. `stored` is the graph this device
/// holds: one of the same person is merged in first, so its revokes count,
/// and one of another person is left behind as `adoptGraph` allows. Returns
/// `{ graph, revoked }`, the graph ready to store. Throws
/// `UnknownRecoveryKey`, `RecoveryKeyRevoked`, `OwnDeviceRevoked` (this
/// device key can never be the person's again; make a new one),
/// `ForeignIdentity`, or what decoding or the graph throws.
#[wasm_bindgen(js_name = recoverIdentity, unchecked_return_type = "RecoveredIdentity")]
pub fn recover_identity(
    #[wasm_bindgen(unchecked_param_type = "Uint8Array[]")] graphs: JsValue,
    recovery_seed: &[u8],
    own_pub: &[u8],
    stored: Option<Vec<u8>>,
    #[wasm_bindgen(unchecked_param_type = "RecoverOptions | undefined")] options: JsValue,
) -> Result<JsValue, JsValue> {
    let graphs: Vec<serde_bytes::ByteBuf> =
        serde_wasm_bindgen::from_value(graphs).map_err(from_serde)?;
    let graphs = graphs
        .iter()
        .map(|bytes| identity::PersonGraph::decode(bytes))
        .collect::<Result<Vec<_>, _>>()
        .map_err(from_graph)?;
    let stored = stored
        .map(|bytes| identity::PersonGraph::decode(&bytes))
        .transpose()
        .map_err(from_graph)?;
    let options: RecoverOptionsDto = if options.is_undefined() || options.is_null() {
        RecoverOptionsDto::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(from_serde)?
    };
    let recovered = identity::recover(
        &graphs,
        &device_key(recovery_seed)?,
        &public_key(own_pub)?,
        stored.as_ref(),
        identity::RecoverOptions {
            keep_others: options.keep_others,
            replace: options.replace,
        },
    )
    .map_err(from_recover)?;
    serde_wasm_bindgen::to_value(&RecoveredDto {
        graph: recovered.graph.encode(),
        revoked: recovered
            .revoked
            .iter()
            .map(|device| serde_bytes::ByteBuf::from(device.to_vec()))
            .collect(),
    })
    .map_err(from_serde)
}

pub(crate) fn state_name(state: identity::DeviceState) -> &'static str {
    match state {
        identity::DeviceState::Valid => "valid",
        identity::DeviceState::Revoked => "revoked",
        identity::DeviceState::Unknown => "unknown",
    }
}

/// The short public tag of a person id read from a roster, for people to
/// compare out of band. Throws `MalformedKey` for bytes that are not an id.
#[wasm_bindgen(js_name = personFingerprint)]
pub fn person_fingerprint(id: &[u8]) -> Result<String, JsValue> {
    let id =
        identity::PersonId::try_from(id).map_err(|_| from_crypto(CryptoError::MalformedKey))?;
    Ok(identity::person_fingerprint(&id))
}

/// The tag of a device key, the same one the CLI prints. Throws
/// `MalformedKey` for bytes that are not a public key.
#[wasm_bindgen(js_name = deviceFingerprint)]
pub fn device_fingerprint(device: &[u8]) -> Result<String, JsValue> {
    Ok(identity::device_fingerprint(&public_key(device)?))
}

#[wasm_bindgen(typescript_custom_section)]
const GRAPH_TYPES: &str = r#"
export interface GraphDevice {
  pub: Uint8Array;
  state: "valid" | "revoked";
  recovery: boolean;
}
export interface RecoverOptions {
  /** Leave the person's other devices valid. */
  keepOthers?: boolean;
  /** Leave behind another person this device is a working device of. */
  replace?: boolean;
}
export interface RecoveredIdentity {
  /** `PersonGraph.encode` bytes to store, with this device valid. */
  graph: Uint8Array;
  /** The device keys the recovery revoked. */
  revoked: Uint8Array[];
}
export interface GeneratedRecoveryKey {
  deviceSeed: Uint8Array;
  /** Seventeen words to write down; never stored by typstry. */
  words: string;
}
"#;

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
