//! Cross-language checks. `clash.loro`, the expected paths,
//! `version.js.loro`, `packages.js.loro` and `comments.js.loro` are written by
//! `apps/web/src/doc/fixture.test.ts` (regenerate with
//! `pnpm --filter web fixtures`); this side must derive the same paths, read
//! the same version and packages, and see the comments as bookkeeping. `version.rust.loro` goes the other
//! way and is rewritten by running this test with `TYPSTRY_WRITE_FIXTURES=1`.
//! `names.json` is written by hand and checked on both sides.

use std::path::Path;

use loro::{ExportMode, LoroDoc, LoroValue};
use serde::Deserialize;
use typstry_doc::init::init_project;
use typstry_doc::materialize::{FileContent, is_safe_path, materialize, materialize_at};
use typstry_doc::names::validate_name;
use typstry_doc::packages::{font_bundles, packages};
use typstry_doc::paths::build_path_index;
use typstry_doc::versions::{NamedVersion, named_versions, save_version, tag_at};
use typstry_doc::{comment, node, root, title};

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct Expected {
    path: String,
    id: String,
    kind: String,
    renamed: bool,
}

#[test]
fn rust_paths_match_typescript_fixture() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/clash.loro")).unwrap();
    let expected: Vec<Expected> =
        serde_json::from_str(include_str!("fixtures/clash.paths.json")).unwrap();

    let index = build_path_index(&doc);
    let mut actual: Vec<Expected> = index
        .by_id
        .iter()
        .map(|(id, entry)| Expected {
            path: entry.path.clone(),
            id: id.to_string(),
            kind: entry.kind.to_string(),
            renamed: entry.renamed,
        })
        .collect();
    actual.sort_by(|a, b| a.path.cmp(&b.path));

    assert!(
        expected.iter().any(|e| e.renamed),
        "fixture lost its clashes"
    );
    assert_eq!(actual, expected);
    assert_eq!(index.by_path.len(), expected.len());
}

#[test]
fn materializes_typescript_fixture() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/clash.loro")).unwrap();
    let expected: Vec<Expected> =
        serde_json::from_str(include_str!("fixtures/clash.paths.json")).unwrap();

    let files = materialize(&doc);
    let file_paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let expected_paths: Vec<&str> = expected
        .iter()
        .filter(|e| e.kind != "dir")
        .map(|e| e.path.as_str())
        .collect();
    assert_eq!(file_paths, expected_paths);

    let index = build_path_index(&doc);
    let tree = doc.get_tree(root::FS);
    for file in &files {
        let FileContent::Text(text) = &file.content else {
            continue;
        };
        let content = tree
            .get_meta(index.by_path[&file.path])
            .unwrap()
            .get(node::CONTENT)
            .unwrap()
            .into_container()
            .unwrap()
            .into_text()
            .unwrap();
        assert_eq!(&**text, content.to_string(), "{}", file.path);
    }
}

#[test]
fn hides_version_deleted_by_typescript() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/version-deleted.js.loro")).unwrap();
    let kept: Vec<_> = named_versions(&doc)
        .into_iter()
        .map(|v| (v.index, v.name))
        .collect();
    // The deleted entry keeps its slot, so "Also kept" is still #2.
    assert_eq!(kept, [(0, "Kept".to_owned()), (2, "Also kept".to_owned())]);
    // Deleting a version is bookkeeping, so the state stays tagged.
    let current = typstry_doc::versions::tag_at(&doc, None).map(|v| v.name);
    assert_eq!(current.as_deref(), Some("Also kept"));
}

#[test]
fn reads_version_saved_by_typescript() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/version.js.loro")).unwrap();
    let versions = named_versions(&doc);
    assert_eq!(versions.len(), 1);
    let version = &versions[0];
    assert_eq!(version.index, 0);
    assert_eq!(version.name, "Draft from JS");
    assert_eq!(version.created_at, 1_700_000_000_123);
    assert_eq!(version.author, "10");
    let files = materialize_at(&doc, &version.frontiers).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "main.typ");
}

#[test]
fn reads_packages_written_by_typescript() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/packages.js.loro")).unwrap();
    let found = packages(&doc);
    // The scratch package was removed, and the thesis one replaced.
    let keys: Vec<_> = found
        .iter()
        .map(|p| format!("{}/{}/{}", p.namespace, p.name, p.version))
        .collect();
    assert_eq!(keys, ["local/thesis/1.0.0", "preview/cetz/0.3.0"]);

    let thesis = &found[0];
    assert_eq!(thesis.hash, "hash-new");
    assert_eq!(thesis.size, 1024);
    assert_eq!(thesis.file_count, 3);
    assert_eq!(thesis.unpacked_size, 4096);
    assert_eq!(thesis.added_at, 1_700_000_000_500);
    assert_eq!(thesis.source, "upload");
    assert_eq!(thesis.description.as_deref(), Some("A thesis template"));
    assert_eq!(
        thesis.authors.as_deref(),
        Some(&["Ada".to_owned(), "Grace".to_owned()][..])
    );
    assert_eq!(thesis.license.as_deref(), Some("MIT"));
    assert_eq!(thesis.compiler.as_deref(), Some("0.13.0"));

    let cetz = &found[1];
    assert_eq!(cetz.source, "universe");
    assert_eq!(cetz.entrypoint, "src/lib.typ");
    assert_eq!(cetz.description, None);

    assert_eq!(font_bundles(&doc), (true, false));
}

#[test]
fn reads_comments_written_by_typescript() {
    let doc = LoroDoc::from_snapshot(include_bytes!("fixtures/comments.js.loro")).unwrap();
    // Commenting after the version was saved is not an edit, so the
    // current state is still the tagged one.
    assert_eq!(
        tag_at(&doc, None).map(|v| v.name).as_deref(),
        Some("Reviewed")
    );

    // The deleted thread took its reply along; one thread and its reply
    // are left, in the layout typstry_doc::comment names.
    let LoroValue::List(entries) = doc.get_list(root::COMMENTS).get_value() else {
        panic!("comments is not a list");
    };
    let list = doc.get_list(root::COMMENTS);
    let root_id = list.get_id_at(0).unwrap();
    let root_key = format!("{}@{}", root_id.counter, root_id.peer);
    let fields: Vec<_> = entries
        .iter()
        .map(|entry| {
            let LoroValue::Map(map) = entry else {
                panic!("comment is not a map");
            };
            for key in [comment::ANCHOR, comment::HEAD] {
                assert!(matches!(map.get(key), Some(LoroValue::Binary(_))), "{key}");
            }
            let string = |key| match map.get(key) {
                Some(LoroValue::String(s)) => Some(s.to_string()),
                _ => None,
            };
            (
                string(comment::THREAD),
                string(comment::BODY).unwrap(),
                string(comment::QUOTE).unwrap(),
                string(comment::NAME).unwrap(),
            )
        })
        .collect();
    assert_eq!(
        fields,
        [
            (None, "Friendlier?".into(), "Hello".into(), "Ada".into()),
            (
                Some(root_key.clone()),
                "Fine as is.".into(),
                "Hello".into(),
                "Grace".into()
            ),
        ]
    );
    let resolved = doc.get_map(root::RESOLVED_COMMENTS);
    let keys: Vec<String> = resolved.keys().map(|k| k.to_string()).collect();
    assert_eq!(keys, [root_key]);
}

fn rust_saved_version() -> (LoroDoc, NamedVersion) {
    let doc = LoroDoc::new();
    doc.set_peer_id(7).unwrap();
    init_project(&doc, "From Rust").unwrap();
    let version = save_version(&doc, "Draft from Rust", 1_700_000_000_456).unwrap();
    (doc, version)
}

#[derive(Deserialize)]
struct Names {
    valid: Vec<String>,
    invalid: Vec<String>,
}

/// `names.json` is hand-written and read by both sides, so the browser
/// never accepts a name the CLI refuses to write, or the other way around.
#[test]
fn name_rules_match_typescript() {
    let names: Names = serde_json::from_str(include_str!("fixtures/names.json")).unwrap();
    for name in &names.valid {
        assert_eq!(validate_name(name), Ok(()), "{name:?}");
        assert!(is_safe_path(name), "{name:?}");
    }
    for name in &names.invalid {
        assert!(validate_name(name).is_err(), "{name:?}");
        assert!(!is_safe_path(&format!("dir/{name}/x.typ")), "{name:?}");
    }
}

/// The JS side reads `version.rust.loro`. Snapshots carry change
/// timestamps, so the file is only rewritten on request; otherwise this
/// checks that the committed one still holds what Rust would write now.
#[test]
fn version_fixture_for_typescript_is_current() {
    let (doc, version) = rust_saved_version();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/version.rust.loro");
    if std::env::var("TYPSTRY_WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&file, doc.export(ExportMode::Snapshot).unwrap()).unwrap();
    }
    let committed = LoroDoc::from_snapshot(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(named_versions(&committed), [version]);
    assert_eq!(title(&committed).as_deref(), Some("From Rust"));
}
