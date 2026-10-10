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
    BLOB_CONTEXT, PRESENCE_CONTEXT, ProjectKey, RECORD_VERSION, SEAL_VERSION,
};
use typstry_wire::elo::{Record, Version};

#[path = "../../../fixtures/compat/support.rs"]
mod support;

use support::{compat_dirs, read_json, str_of};

fn bytes(value: &Value) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(value.as_str().unwrap()).unwrap()
}

#[test]
fn decrypts_every_compat_fixture() {
    for (n, dir) in compat_dirs() {
        let fixture = read_json(&dir.join("crypto.json"));
        let editor = ProjectKey::from_base64url(str_of(&fixture["editSecret"])).unwrap();
        assert!(editor.can_sign(), "v{n}");
        assert_eq!(editor.key_id(), fixture["keyId"], "v{n}");
        assert_eq!(*editor.view_secret(), fixture["viewSecret"], "v{n}");
        let viewer = ProjectKey::from_base64url(str_of(&fixture["viewSecret"])).unwrap();
        assert!(!viewer.can_sign(), "v{n}");
        assert_eq!(viewer.key_id(), fixture["keyId"], "v{n}");
        // The fragment of a share link is the secret itself.
        for (link, secret) in [("editLink", "editSecret"), ("viewLink", "viewSecret")] {
            let (_, fragment) = str_of(&fixture[link]).split_once('#').unwrap();
            assert_eq!(fragment, fixture[secret], "v{n} {link}");
        }

        for key in [&editor, &viewer] {
            let delta = &fixture["delta"];
            let out = key.decrypt_record(&bytes(&delta["record"])).unwrap();
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

            let snapshot = &fixture["snapshot"];
            let out = key.decrypt_record(&bytes(&snapshot["record"])).unwrap();
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

            let blob = &fixture["blob"];
            assert_eq!(
                key.open(&bytes(&blob["sealed"]), BLOB_CONTEXT).unwrap(),
                bytes(&blob["plaintext"]),
                "v{n}"
            );
            let presence = &fixture["presence"];
            assert_eq!(
                key.open(&bytes(&presence["sealed"]), PRESENCE_CONTEXT)
                    .unwrap(),
                bytes(&presence["plaintext"]),
                "v{n}"
            );
        }
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
