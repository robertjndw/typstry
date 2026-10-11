//! A device's identity and the saved form of a project's group state.
//!
//! openmls keeps its state in a provider storage. The in-memory one is a
//! plain map of byte strings, so saving is dumping that map in a compact
//! binary layout (the library's own serializer is test-only). One provider
//! holds one project, which keeps a state file self-contained and means a
//! removed project can be forgotten by deleting its file.
//!
//! The format is versioned by [`MLS_STATE_VERSION`], and an openmls upgrade
//! that changes what the map holds has to bump it as well, since old
//! entries would not parse.

use std::collections::HashMap;

use loro_protocol::{BytesReader, BytesWriter};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::{OpenMlsRustCrypto, RustCrypto};
use openmls_traits::OpenMlsProvider;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::{
    HpkeAeadType, HpkeConfig, HpkeKdfType, HpkeKemType, HpkeKeyPair, SignatureScheme,
};
use zeroize::Zeroizing;

use super::rotation::Tokens;
use super::{MlsError, SubmitPayload};
use crate::codec::{plausible_count, push_opt, read_flag, read_opt};
use crate::crypto::{KEY_LEN, PublicKey, random};
use crate::ds::Rotate;

/// First byte of a saved group state.
pub const MLS_STATE_VERSION: u8 = 1;

pub const DEVICE_ID_LEN: usize = 16;

pub fn hpke_config() -> HpkeConfig {
    HpkeConfig(
        HpkeKemType::DhKem25519,
        HpkeKdfType::HkdfSha256,
        HpkeAeadType::AesGcm128,
    )
}

/// Everything that makes a client one MLS member: the signature key that
/// signs its leaf, commits and records, the key edit links are sealed to,
/// and the random id its credential carries.
///
/// The signature key has to outlive the group state. Resyncing replaces the
/// old leaf only if the new one has the same signature key, and a new key
/// would leave a ghost leaf of the lost state in the tree.
pub struct LeafKeys {
    sig_seed: Zeroizing<[u8; KEY_LEN]>,
    hpke_ikm: Zeroizing<[u8; KEY_LEN]>,
    id: [u8; DEVICE_ID_LEN],
    signing: ed25519_dalek::SigningKey,
    hpke: HpkeKeyPair,
}

impl std::fmt::Debug for LeafKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeafKeys")
            .field("signer", &self.signing.verifying_key().to_bytes())
            .finish_non_exhaustive()
    }
}

impl LeafKeys {
    pub fn generate() -> Self {
        Self::from_parts(Zeroizing::new(random()), Zeroizing::new(random()), random())
            .expect("a random seed derives a key pair")
    }

    fn from_parts(
        sig_seed: Zeroizing<[u8; KEY_LEN]>,
        hpke_ikm: Zeroizing<[u8; KEY_LEN]>,
        id: [u8; DEVICE_ID_LEN],
    ) -> Result<Self, MlsError> {
        let signing = ed25519_dalek::SigningKey::from_bytes(&sig_seed);
        let hpke = RustCrypto::default()
            .derive_hpke_keypair(hpke_config(), hpke_ikm.as_ref())
            .map_err(super::mls)?;
        Ok(Self {
            sig_seed,
            hpke_ikm,
            id,
            signing,
            hpke,
        })
    }

    /// The identity as bytes, for a client that keeps it apart from the
    /// group state so it can resync after losing that state.
    pub fn export(&self) -> Zeroizing<Vec<u8>> {
        let mut out = Zeroizing::new(Vec::with_capacity(2 * KEY_LEN + DEVICE_ID_LEN));
        out.extend_from_slice(self.sig_seed.as_ref());
        out.extend_from_slice(self.hpke_ikm.as_ref());
        out.extend_from_slice(&self.id);
        out
    }

    /// Inverse of [`Self::export`].
    pub fn import(bytes: &[u8]) -> Result<Self, MlsError> {
        if bytes.len() != 2 * KEY_LEN + DEVICE_ID_LEN {
            return Err(MlsError::Malformed("device has the wrong length".into()));
        }
        let (seed, rest) = bytes.split_at(KEY_LEN);
        let (ikm, id) = rest.split_at(KEY_LEN);
        Self::from_parts(
            Zeroizing::new(seed.try_into().expect("split at 32")),
            Zeroizing::new(ikm.try_into().expect("split at 32")),
            id.try_into().expect("16 bytes remain"),
        )
    }

    /// An independent copy, for a resync that starts a new state with the
    /// same identity.
    pub fn duplicate(&self) -> Self {
        Self::from_parts(self.sig_seed.clone(), self.hpke_ikm.clone(), self.id)
            .expect("the same seed derives the same key pair")
    }

    pub fn signer_pub(&self) -> PublicKey {
        self.signing.verifying_key().to_bytes()
    }

    pub fn signing_key(&self) -> &ed25519_dalek::SigningKey {
        &self.signing
    }

    pub fn hpke_pub(&self) -> &[u8] {
        &self.hpke.public
    }

    pub fn hpke_private(&self) -> &[u8] {
        &self.hpke.private
    }

    /// The same key as an openmls signer. Ed25519 private keys there are the
    /// 32-byte seed, so one secret serves both libraries.
    pub fn signature_pair(&self) -> SignatureKeyPair {
        SignatureKeyPair::from_raw(
            SignatureScheme::ED25519,
            self.sig_seed.to_vec(),
            self.signer_pub().to_vec(),
        )
    }

    pub fn credential(&self) -> CredentialWithKey {
        CredentialWithKey {
            credential: BasicCredential::new(self.id.to_vec()).into(),
            signature_key: self.signer_pub().to_vec().into(),
        }
    }
}

/// The link, keyring and tokens a saved rotation commit switches to.
pub struct SavedNext {
    pub link: Zeroizing<String>,
    pub keyring: Zeroizing<Vec<u8>>,
    pub tokens: Tokens,
}

/// A commit that was submitted and not yet confirmed. The reply may have
/// been lost, so it has to survive a restart: the log decides its fate, and
/// a rotation's new link exists nowhere else until it does.
pub struct SavedPending {
    pub submit: SubmitPayload,
    pub next: Option<SavedNext>,
    pub profile: Option<Vec<u8>>,
}

/// What [`encode`] saves of a project group and [`decode`] returns.
pub struct SavedState {
    pub group_id: Vec<u8>,
    pub device: LeafKeys,
    /// The link secret, in its shareable form.
    pub link: Zeroizing<String>,
    /// The keyring as [`crate::crypto::Keyring::export`] writes it.
    pub keyring: Zeroizing<Vec<u8>>,
    pub profile: Vec<u8>,
    /// The join commit was never confirmed by the server, so the group is
    /// not known to exist.
    pub unconfirmed_join: bool,
    pub pending: Option<SavedPending>,
    pub entries: Vec<(Vec<u8>, Vec<u8>)>,
}

pub fn encode(state: &SavedState) -> Zeroizing<Vec<u8>> {
    let mut w = BytesWriter::new();
    w.push_byte(MLS_STATE_VERSION);
    w.push_var_bytes(&state.group_id);
    w.push_bytes(state.device.sig_seed.as_ref());
    w.push_bytes(state.device.hpke_ikm.as_ref());
    w.push_bytes(&state.device.id);
    w.push_var_string(&state.link);
    w.push_var_bytes(&state.keyring);
    w.push_var_bytes(&state.profile);
    w.push_byte(u8::from(state.unconfirmed_join) | u8::from(state.pending.is_some()) << 1);
    if let Some(pending) = &state.pending {
        encode_pending(&mut w, pending);
    }
    w.push_uleb128(state.entries.len() as u64);
    for (key, value) in &state.entries {
        w.push_var_bytes(key);
        w.push_var_bytes(value);
    }
    Zeroizing::new(w.finalize())
}

fn encode_pending(w: &mut BytesWriter, pending: &SavedPending) {
    let submit = &pending.submit;
    w.push_uleb128(submit.epoch);
    w.push_var_bytes(&submit.commit);
    w.push_var_bytes(&submit.group_info);
    push_opt(w, submit.keyring.as_deref());
    push_opt(w, submit.envelope.as_deref());
    match &submit.rotate {
        Some(rotate) => {
            w.push_byte(1);
            w.push_var_string(&rotate.edit_token);
            w.push_var_string(&rotate.view_token);
        }
        None => w.push_byte(0),
    }
    match &pending.next {
        Some(next) => {
            w.push_byte(1);
            w.push_var_string(&next.link);
            w.push_var_bytes(&next.keyring);
            push_opt(w, next.tokens.edit.as_deref().map(str::as_bytes));
            w.push_var_string(&next.tokens.view);
        }
        None => w.push_byte(0),
    }
    push_opt(w, pending.profile.as_deref());
}

fn decode_pending(r: &mut BytesReader<'_>) -> Result<SavedPending, String> {
    let epoch = r.read_uleb128()?;
    let commit = r.read_var_bytes()?.to_vec();
    let group_info = r.read_var_bytes()?.to_vec();
    let keyring = read_opt(r)?;
    let envelope = read_opt(r)?;
    let rotate = if read_flag(r)? {
        Some(Rotate {
            edit_token: r.read_var_string()?,
            view_token: r.read_var_string()?,
        })
    } else {
        None
    };
    let next = if read_flag(r)? {
        let link = Zeroizing::new(r.read_var_string()?);
        let keyring = Zeroizing::new(r.read_var_bytes()?.to_vec());
        let edit = read_opt(r)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|e| e.to_string())?;
        let view = r.read_var_string()?;
        Some(SavedNext {
            link,
            keyring,
            tokens: Tokens { edit, view },
        })
    } else {
        None
    };
    let profile = read_opt(r)?;
    Ok(SavedPending {
        submit: SubmitPayload {
            epoch,
            commit,
            group_info,
            keyring,
            envelope,
            rotate,
        },
        next,
        profile,
    })
}

pub fn decode(bytes: &[u8]) -> Result<SavedState, MlsError> {
    let bad = |why: String| MlsError::Malformed(format!("saved state: {why}"));
    let mut r = BytesReader::new(bytes);
    match r.read_byte().map_err(bad)? {
        MLS_STATE_VERSION => {}
        newer => return Err(MlsError::NewerState(newer)),
    }
    let group_id = r.read_var_bytes().map_err(bad)?.to_vec();
    let seed = Zeroizing::new(
        r.read_bytes(KEY_LEN)
            .map_err(bad)?
            .try_into()
            .expect("read 32 bytes"),
    );
    let ikm = Zeroizing::new(
        r.read_bytes(KEY_LEN)
            .map_err(bad)?
            .try_into()
            .expect("read 32 bytes"),
    );
    let id = r
        .read_bytes(DEVICE_ID_LEN)
        .map_err(bad)?
        .try_into()
        .expect("read 16 bytes");
    let link = Zeroizing::new(r.read_var_string().map_err(bad)?);
    let keyring = Zeroizing::new(r.read_var_bytes().map_err(bad)?.to_vec());
    let profile = r.read_var_bytes().map_err(bad)?.to_vec();
    let flags = r.read_byte().map_err(bad)?;
    if flags & !0b11 != 0 {
        return Err(bad(format!("unknown flags {flags:#04x}")));
    }
    let pending = if flags & 2 != 0 {
        Some(decode_pending(&mut r).map_err(bad)?)
    } else {
        None
    };
    // Every entry is at least two length bytes.
    let count = plausible_count(&mut r, 2).map_err(bad)?;
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let key = r.read_var_bytes().map_err(bad)?.to_vec();
        let value = r.read_var_bytes().map_err(bad)?.to_vec();
        entries.push((key, value));
    }
    if r.remaining() != 0 {
        return Err(bad("trailing bytes".into()));
    }
    Ok(SavedState {
        group_id,
        device: LeafKeys::from_parts(seed, ikm, id)?,
        link,
        keyring,
        profile,
        unconfirmed_join: flags & 1 != 0,
        pending,
        entries,
    })
}

/// The provider's whole storage, in a stable order so equal state saves to
/// equal bytes.
pub fn dump(provider: &OpenMlsRustCrypto) -> Vec<(Vec<u8>, Vec<u8>)> {
    let values = provider.storage().values.read().expect("storage lock");
    let mut entries: Vec<_> = values.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    entries.sort();
    entries
}

pub fn restore(entries: Vec<(Vec<u8>, Vec<u8>)>) -> OpenMlsRustCrypto {
    let provider = OpenMlsRustCrypto::default();
    let map: HashMap<_, _> = entries.into_iter().collect();
    *provider.storage().values.write().expect("storage lock") = map;
    provider
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_survives_saving() {
        let device = LeafKeys::generate();
        let copy = device.duplicate();
        assert_eq!(copy.signer_pub(), device.signer_pub());
        assert_eq!(copy.hpke_pub(), device.hpke_pub());
        assert_eq!(copy.hpke_private(), device.hpke_private());
        assert_eq!(
            copy.signature_pair().public(),
            device.signature_pair().public()
        );
    }
}
