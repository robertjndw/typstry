//! Cross-language check of the path rule. `clash.loro` and the expected
//! paths are written by `apps/web/src/doc/fixture.test.ts` (regenerate with
//! `pnpm --filter web fixtures`); this side must derive the same list.

use loro::LoroDoc;
use serde::Deserialize;
use typstry_doc::materialize::{FileContent, materialize};
use typstry_doc::paths::build_path_index;
use typstry_doc::{node, root};

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
        assert_eq!(text, &content.to_string(), "{}", file.path);
    }
}
