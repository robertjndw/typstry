//! Reads the project doc of every frozen fixture in
//! `fixtures/compat/v<N>/` with the current code. Those files are never
//! regenerated; see their README and `crates/typstry-cli/tests/compat.rs`,
//! which wrote them.

use std::fs;

use loro::{LoroDoc, LoroValue, ToJson};
use serde_json::{Value, json};
use typstry_doc::materialize::{MaterializedFile, materialize, materialize_at};
use typstry_doc::paths::build_path_index;
use typstry_doc::peers::peer_name;
use typstry_doc::testing::file_json;
use typstry_doc::versions::named_versions;
use typstry_doc::{
    FileKind, SCHEMA_VERSION, ensure_supported, main_file, migrate, root, schema_version, title,
    version,
};

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
