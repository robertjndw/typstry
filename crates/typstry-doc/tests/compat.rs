//! Reads the project doc and the directory of every frozen fixture in
//! `fixtures/compat/v<N>/` with the current code. Those files are never
//! regenerated; see their README and `crates/typstry-cli/tests/compat.rs`,
//! which wrote most of them. The directory files are written here instead,
//! since the directory is this crate's alone: `TYPSTRY_WRITE_COMPAT_DIRECTORY=<N>`
//! adds them to an existing `v<N>` and refuses to replace them.

use std::fs;
use std::path::Path;

use loro::{ExportMode, LoroDoc, LoroValue, ToJson};
use serde_json::{Value, json};
use typstry_doc::directory::{self, DIRECTORY_SCHEMA_VERSION, NewLink, State};
use typstry_doc::materialize::{MaterializedFile, materialize, materialize_at};
use typstry_doc::paths::build_path_index;
use typstry_doc::peers::peer_name;
use typstry_doc::testing::file_json;
use typstry_doc::versions::named_versions;
use typstry_doc::{
    FileKind, SCHEMA_VERSION, ensure_supported, main_file, migrate, root, schema_version, title,
    version,
};
use typstry_wire::owner::OwnerSecret;

#[path = "../../../fixtures/compat/support.rs"]
mod support;

use support::{compat_dirs, read_json, str_of};

fn files_json(files: &[MaterializedFile]) -> Value {
    files
        .iter()
        .map(|f| file_json(&f.path, &f.content))
        .collect()
}

#[test]
fn reads_every_compat_doc() {
    for (n, dir) in compat_dirs() {
        let expected = read_json(&dir.join("doc.json"));
        let doc = LoroDoc::from_snapshot(&fs::read(dir.join("doc.loro")).unwrap()).unwrap();

        assert_eq!(schema_version(&doc), expected["schema"].as_i64(), "v{n}");
        assert_eq!(ensure_supported(&doc), Ok(()), "v{n}");
        assert_eq!(title(&doc).as_deref(), expected["title"].as_str(), "v{n}");

        let index = build_path_index(&doc);
        let main = main_file(&doc).expect("main file");
        assert_eq!(index.by_id[&main].path, expected["mainFile"], "v{n}");
        let mut dirs: Vec<&str> = index
            .by_id
            .values()
            .filter(|e| e.kind == FileKind::Dir)
            .map(|e| e.path.as_str())
            .collect();
        dirs.sort();
        assert_eq!(json!(dirs), expected["dirs"], "v{n}");
        assert_eq!(files_json(&materialize(&doc)), expected["files"], "v{n}");

        for (peer, info) in expected["peers"].as_object().unwrap() {
            assert_eq!(peer_name(&doc, peer).as_deref(), info["name"].as_str());
        }

        let versions = named_versions(&doc);
        let want = expected["versions"].as_array().unwrap();
        assert_eq!(versions.len(), want.len(), "v{n}");
        let list = doc.get_list(root::VERSIONS);
        for (version, want) in versions.iter().zip(want) {
            assert_eq!(version.index as u64, want["index"].as_u64().unwrap());
            let id = list.get_id_at(version.index).unwrap();
            assert_eq!(format!("{}@{}", id.counter, id.peer), want["id"], "v{n}");
            assert_eq!(version.name, want["name"], "v{n}");
            assert_eq!(version.created_at, want["createdAt"].as_i64().unwrap());
            assert_eq!(version.author, want["author"], "v{n}");
            let files = materialize_at(&doc, &version.frontiers).unwrap();
            assert_eq!(files_json(&files), want["files"], "v{n} {}", version.name);
        }

        // A deleted version keeps its slot in the list, so later indexes
        // stay put, and is only hidden by its entry in deletedVersions.
        let deleted = doc.get_map(root::DELETED_VERSIONS);
        for want in expected["deletedVersions"].as_array().unwrap() {
            let index = want["index"].as_u64().unwrap() as usize;
            assert!(versions.iter().all(|v| v.index != index), "v{n}");
            let id = list.get_id_at(index).unwrap();
            let key = format!("{}@{}", id.counter, id.peer);
            assert_eq!(key, want["id"], "v{n}");
            let at = deleted.get(&key).unwrap().into_value().unwrap();
            assert_eq!(
                at.to_json_value().as_f64(),
                want["deletedAt"].as_f64(),
                "v{n}"
            );
            let LoroValue::Map(entry) = list.get(index).unwrap().into_value().unwrap() else {
                panic!("v{n}: deleted entry is not a map");
            };
            assert_eq!(
                entry.get(version::NAME),
                Some(&LoroValue::from(str_of(&want["name"])))
            );
        }

        // Migrating an old doc must leave a current one alone, and bring
        // an older one to the current schema without losing anything.
        let fork = doc.fork();
        let migrated = migrate(&fork).unwrap();
        assert_eq!(
            migrated,
            expected["schema"].as_i64().unwrap() < SCHEMA_VERSION,
            "v{n}"
        );
        assert_eq!(schema_version(&fork), Some(SCHEMA_VERSION), "v{n}");
        assert_eq!(materialize(&fork), materialize(&doc), "v{n}");
        assert_eq!(named_versions(&fork), versions, "v{n}");
    }
}

/// A schema bump without a fixture of the new layout would let the old
/// fixtures pass while nothing checks that new docs stay readable.
#[test]
fn schema_has_a_compat_fixture() {
    let (n, newest) = compat_dirs().pop().unwrap();
    let frozen = read_json(&newest.join("versions.json"))["schema"]
        .as_i64()
        .unwrap();
    assert!(
        SCHEMA_VERSION <= frozen,
        "SCHEMA_VERSION is {SCHEMA_VERSION} but fixtures/compat/v{n} froze {frozen}; add fixtures/compat/v{} with `TYPSTRY_WRITE_COMPAT={} cargo test -p typstry-cli --test compat` (see docs/compatibility.md)",
        n + 1,
        n + 1
    );
}

/// A directory bump without a fixture of the new layout would let the old
/// fixture pass while nothing checks that new directories stay readable.
#[test]
fn directory_schema_has_a_compat_fixture() {
    let (n, newest) = compat_dirs().pop().unwrap();
    let frozen = read_json(&newest.join("versions.json"))["directory"]
        .as_i64()
        .expect("versions.json names the directory schema");
    assert!(
        DIRECTORY_SCHEMA_VERSION <= frozen,
        "DIRECTORY_SCHEMA_VERSION is {DIRECTORY_SCHEMA_VERSION} but fixtures/compat/v{n} froze {frozen}; add fixtures/compat/v{} (see docs/compatibility.md)",
        n + 1
    );
}

#[test]
fn reads_every_compat_directory() {
    for (n, dir) in compat_dirs() {
        let expected = read_json(&dir.join("directory.json"));
        let doc = LoroDoc::from_snapshot(&fs::read(dir.join("directory.loro")).unwrap()).unwrap();
        assert_eq!(directory::ensure_supported(&doc), Ok(()), "v{n}");
        assert_eq!(directory_json(&doc), expected, "v{n}");
    }
}

// The directory generator. Times are fixed, Loro's change timestamps are
// not, which is fine since the output is written only once.

/// Far past every `addedAt` in the fixture, and what it is read at.
const DIRECTORY_NOW: i64 = 1_000_000;

// Real secrets, since a view secret's attestation key has to be a curve
// point. The edit secrets are [1, 0x11 * 32] and [1, 0x22 * 32].
const EDIT: [&str; 2] = [
    "ARERERERERERERERERERERERERERERERERERERERERER",
    "ASIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
];
const VIEW: [&str; 2] = [
    "ArweKu_m30uCUI2Y_lwoF4rNfORgGU1fe7M7XCsQgPwP5lJ1MZx5pKr1m35dT3p6T-7wo_Uf2-fPM-fRODWN_EY",
    "AvOExVOACB8Pg000FeTJ10-YnzW9Qz27jmuueWAf37C1wjSik9koN1RO6UdLQKmcPcGfn7ZlRD--97RfFIgkLwk",
];

fn compat_token(n: u32) -> String {
    format!("compat{n:0>16}")
}

/// What a reader has to make of a directory: the list, the owner keys and
/// the project of every token. `apps/web/src/compat.test.ts` builds the
/// same shape.
fn directory_json(doc: &LoroDoc) -> Value {
    let entries = directory::list(doc, DIRECTORY_NOW);
    let list: Vec<Value> = entries
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
        .collect();
    let owner_keys: serde_json::Map<String, Value> = entries
        .iter()
        .map(|e| {
            let keys = directory::owner_keys(doc, &e.project_id, DIRECTORY_NOW)
                .into_iter()
                .map(|(public, secret)| json!([public, secret.to_base64url().as_str()]))
                .collect();
            (e.project_id.clone(), Value::Array(keys))
        })
        .collect();
    let mut tokens: Vec<String> = Vec::new();
    doc.get_map(directory::root::LINKS)
        .for_each(|token, _| tokens.push(token.to_owned()));
    tokens.sort();
    let projects: serde_json::Map<String, Value> = tokens
        .into_iter()
        .map(|token| {
            let project = directory::project_of_token(doc, &token, DIRECTORY_NOW);
            (token, json!(project))
        })
        .collect();
    json!({
        // What the doc says, not the constant: once the constant moves on,
        // the frozen fixtures still carry the version they were made with.
        "schema": schema_version(doc),
        "list": list,
        "ownerKeys": owner_keys,
        "projectOfToken": projects,
    })
}

fn build_directory() -> LoroDoc {
    let doc = LoroDoc::new();
    doc.set_peer_id(7).unwrap();
    directory::configure(&doc);
    directory::init(&doc).unwrap();
    let add = |n: u32, project_id: &str, secret: &str, edit: bool, added_at, generation| {
        let token = compat_token(n);
        let link = NewLink {
            token: &token,
            project_id,
            secret,
            edit,
            added_at,
            generation,
        };
        directory::add_link(&doc, &link).unwrap();
    };

    // A retired edit link and a newer one that replaced it.
    add(1, "alpha", EDIT[0], true, 100, Some(1));
    add(2, "alpha", EDIT[1], true, 200, Some(2));
    directory::retire(&doc, &compat_token(1), 300).unwrap();
    directory::set_title(&doc, "alpha", "Alpha paper").unwrap();
    directory::touch_opened(&doc, "alpha", 5000).unwrap();
    let owner = |fill: u8| OwnerSecret::from_raw(&[fill; 32]).unwrap();
    directory::add_owner_key(&doc, "alpha", &owner(0x77), 100).unwrap();
    directory::add_owner_key(&doc, "alpha", &owner(0x88), 200).unwrap();

    // A view link that saw the project gone.
    add(3, "beta", VIEW[0], false, 120, None);
    directory::set_status(&doc, "beta", State::Gone, 400, Some(&compat_token(3))).unwrap();

    // A project the person removed from their list.
    add(4, "gamma", VIEW[1], false, 130, None);
    directory::set_status(&doc, "gamma", State::Forgotten, 410, None).unwrap();
    doc.commit();
    doc
}

#[test]
fn write_compat_directory() {
    let Ok(n) = std::env::var("TYPSTRY_WRITE_COMPAT_DIRECTORY") else {
        return;
    };
    let n: u32 = n
        .parse()
        .expect("TYPSTRY_WRITE_COMPAT_DIRECTORY is the format version to write, e.g. 1");
    let target = support::compat_root().join(format!("v{n}"));
    assert!(
        target.is_dir(),
        "{} is missing; write it with the CLI's compat generator first",
        target.display()
    );
    let snapshot = target.join("directory.loro");
    let listing = target.join("directory.json");
    for path in [&snapshot, &listing] {
        assert!(
            !path.exists(),
            "{} exists; compat fixtures are frozen and never regenerated",
            path.display()
        );
    }
    let doc = build_directory();
    write_new(&snapshot, &doc.export(ExportMode::Snapshot).unwrap());
    let mut text = serde_json::to_string_pretty(&directory_json(&doc)).unwrap();
    text.push('\n');
    write_new(&listing, text.as_bytes());
}

fn write_new(path: &Path, bytes: &[u8]) {
    use std::io::Write;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .unwrap();
}
