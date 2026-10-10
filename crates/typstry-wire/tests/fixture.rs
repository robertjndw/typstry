//! Cross-language check of the encryption. `js-records.json` is written by
//! `apps/web/src/crypto/fixture.test.ts` (regenerate with
//! `pnpm --filter web fixtures`) and must decrypt here; `rust-records.json`
//! is written here with `TYPSTRY_WRITE_FIXTURES=1` and must decrypt there.

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use typstry_wire::crypto::{BLOB_CONTEXT, ProjectKey, SALT_LEN, Salt};
use typstry_wire::elo::{Record, SealedRecord, Version};

const RAW_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    key: String,
    view_key: String,
    key_id: String,
    delta: Delta,
    snapshot: Snapshot,
    blob: Blob,
}

#[derive(Debug, Serialize, Deserialize)]
struct Delta {
    peer: String,
    start: u64,
    end: u64,
    record: String,
    plaintext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Snapshot {
    vv: Vec<(String, u64)>,
    record: String,
    plaintext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Blob {
    sealed: String,
    plaintext: String,
}

fn bytes(text: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(text).unwrap()
}

fn text(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn vv_of(fixture: &Snapshot) -> Vec<(u64, u64)> {
    fixture
        .vv
        .iter()
        .map(|(peer, counter)| (peer.parse().unwrap(), *counter))
        .collect()
}

/// Decrypts every part of a fixture and checks it against its own claims.
fn check(fixture: &Fixture) -> ProjectKey {
    assert_eq!(fixture.key, RAW_KEY);
    let editor = ProjectKey::from_base64url(&fixture.key).unwrap();
    assert_eq!(editor.key_id(), fixture.key_id);
    assert_eq!(editor.view_secret(), fixture.view_key);
    // Everything below must work with the view secret alone.
    let key = ProjectKey::from_base64url(&fixture.view_key).unwrap();
    assert_eq!(key.key_id(), fixture.key_id);

    let delta = key.decrypt_record(&bytes(&fixture.delta.record)).unwrap();
    let Record::Delta { peer, start, end } = delta.record else {
        panic!("not a delta: {:?}", delta.record);
    };
    // The parser only takes the canonical spelling, so this also pins it.
    assert_eq!(peer.to_string(), fixture.delta.peer);
    assert_eq!((start, end), (fixture.delta.start, fixture.delta.end));
    assert_eq!(delta.plaintext, bytes(&fixture.delta.plaintext));

    let snapshot = key
        .decrypt_record(&bytes(&fixture.snapshot.record))
        .unwrap();
    let Record::Snapshot { vv } = &snapshot.record else {
        panic!("not a snapshot: {:?}", snapshot.record);
    };
    let expected: Version = vv_of(&fixture.snapshot).into_iter().collect();
    assert_eq!(vv, &expected);
    assert_eq!(snapshot.plaintext, bytes(&fixture.snapshot.plaintext));

    let blob = key
        .open(&bytes(&fixture.blob.sealed), BLOB_CONTEXT)
        .unwrap();
    assert_eq!(blob, bytes(&fixture.blob.plaintext));
    editor
}

#[test]
fn decrypts_typescript_fixture() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/js-records.json")).unwrap();
    let key = check(&fixture);

    // Same key, nonces and plaintext must give the same bytes (Ed25519
    // signatures are deterministic), which pins the header encoding, the
    // key derivation and the signed message to the TypeScript side's.
    let (iv, salt) = nonces_of(&fixture.delta.record);
    let again = key
        .encrypt_delta_with(
            fixture.delta.peer.parse().unwrap(),
            fixture.delta.start,
            fixture.delta.end,
            &bytes(&fixture.delta.plaintext),
            &iv,
            &salt,
        )
        .unwrap();
    assert_eq!(text(&again), fixture.delta.record);

    let (iv, salt) = nonces_of(&fixture.snapshot.record);
    let again = key
        .encrypt_snapshot_with(
            &vv_of(&fixture.snapshot),
            &bytes(&fixture.snapshot.plaintext),
            &iv,
            &salt,
        )
        .unwrap();
    assert_eq!(text(&again), fixture.snapshot.record);
}

fn nonces_of(record: &str) -> ([u8; 12], Salt) {
    let record = bytes(record);
    let sealed = SealedRecord::parse(&record).unwrap();
    (sealed.iv, sealed.ct[..SALT_LEN].try_into().unwrap())
}

fn rust_fixture() -> Fixture {
    let key = ProjectKey::from_base64url(RAW_KEY).unwrap();
    let delta = b"delta from rust";
    let snapshot = b"snapshot from rust";
    let vv = [(10, 3), (9, 2), (u64::MAX, 1)];
    let blob = b"#set text(lang: \"de\")\n";
    Fixture {
        key: RAW_KEY.into(),
        view_key: key.view_secret(),
        key_id: key.key_id().into(),
        delta: Delta {
            peer: u64::MAX.to_string(),
            start: 4,
            end: 9,
            record: text(&key.encrypt_delta(u64::MAX, 4, 9, delta).unwrap()),
            plaintext: text(delta),
        },
        snapshot: Snapshot {
            vv: vv.iter().map(|&(p, c)| (p.to_string(), c)).collect(),
            record: text(&key.encrypt_snapshot(&vv, snapshot).unwrap()),
            plaintext: text(snapshot),
        },
        blob: Blob {
            sealed: text(&key.seal(blob, BLOB_CONTEXT)),
            plaintext: text(blob),
        },
    }
}

#[test]
fn rust_fixture_decrypts() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rust-records.json");
    if std::env::var("TYPSTRY_WRITE_FIXTURES").as_deref() == Ok("1") {
        let json = serde_json::to_string_pretty(&rust_fixture()).unwrap();
        std::fs::write(&path, json + "\n").unwrap();
    }
    let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    check(&fixture);
}
