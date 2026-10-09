//! Turns the `fs` tree into a flat, deterministic list of files. Exports
//! (zip, PDF, git) are meant to go through here, so paths come from
//! [`build_path_index`] and clash renames apply.

use loro::{Frontiers, LoroDoc, LoroResult, LoroValue, ValueOrContainer};

use crate::paths::build_path_index;
use crate::{FileKind, node, root, string_value, text_content};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileContent {
    Text(String),
    /// Bytes live in the blob store; only the reference is in the doc.
    Asset {
        hash: String,
        size: u64,
        mime: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedFile {
    /// `/`-separated, relative, never empty.
    pub path: String,
    pub content: FileContent,
}

/// Every text file and asset in the current state, sorted by path (byte
/// order).
///
/// Directories are only implied by the paths, so empty directories are not
/// part of the output. Git cannot store them either, and keeping zip export
/// identical to the future git tree matters more than preserving an empty
/// folder. Asset nodes without a usable hash are skipped because there is
/// nothing to export for them, and so are files whose path is unsafe to
/// write to a real file system (see [`is_safe_path`]).
pub fn materialize(doc: &LoroDoc) -> Vec<MaterializedFile> {
    let index = build_path_index(doc);
    let tree = doc.get_tree(root::FS);
    let mut files = Vec::with_capacity(index.by_path.len());
    // by_path rather than by_id: it is already sorted and its keys are
    // unique even in the pathological case described in resolve_sibling_names.
    for (path, id) in &index.by_path {
        let Some(entry) = index.by_id.get(id) else {
            continue;
        };
        if !is_safe_path(path) {
            continue;
        }
        let Ok(meta) = tree.get_meta(*id) else {
            continue;
        };
        let content = match entry.kind {
            FileKind::Dir => continue,
            FileKind::Text => {
                let text = text_content(doc, *id)
                    .map(|t| t.to_string())
                    .unwrap_or_default();
                FileContent::Text(text)
            }
            FileKind::Asset => {
                let Some(hash) = string_value(meta.get(node::HASH)).filter(|h| !h.is_empty())
                else {
                    continue;
                };
                FileContent::Asset {
                    hash,
                    size: number(meta.get(node::SIZE)).unwrap_or(0),
                    mime: string_value(meta.get(node::MIME))
                        .unwrap_or_else(|| "application/octet-stream".to_owned()),
                }
            }
        };
        files.push(MaterializedFile {
            path: path.clone(),
            content,
        });
    }
    files
}

/// Like [`materialize`], but for the state at `frontiers`. Works on a fork,
/// so `doc` itself is never checked out and live editing is not disturbed.
pub fn materialize_at(doc: &LoroDoc, frontiers: &Frontiers) -> LoroResult<Vec<MaterializedFile>> {
    Ok(materialize(&doc.fork_at(frontiers)?))
}

/// The UI refuses names like `..` or ones with control characters, but a
/// modified client can write anything into the doc, and exported paths end
/// up on disk when someone unzips or checks out the project. Backslashes
/// count as separators here because Windows tools treat them as such.
pub fn is_safe_path(path: &str) -> bool {
    path.split(['/', '\\']).all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.chars().any(char::is_control)
    })
}

/// Sizes written by the browser arrive as doubles.
fn number(value: Option<ValueOrContainer>) -> Option<u64> {
    match value? {
        ValueOrContainer::Value(LoroValue::I64(n)) => u64::try_from(n).ok(),
        ValueOrContainer::Value(LoroValue::Double(n)) if n >= 0.0 && n.is_finite() => {
            Some(n as u64)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{init_project, starter_content};
    use crate::testing::add;
    use crate::text_content;
    use loro::TreeID;

    fn set_text(doc: &LoroDoc, id: TreeID, text: &str) {
        let content = text_content(doc, id).unwrap();
        content.update(text, Default::default()).unwrap();
        doc.commit();
    }

    fn paths(files: &[MaterializedFile]) -> Vec<&str> {
        files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn materializes_texts_and_assets_sorted() {
        let doc = LoroDoc::new();
        doc.set_peer_id(1).unwrap();
        init_project(&doc, "T").unwrap();
        let dir = add(&doc, None, "chapters", FileKind::Dir);
        let intro = add(&doc, Some(dir), "intro.typ", FileKind::Text);
        set_text(&doc, intro, "= Intro\n");
        add(&doc, None, "empty", FileKind::Dir);
        let logo = add(&doc, Some(dir), "logo.png", FileKind::Asset);
        let meta = doc.get_tree(root::FS).get_meta(logo).unwrap();
        meta.insert(node::HASH, "sha256:abc").unwrap();
        // The browser writes JS numbers, i.e. doubles.
        meta.insert(node::SIZE, 42.0).unwrap();
        meta.insert(node::MIME, "image/png").unwrap();
        // An asset whose upload never finished has no hash and is skipped.
        add(&doc, None, "pending.png", FileKind::Asset);
        doc.commit();

        let files = materialize(&doc);
        assert_eq!(
            paths(&files),
            ["chapters/intro.typ", "chapters/logo.png", "main.typ"]
        );
        assert_eq!(files[0].content, FileContent::Text("= Intro\n".into()));
        assert_eq!(
            files[1].content,
            FileContent::Asset {
                hash: "sha256:abc".into(),
                size: 42,
                mime: "image/png".into()
            }
        );
        assert_eq!(files[2].content, FileContent::Text(starter_content("T")));
    }

    #[test]
    fn skips_unsafe_paths() {
        let doc = LoroDoc::new();
        for name in [".", "..\\evil.typ", "nul\0.typ", "ok.typ", "a\\b.typ"] {
            add(&doc, None, name, FileKind::Text);
        }
        let dir = add(&doc, None, "..", FileKind::Dir);
        add(&doc, Some(dir), "inner.typ", FileKind::Text);

        assert_eq!(paths(&materialize(&doc)), ["a\\b.typ", "ok.typ"]);
        assert!(is_safe_path("chapters/intro.typ"));
        assert!(!is_safe_path("/abs.typ"));
        assert!(!is_safe_path("a//b"));
    }

    #[test]
    fn applies_clash_renames() {
        let a = LoroDoc::new();
        a.set_peer_id(1).unwrap();
        let b = LoroDoc::new();
        b.set_peer_id(2).unwrap();
        let fa = add(&a, None, "x.typ", FileKind::Text);
        let fb = add(&b, None, "x.typ", FileKind::Text);
        set_text(&a, fa, "a");
        set_text(&b, fb, "b");
        a.import(&b.export(loro::ExportMode::all_updates()).unwrap())
            .unwrap();

        let files = materialize(&a);
        assert_eq!(paths(&files), ["x.typ", "x~0@2.typ"]);
        assert_eq!(files[0].content, FileContent::Text("a".into()));
        assert_eq!(files[1].content, FileContent::Text("b".into()));
    }

    #[test]
    fn materializes_old_versions_without_touching_the_doc() {
        let doc = LoroDoc::new();
        init_project(&doc, "Old").unwrap();
        let before = doc.oplog_frontiers();
        let main = build_path_index(&doc).by_path["main.typ"];
        set_text(&doc, main, "rewritten");
        let extra = add(&doc, None, "extra.typ", FileKind::Text);
        set_text(&doc, extra, "new");

        let old = materialize_at(&doc, &before).unwrap();
        assert_eq!(paths(&old), ["main.typ"]);
        assert_eq!(old[0].content, FileContent::Text(starter_content("Old")));

        let now = materialize(&doc);
        assert_eq!(paths(&now), ["extra.typ", "main.typ"]);
        assert!(!doc.is_detached());
        assert_eq!(materialize(&doc), materialize(&doc));
    }
}
