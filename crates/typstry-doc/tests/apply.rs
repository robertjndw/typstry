//! `apply_files` against `materialize`: applying what materialize returns
//! must be a no-op, applying any valid file list must make materialize
//! return exactly that list, and edits made on forks of a common base must
//! merge.

use loro::{ExportMode, LoroDoc, TreeID};
use proptest::prelude::*;
use typstry_doc::apply::{ApplyReport, Renamed, SkipReason, apply_files};

const MESSAGE: &str = "test apply";
use typstry_doc::init::{init_project, init_project_with, set_main_file};
use typstry_doc::materialize::{FileContent, MaterializedFile, materialize};
use typstry_doc::names::NameError;
use typstry_doc::paths::build_path_index;
use typstry_doc::testing::{add, replica, sync};
use typstry_doc::{FileKind, configure, main_file, node, root, text_content};

fn text(path: &str, body: &str) -> MaterializedFile {
    MaterializedFile {
        path: path.into(),
        content: FileContent::Text(body.into()),
    }
}

fn asset(path: &str, hash: &str) -> MaterializedFile {
    MaterializedFile {
        path: path.into(),
        content: FileContent::Asset {
            hash: hash.into(),
            size: 3,
            mime: "image/png".into(),
        },
    }
}

fn sorted(mut files: Vec<MaterializedFile>) -> Vec<MaterializedFile> {
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

fn id_of(doc: &LoroDoc, path: &str) -> TreeID {
    build_path_index(doc).by_path[path]
}

fn project() -> LoroDoc {
    let doc = replica(1);
    init_project(&doc, "T").unwrap();
    doc
}

/// Applies and checks the two invariants every call must keep.
fn apply(doc: &LoroDoc, files: &[MaterializedFile]) -> ApplyReport {
    let report = apply_files(doc, files, MESSAGE).unwrap();
    // Duplicates are reported too, but their first occurrence is applied.
    let mut seen: Vec<&str> = report
        .skipped
        .iter()
        .filter(|s| s.reason != SkipReason::Duplicate)
        .map(|s| s.path.as_str())
        .collect();
    let mut expected = Vec::new();
    for file in files {
        if !seen.contains(&file.path.as_str()) {
            seen.push(&file.path);
            expected.push(file.clone());
        }
    }
    assert_eq!(materialize(doc), sorted(expected));
    let vv = doc.oplog_vv();
    let again = apply_files(doc, &materialize(doc), MESSAGE).unwrap();
    assert!(!again.changed, "{again:?}");
    assert_eq!(doc.oplog_vv(), vv);
    report
}

#[test]
fn materialized_state_is_a_no_op() {
    let doc = project();
    let vv = doc.oplog_vv();
    let report = apply_files(&doc, &materialize(&doc), MESSAGE).unwrap();
    assert_eq!(report, ApplyReport::default());
    assert_eq!(doc.oplog_vv(), vv);
}

#[test]
fn creates_modifies_and_deletes_in_one_commit() {
    let doc = project();
    configure(&doc);
    let main = id_of(&doc, "main.typ");
    add(&doc, None, "empty", FileKind::Dir);
    let report = apply(
        &doc,
        &[
            text("main.typ", "= Changed\n"),
            text("chapters/one/intro.typ", "hi"),
            asset("img/logo.png", "sha256:aa"),
        ],
    );
    assert_eq!(
        report.created,
        ["chapters/one/intro.typ", "img/logo.png"].map(String::from)
    );
    assert_eq!(report.modified, ["main.typ"]);
    assert!(report.changed);
    // The node and its text survive, so concurrent typing still merges.
    assert_eq!(id_of(&doc, "main.typ"), main);
    let last = doc.oplog_frontiers();
    let change = doc.get_change(last.as_single().unwrap()).unwrap();
    assert_eq!(change.message.as_deref(), Some(MESSAGE));
    // The browser stores sizes as JS numbers.
    let logo = doc.get_tree(root::FS).get_meta(id_of(&doc, "img/logo.png"));
    let size = logo.unwrap().get(node::SIZE).unwrap().into_value().unwrap();
    assert_eq!(size, loro::LoroValue::Double(3.0));

    let report = apply(&doc, &[text("main.typ", "= Changed\n")]);
    assert_eq!(
        report.deleted,
        ["chapters/one/intro.typ", "img/logo.png"].map(String::from)
    );
    let index = build_path_index(&doc);
    // Folders that only held deleted files go too; the one that was always
    // empty stays.
    let paths: Vec<&str> = index.by_path.keys().map(String::as_str).collect();
    assert_eq!(paths, ["empty", "main.typ"]);
}

#[test]
fn leaves_hidden_nodes_alone() {
    let doc = project();
    let dir = add(&doc, None, "d", FileKind::Dir);
    add(&doc, Some(dir), "x.typ", FileKind::Text);
    // An upload that never finished: invisible to materialize.
    add(&doc, None, "pending.png", FileKind::Asset);
    let report = apply(&doc, &[text("main.typ", "m")]);
    assert_eq!(report.deleted, ["d/x.typ"]);
    let index = build_path_index(&doc);
    assert!(index.by_path.contains_key("pending.png"));
    assert!(!index.by_path.contains_key("d"));

    // A new file at a hidden node's path takes the node over.
    let pending = id_of(&doc, "pending.png");
    let report = apply(
        &doc,
        &[text("main.typ", "m"), asset("pending.png", "sha256:bb")],
    );
    assert_eq!(report.created, ["pending.png"]);
    assert_eq!(id_of(&doc, "pending.png"), pending);
}

#[test]
fn rename_keeps_the_node() {
    let doc = project();
    apply(
        &doc,
        &[
            text("main.typ", "main"),
            text("a.typ", "unique"),
            text("dup1.typ", "same"),
            text("dup2.typ", "same"),
            asset("pic.png", "sha256:cc"),
        ],
    );
    let a = id_of(&doc, "a.typ");
    let pic = id_of(&doc, "pic.png");
    let dup = id_of(&doc, "dup1.typ");
    let report = apply(
        &doc,
        &[
            text("main.typ", "main"),
            text("ch/b.typ", "unique"),
            text("dup3.typ", "same"),
            text("dup2.typ", "same"),
            asset("img/pic.png", "sha256:cc"),
        ],
    );
    assert_eq!(
        report.renamed,
        [
            Renamed {
                from: "a.typ".into(),
                to: "ch/b.typ".into()
            },
            Renamed {
                from: "dup1.typ".into(),
                to: "dup3.typ".into()
            },
            Renamed {
                from: "pic.png".into(),
                to: "img/pic.png".into()
            },
        ]
    );
    assert!(report.created.is_empty() && report.deleted.is_empty());
    assert_eq!(id_of(&doc, "ch/b.typ"), a);
    assert_eq!(id_of(&doc, "img/pic.png"), pic);
    assert_eq!(id_of(&doc, "dup3.typ"), dup);

    // Two candidates with the same content: too ambiguous to guess.
    let report = apply(
        &doc,
        &[
            text("main.typ", "main"),
            text("ch/b.typ", "unique"),
            text("x.typ", "same"),
            text("y.typ", "same"),
            asset("img/pic.png", "sha256:cc"),
        ],
    );
    assert!(report.renamed.is_empty());
    assert_eq!(report.created, ["x.typ", "y.typ"]);
    assert_eq!(report.deleted, ["dup2.typ", "dup3.typ"]);
}

#[test]
fn main_file_follows_renames_and_clears_on_delete() {
    let doc = project();
    let main = id_of(&doc, "main.typ");
    let body = materialize(&doc).remove(0).content;
    let moved = MaterializedFile {
        path: "src/thesis.typ".into(),
        content: body,
    };
    apply(&doc, std::slice::from_ref(&moved));
    assert_eq!(main_file(&doc), Some(main));

    apply(&doc, &[text("other.typ", "x")]);
    assert_eq!(main_file(&doc), None);
    let json = loro::ToJson::to_json_value(&doc.get_deep_value());
    assert!(json[root::META]["mainFile"].is_null());
}

#[test]
fn kind_change_recreates_the_node() {
    let doc = project();
    let main = id_of(&doc, "main.typ");
    let report = apply(&doc, &[asset("main.typ", "sha256:dd")]);
    assert_eq!(report.modified, ["main.typ"]);
    assert_ne!(id_of(&doc, "main.typ"), main);
    assert_eq!(main_file(&doc), None);

    // A file becoming a folder and back.
    let report = apply(&doc, &[text("main.typ/inner.typ", "x")]);
    assert_eq!(report.deleted, ["main.typ"]);
    let report = apply(&doc, &[text("main.typ", "y")]);
    assert_eq!(report.deleted, ["main.typ/inner.typ"]);
    assert_eq!(report.created, ["main.typ"]);
}

#[test]
fn skips_invalid_paths() {
    let doc = project();
    let long = "a".repeat(256);
    let report = apply(
        &doc,
        &[
            text("ok.typ", "1"),
            text("ok.typ", "2"),
            text("a\\b.typ", ""),
            text("/abs.typ", ""),
            text("a//b.typ", ""),
            text("../up.typ", ""),
            text("dir/./x.typ", ""),
            text("bell\u{7}.typ", ""),
            text(&long, ""),
            text("ok.typ/nested.typ", ""),
        ],
    );
    let reasons: Vec<(&str, &SkipReason)> = report
        .skipped
        .iter()
        .map(|s| (s.path.as_str(), &s.reason))
        .collect();
    let invalid = |segment: &str, error| SkipReason::InvalidName {
        segment: segment.into(),
        error,
    };
    assert_eq!(
        reasons,
        [
            ("ok.typ", &SkipReason::Duplicate),
            ("a\\b.typ", &invalid("a\\b.typ", NameError::Backslash)),
            ("/abs.typ", &invalid("", NameError::Empty)),
            ("a//b.typ", &invalid("", NameError::Empty)),
            ("../up.typ", &invalid("..", NameError::Reserved)),
            ("dir/./x.typ", &invalid(".", NameError::Reserved)),
            (
                "bell\u{7}.typ",
                &invalid("bell\u{7}.typ", NameError::ControlChar)
            ),
            (long.as_str(), &invalid(&long, NameError::TooLong)),
            (
                "ok.typ/nested.typ",
                &SkipReason::InsideFile {
                    file: "ok.typ".into()
                }
            ),
        ]
    );
    assert_eq!(materialize(&doc), [text("ok.typ", "1")]);
}

#[test]
fn clash_paths_resolve_to_their_own_node() {
    let a = replica(1);
    let b = replica(2);
    let fa = add(&a, None, "x.typ", FileKind::Text);
    let fb = add(&b, None, "x.typ", FileKind::Text);
    sync(&a, &b);
    assert_eq!(id_of(&a, "x~0@2.typ"), fb);

    apply(&a, &[text("x.typ", "a"), text("x~0@2.typ", "b")]);
    assert_eq!(text_content(&a, fa).unwrap().to_string(), "a");
    assert_eq!(text_content(&a, fb).unwrap().to_string(), "b");

    // Without the winner the loser would fall back to "x.typ"; it keeps
    // the path it was pushed under instead.
    let report = apply(&a, &[text("x~0@2.typ", "b")]);
    assert_eq!(report.deleted, ["x.typ"]);
    assert_eq!(id_of(&a, "x~0@2.typ"), fb);
}

#[test]
fn edits_on_forks_of_a_base_merge() {
    let doc = project();
    let body: String = (0..20).map(|i| format!("line {i}\n")).collect();
    apply(&doc, &[text("main.typ", &body), text("old.typ", "o")]);
    let base = doc.oplog_frontiers();

    // A browser edits the start of the file in the meantime.
    let remote = replica(2);
    remote
        .import(&doc.export(ExportMode::Snapshot).unwrap())
        .unwrap();
    let main = id_of(&doc, "main.typ");
    text_content(&remote, main)
        .unwrap()
        .insert(0, "remote\n")
        .unwrap();
    remote.commit();
    sync(&doc, &remote);

    // The local folder still holds the base text plus its own edit at the
    // end, and a rename.
    let fork = doc.fork_at(&base).unwrap();
    fork.set_peer_id(3).unwrap();
    configure(&fork);
    let local_body = format!("{body}local\n");
    let report = apply_files(
        &fork,
        &[text("main.typ", &local_body), text("new.typ", "o")],
        MESSAGE,
    )
    .unwrap();
    assert_eq!(report.renamed.len(), 1);
    doc.import(&fork.export(ExportMode::updates(&doc.oplog_vv())).unwrap())
        .unwrap();

    let merged = text_content(&doc, main).unwrap().to_string();
    assert_eq!(merged, format!("remote\n{body}local\n"));
    let paths: Vec<String> = materialize(&doc).into_iter().map(|f| f.path).collect();
    assert_eq!(paths, ["main.typ", "new.typ"]);
}

#[test]
fn seeds_a_bare_project_from_files() {
    let doc = replica(1);
    init_project_with(&doc, "Bare", false).unwrap();
    apply(&doc, &[text("thesis.typ", "= T")]);
    set_main_file(&doc, Some(id_of(&doc, "thesis.typ"))).unwrap();
    assert_eq!(main_file(&doc), Some(id_of(&doc, "thesis.typ")));
}

const SEGMENTS: [&str; 4] = ["a", "b.typ", ".hidden", "c"];
const BODIES: [&str; 4] = ["", "x", "hello\n", "😀"];

fn file() -> impl Strategy<Value = MaterializedFile> {
    let path = prop::collection::vec(0..SEGMENTS.len(), 1..4)
        .prop_map(|s| s.iter().map(|&i| SEGMENTS[i]).collect::<Vec<_>>().join("/"));
    let content = prop_oneof![
        3 => (0..BODIES.len()).prop_map(|i| FileContent::Text(BODIES[i].into())),
        1 => (0..2u8, 0..2u64).prop_map(|(h, size)| FileContent::Asset {
            hash: format!("sha256:{h}"),
            size,
            mime: "application/octet-stream".into(),
        }),
    ];
    (path, content).prop_map(|(path, content)| MaterializedFile { path, content })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    /// A sequence of random folder states pushed into one doc. `apply`
    /// checks the round trip and the no-op after every step.
    #[test]
    fn any_file_list_round_trips(
        states in prop::collection::vec(prop::collection::vec(file(), 0..8), 1..5)
    ) {
        let doc = project();
        for state in &states {
            let report = apply(&doc, state);
            let invalid = report
                .skipped
                .iter()
                .any(|s| matches!(s.reason, SkipReason::InvalidName { .. }));
            prop_assert!(!invalid);
        }
    }

    /// Two folders forked from the same base, pushed one after the other:
    /// every file both sides agree on survives the merge.
    #[test]
    fn concurrent_pushes_converge(
        start in prop::collection::vec(file(), 0..6),
        left in prop::collection::vec(file(), 0..6),
        right in prop::collection::vec(file(), 0..6),
    ) {
        let a = project();
        apply_files(&a, &start, MESSAGE).unwrap();
        let b = replica(2);
        configure(&b);
        b.import(&a.export(ExportMode::Snapshot).unwrap()).unwrap();
        apply_files(&a, &left, MESSAGE).unwrap();
        apply_files(&b, &right, MESSAGE).unwrap();
        sync(&a, &b);
        prop_assert_eq!(materialize(&a), materialize(&b));
        prop_assert_eq!(build_path_index(&a), build_path_index(&b));
    }
}
