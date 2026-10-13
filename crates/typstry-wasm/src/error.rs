//! JavaScript errors with a stable `kind`.
//!
//! The kinds are API: the web app maps them to its own error classes and to
//! what it tells the user. Details that callers act on ride along as extra
//! properties (`generation`, `version`, `epoch`).

use std::fmt::Display;

use typstry_wire::crypto::CryptoError;
use typstry_wire::identity::{AdoptError, GraphError, RecoverError, RecoveryError};
use typstry_wire::mls::MlsError;
use typstry_wire::pairing::{CodeError, PairError};
use wasm_bindgen::JsValue;

#[derive(Debug, PartialEq)]
pub struct Kind {
    pub kind: &'static str,
    /// A number the caller needs, named after the property it is set as.
    pub detail: Option<(&'static str, f64)>,
}

const fn plain(kind: &'static str) -> Kind {
    Kind { kind, detail: None }
}

pub fn crypto_kind(error: &CryptoError) -> Kind {
    match error {
        CryptoError::MalformedKey => plain("MalformedKey"),
        CryptoError::KeyMismatch(_) => plain("KeyMismatch"),
        CryptoError::UnknownGeneration(generation) => Kind {
            kind: "UnknownGeneration",
            detail: Some(("generation", f64::from(*generation))),
        },
        CryptoError::MalformedRecord(_) => plain("MalformedRecord"),
        CryptoError::MalformedKeyring(_) => plain("MalformedKeyring"),
        CryptoError::Truncated => plain("Truncated"),
        CryptoError::NotEditor => plain("NotEditor"),
        CryptoError::BadSignature => plain("BadSignature"),
        CryptoError::Decrypt => plain("Decrypt"),
        CryptoError::WrongEpoch(epoch) => Kind {
            kind: "WrongEpoch",
            detail: Some(("epoch", *epoch as f64)),
        },
        CryptoError::ReadOnly => plain("ReadOnly"),
        CryptoError::NewerVersion(version) => Kind {
            kind: "NewerVersion",
            detail: Some(("version", f64::from(*version))),
        },
    }
}

pub fn graph_kind(error: &GraphError) -> Kind {
    match error {
        GraphError::Malformed(_)
        | GraphError::MissingParent
        | GraphError::Genesis
        | GraphError::Unauthorized => plain("Malformed"),
        GraphError::NewerVersion(version) => Kind {
            kind: "NewerVersion",
            detail: Some(("version", f64::from(*version))),
        },
        GraphError::BadSignature => plain("BadSignature"),
        GraphError::TooLarge => plain("TooLarge"),
        GraphError::ForeignGraph => plain("ForeignGraph"),
        GraphError::NotValid => plain("NotValid"),
        GraphError::DeviceRevoked => plain("DeviceRevoked"),
    }
}

pub fn adopt_kind(error: &AdoptError) -> Kind {
    match error {
        AdoptError::ForeignIdentity { .. } => plain("ForeignIdentity"),
        AdoptError::NotListed => plain("NotListed"),
        AdoptError::Graph(inner) => graph_kind(inner),
    }
}

pub fn recover_kind(error: &RecoverError) -> Kind {
    match error {
        RecoverError::UnknownKey => plain("UnknownRecoveryKey"),
        RecoverError::KeyRevoked => plain("RecoveryKeyRevoked"),
        RecoverError::OwnRevoked => plain("OwnDeviceRevoked"),
        RecoverError::Adopt(inner) => adopt_kind(inner),
        RecoverError::Graph(inner) => graph_kind(inner),
    }
}

pub fn mls_kind(error: &MlsError) -> Kind {
    match error {
        MlsError::Crypto(inner) => crypto_kind(inner),
        MlsError::Mls(_) => plain("Mls"),
        MlsError::Malformed(_) => plain("Malformed"),
        MlsError::Envelope(_) => plain("Envelope"),
        MlsError::NotEditor => plain("NotEditor"),
        MlsError::NotOwner => plain("NotOwner"),
        MlsError::NoOwnerKey => plain("NoOwnerKey"),
        MlsError::NotActive => plain("NotActive"),
        MlsError::Pending => plain("Pending"),
        MlsError::NoPending => plain("NoPending"),
        MlsError::Epoch { .. } => plain("Epoch"),
        MlsError::Mismatch(_) => plain("Mismatch"),
        MlsError::OwnerChanged(_) => plain("OwnerChanged"),
        MlsError::Rewritten => plain("Rewritten"),
        MlsError::BadLeaf(_) => plain("BadLeaf"),
        MlsError::NewerState(version) => Kind {
            kind: "NewerVersion",
            detail: Some(("version", f64::from(*version))),
        },
        MlsError::Unconfirmed => plain("Unconfirmed"),
        MlsError::Identity(inner) => graph_kind(inner),
        MlsError::NoIdentity => plain("NoIdentity"),
        MlsError::NothingRevoked => plain("NothingRevoked"),
        MlsError::KeyringBehind => plain("KeyringBehind"),
    }
}

pub fn pair_kind(error: &PairError) -> Kind {
    match error {
        PairError::WrongCode => plain("WrongCode"),
        PairError::RoleConflict => plain("RoleConflict"),
        PairError::Unexpected => plain("Unexpected"),
        PairError::Finished => plain("Finished"),
        PairError::Tampered => plain("Tampered"),
        PairError::NewerVersion(version) => Kind {
            kind: "NewerVersion",
            detail: Some(("version", f64::from(*version))),
        },
        PairError::Malformed(_) => plain("Malformed"),
    }
}

fn build(kind: Kind, message: &str) -> JsValue {
    let error = js_sys::Error::new(message);
    // Setting properties on a fresh Error object cannot fail.
    let _ = js_sys::Reflect::set(&error, &"kind".into(), &kind.kind.into());
    if let Some((name, value)) = kind.detail {
        let _ = js_sys::Reflect::set(&error, &name.into(), &value.into());
    }
    error.into()
}

/// An error that is the caller's fault and none of the library's, e.g. a
/// span that is empty.
pub fn invalid(kind: &'static str, message: impl Display) -> JsValue {
    build(plain(kind), &message.to_string())
}

pub fn from_crypto(error: CryptoError) -> JsValue {
    build(crypto_kind(&error), &error.to_string())
}

pub fn from_graph(error: GraphError) -> JsValue {
    build(graph_kind(&error), &error.to_string())
}

pub fn from_adopt(error: AdoptError) -> JsValue {
    build(adopt_kind(&error), &error.to_string())
}

pub fn from_recover(error: RecoverError) -> JsValue {
    build(recover_kind(&error), &error.to_string())
}

pub fn from_mls(error: MlsError) -> JsValue {
    build(mls_kind(&error), &error.to_string())
}

pub fn from_pair(error: PairError) -> JsValue {
    build(pair_kind(&error), &error.to_string())
}

pub fn from_code(error: CodeError) -> JsValue {
    build(plain("BadCode"), &error.to_string())
}

pub fn from_recovery(error: RecoveryError) -> JsValue {
    build(plain("BadRecoveryWords"), &error.to_string())
}

pub fn from_serde(error: serde_wasm_bindgen::Error) -> JsValue {
    build(plain("Malformed"), &error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_carry_what_callers_act_on() {
        assert_eq!(
            crypto_kind(&CryptoError::UnknownGeneration(3)),
            Kind {
                kind: "UnknownGeneration",
                detail: Some(("generation", 3.0)),
            }
        );
        assert_eq!(
            mls_kind(&MlsError::Crypto(CryptoError::NewerVersion(9))),
            Kind {
                kind: "NewerVersion",
                detail: Some(("version", 9.0)),
            }
        );
        assert_eq!(mls_kind(&MlsError::NewerState(2)).kind, "NewerVersion");
        assert_eq!(crypto_kind(&CryptoError::ReadOnly).kind, "ReadOnly");
        assert_eq!(graph_kind(&GraphError::ForeignGraph).kind, "ForeignGraph");
        assert_eq!(
            mls_kind(&MlsError::Identity(GraphError::NotValid)).kind,
            "NotValid"
        );
        assert_eq!(
            graph_kind(&GraphError::NewerVersion(2)).detail,
            Some(("version", 2.0))
        );
        assert_eq!(pair_kind(&PairError::WrongCode).kind, "WrongCode");
        assert_eq!(
            recover_kind(&RecoverError::Adopt(AdoptError::ForeignIdentity {
                stored: [0; 32]
            }))
            .kind,
            "ForeignIdentity"
        );
        assert_eq!(
            recover_kind(&RecoverError::Graph(GraphError::TooLarge)).kind,
            "TooLarge"
        );
        assert_eq!(
            recover_kind(&RecoverError::OwnRevoked).kind,
            "OwnDeviceRevoked"
        );
        assert_eq!(
            pair_kind(&PairError::NewerVersion(4)).detail,
            Some(("version", 4.0))
        );
    }
}
