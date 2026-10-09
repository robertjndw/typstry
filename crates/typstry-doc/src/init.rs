//! Project seeding, mirroring `initProject` in `apps/web/src/doc/schema.ts`.

use loro::{LoroDoc, LoroResult, LoroText, TreeParentId};

use crate::{FileKind, SCHEMA_VERSION, meta, node, root, schema_version};

pub const DEFAULT_MAIN_FILE: &str = "main.typ";

/// Body of the seeded `main.typ`. Must match `starterContent` in schema.ts
/// byte for byte, including the `JSON.stringify` quoting of the title.
pub fn starter_content(title: &str) -> String {
    let quoted = serde_json::to_string(title).expect("strings always serialize");
    format!(
        "#set document(title: {quoted})\n#set page(paper: \"a4\")\n\n= {title}\n\nHello, Typst!\n"
    )
}

/// Seeds an empty doc with the schema version, title and a `main.typ`.
/// Does nothing if the doc already carries a schema version.
pub fn init_project(doc: &LoroDoc, title: &str) -> LoroResult<()> {
    if schema_version(doc).is_some() {
        return Ok(());
    }
    // History groups changes by time, so the seed change should carry one
    // like every change a browser makes.
    doc.set_record_timestamp(true);
    let meta_map = doc.get_map(root::META);

    let tree = doc.get_tree(root::FS);
    // Same reasoning as the TS ProjectDoc: sibling order is meaningless for a
    // file tree, and this is a per-instance setting that is never synced.
    tree.disable_fractional_index();

    let id = tree.create(TreeParentId::Root)?;
    let data = tree.get_meta(id)?;
    data.insert(node::KIND, FileKind::Text.as_str())?;
    data.insert(node::NAME, DEFAULT_MAIN_FILE)?;
    let content = data.insert_container(node::CONTENT, LoroText::new())?;
    content.insert(0, &starter_content(title))?;

    // JS numbers are stored as doubles, so write a double to produce the
    // exact same value a browser-seeded project would have.
    meta_map.insert(meta::SCHEMA, SCHEMA_VERSION as f64)?;
    meta_map.insert(meta::TITLE, title)?;
    meta_map.insert(meta::MAIN_FILE, id.to_string())?;
    doc.set_next_commit_message("init project");
    doc.commit();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::build_path_index;
    use loro::{ExportMode, ToJson};

    #[test]
    fn starter_content_quotes_like_json_stringify() {
        assert_eq!(
            starter_content("A \"quoted\" \\ title"),
            "#set document(title: \"A \\\"quoted\\\" \\\\ title\")\n#set page(paper: \"a4\")\n\n= A \"quoted\" \\ title\n\nHello, Typst!\n"
        );
    }

    #[test]
    fn seeds_main_file_and_meta() {
        let doc = LoroDoc::new();
        init_project(&doc, "Thesis").unwrap();

        let json = doc.get_deep_value().to_json_value();
        assert_eq!(json[root::META][meta::SCHEMA], SCHEMA_VERSION as f64);
        assert_eq!(json[root::META][meta::TITLE], "Thesis");

        let index = build_path_index(&doc);
        let main_id = index.by_path["main.typ"];
        assert_eq!(json[root::META][meta::MAIN_FILE], main_id.to_string());

        let content = crate::text_content(&doc, main_id).unwrap();
        assert_eq!(content.to_string(), starter_content("Thesis"));

        // Survives a snapshot round trip, which is what the server stores.
        let snapshot = doc.export(ExportMode::Snapshot).unwrap();
        let copy = LoroDoc::from_snapshot(&snapshot).unwrap();
        assert_eq!(copy.get_deep_value(), doc.get_deep_value());
    }

    #[test]
    fn seed_change_has_a_timestamp() {
        let doc = LoroDoc::new();
        init_project(&doc, "Dated").unwrap();
        let frontiers = doc.oplog_frontiers();
        let id = frontiers.iter().next().unwrap();
        let change = doc.get_change(id).unwrap();
        assert!(change.timestamp > 1_600_000_000, "{}", change.timestamp);
        assert_eq!(change.message.as_deref(), Some("init project"));
    }

    #[test]
    fn is_idempotent() {
        let doc = LoroDoc::new();
        init_project(&doc, "One").unwrap();
        let before = doc.oplog_vv();
        init_project(&doc, "Two").unwrap();
        assert_eq!(doc.oplog_vv(), before);
    }
}
