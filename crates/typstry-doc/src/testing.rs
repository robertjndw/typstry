//! Fixtures shared by the unit tests and the integration tests in `tests/`.

use loro::{ExportMode, LoroDoc, LoroText, TreeID};

use crate::materialize::FileContent;
use crate::{FileKind, node, root};

/// A doc with a fixed peer id. Fractional indexes are off so sibling order
/// does not depend on random position keys.
pub fn replica(peer: u64) -> LoroDoc {
    let doc = LoroDoc::new();
    doc.set_peer_id(peer).unwrap();
    doc.get_tree(root::FS).disable_fractional_index();
    doc
}

/// Exchanges everything both docs are missing.
pub fn sync(a: &LoroDoc, b: &LoroDoc) {
    b.import(&a.export(ExportMode::updates(&b.oplog_vv())).unwrap())
        .unwrap();
    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
        .unwrap();
}

/// Creates and commits a node the way the web client does.
pub fn add(doc: &LoroDoc, parent: Option<TreeID>, name: &str, kind: FileKind) -> TreeID {
    let tree = doc.get_tree(root::FS);
    let id = tree.create(parent).unwrap();
    let meta = tree.get_meta(id).unwrap();
    meta.insert(node::KIND, kind.as_str()).unwrap();
    meta.insert(node::NAME, name).unwrap();
    if kind == FileKind::Text {
        meta.insert_container(node::CONTENT, LoroText::new())
            .unwrap();
    }
    doc.commit();
    id
}

/// How the compat fixtures' `doc.json` describes a file, both when the CLI
/// writes a fixture and when this crate checks one.
pub fn file_json(path: &str, content: &FileContent) -> serde_json::Value {
    match content {
        FileContent::Text(text) => {
            serde_json::json!({ "path": path, "kind": "text", "text": &**text })
        }
        FileContent::Asset { hash, size, mime } => serde_json::json!({
            "path": path, "kind": "asset", "hash": hash, "size": size, "mime": mime,
        }),
    }
}
