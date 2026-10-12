//! Project seeding, mirroring `initProject` in `apps/web/src/doc/schema.ts`.

use loro::{LoroDoc, LoroError, LoroResult, LoroText, LoroValue, TreeID, TreeParentId};

use crate::{
    FileKind, SCHEMA_VERSION, configure, is_string, kind, meta, node, root, schema_version,
};

pub const DEFAULT_MAIN_FILE: &str = "main.typ";

/// Body of the seeded `main.typ`. Must match `starterContent` in schema.ts
/// byte for byte, including the `JSON.stringify` quoting of the title.
pub fn starter_content(title: &str) -> String {
    let quoted = serde_json::to_string(title).expect("strings always serialize");
    format!(
        "#set document(title: {quoted})\n#set page(paper: \"a4\")\n\n= {title}\n\nHello, Typst!\n"
    )
}

/// Seeds an empty doc with the schema version, title and a `main.typ`, like
/// a project created in the browser. Does nothing if the doc already
/// carries a schema version.
pub fn init_project(doc: &LoroDoc, title: &str) -> LoroResult<()> {
    seed(doc, title, true)
}

/// Like [`init_project`], but writes only the schema version and title and
/// leaves `meta.mainFile` unset, for projects whose files come from
/// somewhere else.
pub fn init_bare_project(doc: &LoroDoc, title: &str) -> LoroResult<()> {
    seed(doc, title, false)
}

fn seed(doc: &LoroDoc, title: &str, starter: bool) -> LoroResult<()> {
    if schema_version(doc).is_some() {
        return Ok(());
    }
    // History groups changes by time, so the seed change should carry a
    // timestamp like every change a browser makes.
    configure(doc);
    let meta_map = doc.get_map(root::META);

    if starter {
        let tree = doc.get_tree(root::FS);
        let id = tree.create(TreeParentId::Root)?;
        let data = tree.get_meta(id)?;
        data.insert(node::KIND, FileKind::Text.as_str())?;
        data.insert(node::NAME, DEFAULT_MAIN_FILE)?;
        let content = data.insert_container(node::CONTENT, LoroText::new())?;
        content.insert(0, &starter_content(title))?;
        meta_map.insert(meta::MAIN_FILE, id.to_string())?;
    }

    // JS numbers are stored as doubles, so write a double to produce the
    // exact same value a browser-seeded project would have.
    meta_map.insert(meta::KIND, kind::PROJECT)?;
    meta_map.insert(meta::SCHEMA, SCHEMA_VERSION as f64)?;
    meta_map.insert(meta::TITLE, title)?;
    doc.set_next_commit_message("init project");
    doc.commit();
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum SetMainFileError {
    /// The id is not a live text node.
    #[error("not a text file: {0}")]
    NotATextFile(TreeID),
    #[error(transparent)]
    Loro(#[from] LoroError),
}

/// Points `meta.mainFile` at a text node, or clears it with None. Commits
/// like `setMainFile` in fs-ops.ts, but writes nothing when the value is
/// already the same.
pub fn set_main_file(doc: &LoroDoc, id: Option<TreeID>) -> Result<(), SetMainFileError> {
    let meta_map = doc.get_map(root::META);
    let value = match id {
        Some(id) => {
            let tree = doc.get_tree(root::FS);
            let is_text = tree.contains(id)
                && !tree.is_node_deleted(&id)?
                && is_string(tree.get_meta(id)?.get(node::KIND), FileKind::Text.as_str());
            if !is_text {
                return Err(SetMainFileError::NotATextFile(id));
            }
            LoroValue::from(id.to_string())
        }
        None => LoroValue::Null,
    };
    let current = meta_map
        .get(meta::MAIN_FILE)
        .and_then(|v| v.into_value().ok());
    // An absent key and an explicit null both mean "no main file".
    if current.unwrap_or(LoroValue::Null) == value {
        return Ok(());
    }
    meta_map.insert(meta::MAIN_FILE, value)?;
    doc.set_next_commit_message("set main file");
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
    fn seeds_without_starter() {
        let doc = LoroDoc::new();
        init_bare_project(&doc, "Bare").unwrap();
        let json = doc.get_deep_value().to_json_value();
        assert_eq!(json[root::META][meta::SCHEMA], SCHEMA_VERSION as f64);
        assert_eq!(json[root::META][meta::TITLE], "Bare");
        assert!(json[root::META].get(meta::MAIN_FILE).is_none());
        assert!(build_path_index(&doc).by_id.is_empty());
        assert_eq!(crate::main_file(&doc), None);
    }

    #[test]
    fn sets_and_clears_main_file() {
        let doc = LoroDoc::new();
        init_bare_project(&doc, "M").unwrap();
        let text = crate::testing::add(&doc, None, "a.typ", FileKind::Text);
        let dir = crate::testing::add(&doc, None, "d", FileKind::Dir);

        set_main_file(&doc, Some(text)).unwrap();
        assert_eq!(crate::main_file(&doc), Some(text));
        let vv = doc.oplog_vv();
        set_main_file(&doc, Some(text)).unwrap();
        assert_eq!(doc.oplog_vv(), vv);

        assert!(matches!(
            set_main_file(&doc, Some(dir)),
            Err(SetMainFileError::NotATextFile(_))
        ));
        set_main_file(&doc, None).unwrap();
        assert_eq!(crate::main_file(&doc), None);
        let json = doc.get_deep_value().to_json_value();
        assert!(json[root::META][meta::MAIN_FILE].is_null());
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
