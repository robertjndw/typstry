//! Reads the encrypted parts of every frozen fixture in
//! `fixtures/compat/v<N>/` with the current code. Those files are never
//! regenerated; see their README and `crates/typstry-cli/tests/compat.rs`,
//! which wrote them.

use std::fs;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use typstry_wire::PROTOCOL_VERSION;
use typstry_wire::crypto::{
    CryptoError, DocKeys, KEYRING_VERSION, Keyring, LinkSecret, PROFILE_CONTEXT, PresenceKey,
    RECORD_VERSION, SEAL_VERSION,
};
use typstry_wire::ds::DS_VERSION;
use typstry_wire::elo::{Record, Version};

#[path = "../../../fixtures/compat/support.rs"]
mod support;

use support::{compat_dirs, read_json, str_of};

fn bytes(value: &Value) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(value.as_str().unwrap()).unwrap()
}

fn key(value: &Value) -> [u8; 32] {
    bytes(value).try_into().unwrap()
}

#[test]
fn decrypts_every_compat_fixture() {
    for (n, dir) in compat_dirs() {
        let fixture = read_json(&dir.join("crypto.json"));
        let editor = LinkSecret::from_base64url(str_of(&fixture["editSecret"])).unwrap();
        assert!(editor.can_attest(), "v{n}");
        assert_eq!(*editor.view_secret(), fixture["viewSecret"], "v{n}");
        assert_eq!(editor.fingerprint(), fixture["fingerprint"], "v{n}");
        let viewer = LinkSecret::from_base64url(str_of(&fixture["viewSecret"])).unwrap();
        assert!(!viewer.can_attest(), "v{n}");
        assert_eq!(viewer.attest_pub(), editor.attest_pub(), "v{n}");
        assert_eq!(viewer.fingerprint(), fixture["fingerprint"], "v{n}");
        // The fragment of a share link is the secret itself.
        for (link, secret) in [("editLink", "editSecret"), ("viewLink", "viewSecret")] {
            let (_, fragment) = str_of(&fixture[link]).split_once('#').unwrap();
            assert_eq!(fragment, fixture[secret], "v{n} {link}");
        }

        // Either link opens the signed keyring, which holds the doc key.
        let ring = &fixture["keyring"];
        let signed = bytes(&ring["signed"]);
        for link in [&editor, &viewer] {
            let keyring = Keyring::open_verified(link, &signed).unwrap();
            assert_eq!(keyring.generation(), ring["generation"], "v{n}");
        }
        assert_eq!(
            Keyring::open_verified(&editor, &signed).unwrap().export(),
            Keyring::open_verified(&viewer, &signed).unwrap().export(),
            "v{n}"
        );
        // Another project's link refuses it.
        let stranger = LinkSecret::generate_edit();
        assert!(Keyring::open_verified(&stranger, &signed).is_err(), "v{n}");
        let keys = DocKeys::new(Keyring::open_verified(&viewer, &signed).unwrap());
        assert_eq!(keys.key_id(), ring["keyId"], "v{n}");
        assert_eq!(
            keys.keyring().export(),
            Keyring::new_with(&editor, key(&ring["docKey"])).export(),
            "v{n}"
        );

        // The device key was attested by the link for its generation.
        let signer = &fixture["signer"];
        let generation = signer["generation"].as_u64().unwrap() as u32;
        for link in [&editor, &viewer] {
            assert!(
                link.verify_attestation(
                    &key(&signer["publicKey"]),
                    generation,
                    &bytes(&signer["attestation"]).try_into().unwrap()
                ),
                "v{n}"
            );
        }

        let delta = &fixture["delta"];
        let out = keys.decrypt_record(&bytes(&delta["record"])).unwrap();
        let Record::Delta { peer, start, end } = out.record else {
            panic!("v{n}: not a delta: {:?}", out.record);
        };
        assert_eq!(peer.to_string(), delta["peer"], "v{n}");
        assert_eq!(
            (start, end),
            (
                delta["start"].as_u64().unwrap(),
                delta["end"].as_u64().unwrap()
            ),
            "v{n}"
        );
        assert_eq!(out.plaintext, bytes(&delta["plaintext"]), "v{n}");
        assert_eq!(out.signer_pub, key(&signer["publicKey"]), "v{n}");

        let snapshot = &fixture["snapshot"];
        let out = keys.decrypt_record(&bytes(&snapshot["record"])).unwrap();
        let Record::Snapshot { vv } = &out.record else {
            panic!("v{n}: not a snapshot: {:?}", out.record);
        };
        let expected: Version = snapshot["vv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    str_of(&entry[0]).parse::<u64>().unwrap(),
                    entry[1].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(vv, &expected, "v{n}");
        let plaintext = fs::read(dir.join(str_of(&snapshot["plaintextFile"]))).unwrap();
        assert_eq!(out.plaintext, plaintext, "v{n}");
        assert_eq!(out.signer_pub, key(&signer["publicKey"]), "v{n}");

        // A record whose bytes changed no longer verifies.
        let mut tampered = bytes(&delta["record"]);
        *tampered.last_mut().unwrap() ^= 1;
        assert!(keys.decrypt_record(&tampered).is_err(), "v{n}");

        let blob = &fixture["blob"];
        assert_eq!(
            keys.open_blob(&bytes(&blob["sealed"])).unwrap(),
            bytes(&blob["plaintext"]),
            "v{n}"
        );
        let profile = &fixture["profile"];
        assert_eq!(
            keys.open(&bytes(&profile["sealed"]), PROFILE_CONTEXT)
                .unwrap(),
            str_of(&profile["plaintext"]).as_bytes(),
            "v{n}"
        );

        // Presence is keyed per MLS epoch, so the fixture carries the raw
        // key; the roster maps the sending leaf to the device key.
        let presence = &fixture["presence"];
        let epoch_key =
            PresenceKey::new(presence["epoch"].as_u64().unwrap(), key(&presence["key"]));
        let leaf = presence["leaf"].as_u64().unwrap() as u32;
        let roster = |l: u32| (l == leaf).then(|| key(&signer["publicKey"]));
        let (from, plaintext) = epoch_key.open(&bytes(&presence["sealed"]), roster).unwrap();
        assert_eq!(from, leaf, "v{n}");
        assert_eq!(plaintext, bytes(&presence["plaintext"]), "v{n}");
        let later = PresenceKey::new(epoch_key.epoch() + 1, key(&presence["key"]));
        assert!(
            matches!(
                later.open(&bytes(&presence["sealed"]), roster),
                Err(CryptoError::WrongEpoch(_))
            ),
            "v{n}"
        );
    }
}

/// A format bump without a fixture of the new format would let the old
/// fixtures pass while nothing checks that the new data stays readable.
#[test]
fn wire_formats_have_a_compat_fixture() {
    let (n, newest) = compat_dirs().pop().unwrap();
    let frozen = read_json(&newest.join("versions.json"));
    for (name, current) in [
        ("seal", u32::from(SEAL_VERSION)),
        ("record", u32::from(RECORD_VERSION)),
        ("keyring", u32::from(KEYRING_VERSION)),
        ("ds", u32::from(DS_VERSION)),
        ("protocol", PROTOCOL_VERSION),
    ] {
        let frozen = frozen[name].as_u64().unwrap();
        assert!(
            u64::from(current) <= frozen,
            "the {name} version is {current} but fixtures/compat/v{n} froze {frozen}; add fixtures/compat/v{} with `TYPSTRY_WRITE_COMPAT={} cargo test -p typstry-cli --test compat` (see docs/compatibility.md)",
            n + 1,
            n + 1
        );
    }
}
