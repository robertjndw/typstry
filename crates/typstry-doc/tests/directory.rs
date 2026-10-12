//! Cross-language checks against `apps/web/src/directory/fixture.test.ts`.
//! `directory.js.loro` and `directory.list.json` are written there
//! (regenerate with `pnpm --filter web fixtures`); this side must list the
//! same entries. `directory.rust.loro` and `directory.rust.list.json` go the
//! other way and are rewritten by running this test with
//! `TYPSTRY_WRITE_FIXTURES=1`.

use std::path::Path;

use loro::{ExportMode, LoroDoc, LoroValue};
use serde_json::{Value, json};
use typstry_doc::directory::{
    self, DirectoryError, Entry, NewLink, State, add_link, add_owner_key, ensure_supported,
    owner_keys, retire, set_status, set_title, touch_opened,
};
use typstry_wire::owner::OwnerSecret;

// Real secrets: a view secret's public half has to be a valid point. Edit
// secrets are [1, 0x11 * 32], [1, 0x22 * 32], [1, 0x33 * 32]. Must match
// fixture.test.ts.
const EDIT: [&str; 3] = [
    "ARERERERERERERERERERERERERERERERERERERERERER",
    "ASIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
    "ATMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz",
];
const VIEW: [&str; 3] = [
    "ArweKu_m30uCUI2Y_lwoF4rNfORgGU1fe7M7XCsQgPwP5lJ1MZx5pKr1m35dT3p6T-7wo_Uf2-fPM-fRODWN_EY",
    "AvOExVOACB8Pg000FeTJ10-YnzW9Qz27jmuueWAf37C1wjSik9koN1RO6UdLQKmcPcGfn7ZlRD--97RfFIgkLwk",
    "AlA8HjoPIttxhYY9QeLBiVeJYkvpDvDBwtgitKLHW8Kg58eHdl1GTiHnQr_jYbuq3SG-sByxJ4Hn7TykBteI964",
];

/// Far past every `addedAt` here. Must match fixture.test.ts.
const NOW: i64 = 1_000_000;

fn dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn tok(n: u32) -> String {
    format!("RS{n:0>20}")
}

/// The shape both sides compare: what `JSON.stringify(dir.list())` gives.
fn entries_json(entries: &[Entry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|e| {
                json!({
                    "projectId": e.project_id,
                    "title": e.title,
                    "link": {
                        "token": e.link.token,
                        "secret": e.link.secret,
                        "edit": e.link.edit,
                        "retired": e.link.retired,
                    },
                    "state": e.state.as_str(),
                    "openedAt": e.opened_at,
                    "addedAt": e.added_at,
                })
            })
            .collect(),
    )
}

fn add(
    doc: &LoroDoc,
    n: u32,
    project: &str,
    secret: &str,
    edit: bool,
    added_at: i64,
    generation: Option<u32>,
) {
    add_link(
        doc,
        &NewLink {
            token: &tok(n),
            project_id: project,
            secret,
            edit,
            added_at,
            generation,
        },
    )
    .unwrap();
}

fn build_scenario() -> LoroDoc {
    let doc = LoroDoc::new();
    doc.set_peer_id(7).unwrap();
    directory::init(&doc).unwrap();

    add(&doc, 1, "alpha", EDIT[0], true, 100, Some(1));
    add(&doc, 2, "alpha", EDIT[1], true, 200, Some(2));
    retire(&doc, &tok(1), 300).unwrap();
    set_title(&doc, "alpha", " Alpha paper ").unwrap();
    touch_opened(&doc, "alpha", 5000).unwrap();

    add(&doc, 3, "beta", VIEW[0], false, 120, None);
    add(&doc, 4, "beta", EDIT[2], true, 110, None);
    set_status(&doc, "beta", State::Gone, 400, Some(&tok(3))).unwrap();

    add(&doc, 5, "gamma", VIEW[1], false, 130, None);
    set_status(&doc, "gamma", State::Forgotten, 410, None).unwrap();
    touch_opened(&doc, "gamma", 9000).unwrap();

    add(&doc, 6, "delta", EDIT[0], true, 50, Some(3));
    add(&doc, 7, "delta", EDIT[1], true, 60, Some(1));
    retire(&doc, &tok(6), 420).unwrap();
    retire(&doc, &tok(7), 421).unwrap();
    set_status(&doc, "delta", State::Removed, 430, Some(&tok(7))).unwrap();

    // Without a generation, so the other side can fill it in.
    add(&doc, 8, "epsilon", VIEW[2], false, 140, None);

    let links = doc.get_map(directory::root::LINKS);
    let junk = |fields: &[(&str, LoroValue)]| {
        LoroValue::from(
            fields
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect::<std::collections::HashMap<_, _>>(),
        )
    };
    links
        .insert(
            &tok(9),
            junk(&[
                ("projectId", "junk".into()),
                ("secret", "not a secret".into()),
                ("edit", true.into()),
                ("addedAt", 150.0.into()),
            ]),
        )
        .unwrap();
    let LoroValue::Map(eight) = links.get(&tok(8)).unwrap().into_value().unwrap() else {
        panic!("link entries are maps");
    };
    let mut eight: std::collections::HashMap<String, LoroValue> =
        eight.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    eight.insert("note".to_owned(), "kept".into());
    links.insert(&tok(8), LoroValue::from(eight)).unwrap();
    doc.get_map("future").insert("k", "v").unwrap();

    // Two owner keys of one project and one of another, and a junk one: a
    // secret that does not derive the key it is filed under. Must match
    // fixture.test.ts apart from the fills.
    add_owner_key(&doc, "alpha", &owner(RUST_OWNER_FILLS[0]), 100).unwrap();
    add_owner_key(&doc, "alpha", &owner(RUST_OWNER_FILLS[1]), 200).unwrap();
    add_owner_key(&doc, "beta", &owner(RUST_OWNER_FILLS[2]), 300).unwrap();
    doc.get_map(directory::root::OWNER_KEYS)
        .insert(
            &format!("alpha/{}", owner_hex(&owner(RUST_OWNER_FILLS[2]))),
            LoroValue::from(std::collections::HashMap::from([
                (
                    "secret".to_owned(),
                    LoroValue::from(owner(RUST_OWNER_FILLS[0]).to_base64url().as_str()),
                ),
                ("addedAt".to_owned(), LoroValue::from(400.0)),
            ])),
        )
        .unwrap();
    doc.commit();
    doc
}

// The owner secrets each side writes; the other reads them back.
const RUST_OWNER_FILLS: [u8; 3] = [0x77, 0x88, 0x99];
const JS_OWNER_FILLS: [u8; 3] = [0x44, 0x55, 0x66];

fn owner(fill: u8) -> OwnerSecret {
    OwnerSecret::from_raw(&[fill; 32]).unwrap()
}

fn owner_hex(secret: &OwnerSecret) -> String {
    secret.public().iter().map(|b| format!("{b:02x}")).collect()
}

/// What `owner_keys` returns for a project as `(hex, fill)`.
fn owner_fills(doc: &LoroDoc, project: &str) -> Vec<(String, u8)> {
    owner_keys(doc, project, NOW)
        .into_iter()
        .map(|(hex, secret)| (hex, secret.to_raw()[0]))
        .collect()
}

#[test]
fn reads_the_owner_keys_typescript_wrote() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/directory.js.loro")).unwrap();
    let [a, b, c] = JS_OWNER_FILLS;
    // Newest first, and the junk entry filed under alpha is skipped.
    assert_eq!(
        owner_fills(&doc, "alpha"),
        [(owner_hex(&owner(b)), b), (owner_hex(&owner(a)), a)]
    );
    assert_eq!(owner_fills(&doc, "beta"), [(owner_hex(&owner(c)), c)]);
    assert!(owner_keys(&doc, "gamma", NOW).is_empty());
}

#[test]
fn lists_what_typescript_listed() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/directory.js.loro")).unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("fixtures/directory.list.json")).unwrap();
    assert_eq!(ensure_supported(&doc), Ok(()));
    let entries = directory::list(&doc, NOW);
    assert_eq!(entries_json(&entries), expected);
    assert!(
        entries.iter().all(|e| e.project_id != "junk"),
        "the malformed entry was listed"
    );
}

#[test]
fn covers_the_cases_the_spec_names() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/directory.js.loro")).unwrap();
    let entries = directory::list(&doc, NOW);
    let get = |id: &str| entries.iter().find(|e| e.project_id == id).unwrap();
    assert!(get("alpha").link.edit && !get("alpha").link.retired);
    // Edit beats a newer view link, and the gone mark of the view link is
    // superseded.
    assert!(get("beta").link.edit);
    assert_eq!(get("beta").state, State::Listed);
    assert_eq!(get("gamma").state, State::Forgotten);
    assert!(get("delta").link.retired);
    assert_eq!(get("delta").state, State::Removed);
}

#[test]
fn keeps_unknown_keys_through_a_rewrite() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/directory.js.loro")).unwrap();
    let entries = directory::list(&doc, NOW);
    let epsilon = entries.iter().find(|e| e.project_id == "epsilon").unwrap();
    let wrote = add_link(
        &doc,
        &NewLink {
            token: &epsilon.link.token,
            project_id: "epsilon",
            secret: &epsilon.link.secret,
            edit: epsilon.link.edit,
            added_at: 1,
            generation: Some(2),
        },
    )
    .unwrap();
    assert!(wrote);
    let value = doc
        .get_map(directory::root::LINKS)
        .get(&epsilon.link.token)
        .unwrap()
        .into_value()
        .unwrap();
    let LoroValue::Map(map) = value else {
        panic!("link entries are maps");
    };
    assert_eq!(map.get("note"), Some(&LoroValue::from("kept")));
    assert!(map.get("generation").is_some());
    assert_eq!(
        doc.get_map("future")
            .get("k")
            .unwrap()
            .into_value()
            .unwrap(),
        LoroValue::from("v")
    );
}

#[test]
fn rejects_what_the_reader_would_skip() {
    let doc = LoroDoc::new();
    directory::init(&doc).unwrap();
    let err = add_link(
        &doc,
        &NewLink {
            token: "short",
            project_id: "p",
            secret: EDIT[0],
            edit: true,
            added_at: 1,
            generation: None,
        },
    );
    assert!(matches!(err, Err(DirectoryError::InvalidLink(_))));
}

/// The JS side reads `directory.rust.loro`. Snapshots carry change
/// timestamps, so the files are only rewritten on request; otherwise this
/// checks that the committed ones still hold what Rust would write now.
#[test]
fn fixture_for_typescript_is_current() {
    let doc = build_scenario();
    let list = entries_json(&directory::list(&doc, NOW));
    let snapshot = dir().join("tests/fixtures/directory.rust.loro");
    let list_file = dir().join("tests/fixtures/directory.rust.list.json");
    if std::env::var("TYPSTRY_WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&snapshot, doc.export(ExportMode::Snapshot).unwrap()).unwrap();
        std::fs::write(
            &list_file,
            serde_json::to_string_pretty(&list).unwrap() + "\n",
        )
        .unwrap();
    }
    let committed = LoroDoc::from_snapshot(&std::fs::read(&snapshot).unwrap()).unwrap();
    let expected: Value = serde_json::from_slice(&std::fs::read(&list_file).unwrap()).unwrap();
    assert_eq!(entries_json(&directory::list(&committed, NOW)), expected);
    assert_eq!(list, expected);
    assert_eq!(
        owner_fills(&committed, "alpha"),
        owner_fills(&doc, "alpha"),
        "regenerate with TYPSTRY_WRITE_FIXTURES=1"
    );
}
