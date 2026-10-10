//! Turns the `fs` tree into a flat, deterministic list of files. Exports
//! (zip, PDF, git) are meant to go through here, so paths come from
//! [`build_path_index`] and clash renames apply.

use std::collections::BTreeMap;
use std::sync::Arc;

use loro::{Frontiers, LoroDoc, LoroResult, LoroValue, TreeID, ValueOrContainer};

use crate::names::is_portable_segment;
use crate::paths::{PathEntry, PathIndex, build_path_index};
use crate::{FileKind, node, node_text, root, string_value};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FileContent {
    /// Shared, since callers keep several copies of a project's files
    /// around and compare them; equal clones compare by pointer.
    Text(Arc<str>),
    /// Bytes live in the blob store; only the reference is in the doc.
    Asset {
        hash: String,
        size: u64,
        mime: String,
    },
}

impl FileContent {
    /// The blob hash, for an asset.
    pub fn asset_hash(&self) -> Option<&str> {
        match self {
            Self::Text(_) => None,
            Self::Asset { hash, .. } => Some(hash),
        }
    }

    /// The size of the file on disk, in bytes.
    pub fn size(&self) -> u64 {
        match self {
            Self::Text(text) => text.len() as u64,
            Self::Asset { size, .. } => *size,
        }
    }
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
    let PathIndex { by_path, by_id } = build_path_index(doc);
    collect_files(doc, &by_id, by_path)
        .into_iter()
        .map(|(_, file)| file)
        .collect()
}

/// [`materialize`] with the node behind each file, for callers that already
/// built the index.
pub(crate) fn materialize_indexed(
    doc: &LoroDoc,
    index: &PathIndex,
) -> Vec<(TreeID, MaterializedFile)> {
    collect_files(
        doc,
        &index.by_id,
        index.by_path.iter().map(|(path, id)| (path, *id)),
    )
}

/// Takes the paths by value where the caller can give them up, so that
/// [`materialize`] moves them out of the index instead of copying them.
fn collect_files<P: AsRef<str> + Into<String>>(
    doc: &LoroDoc,
    by_id: &BTreeMap<TreeID, PathEntry>,
    // by_path rather than by_id: it is already sorted and its keys are
    // unique even in the pathological case described in
    // resolve_sibling_names.
    by_path: impl IntoIterator<Item = (P, TreeID)>,
) -> Vec<(TreeID, MaterializedFile)> {
    let mut files = Vec::with_capacity(by_id.len());
    for (path, id) in by_path {
        let Some(entry) = by_id.get(&id) else {
            continue;
        };
        if !is_safe_path(path.as_ref()) {
            continue;
        }
        if let Some(content) = file_content(doc, id, entry.kind) {
            files.push((
                id,
                MaterializedFile {
                    path: path.into(),
                    content,
                },
            ));
        }
    }
    files
}

/// What [`materialize`] would list for a node, ignoring its path. None for
/// directories and for assets without a hash.
pub(crate) fn file_content(doc: &LoroDoc, id: TreeID, kind: FileKind) -> Option<FileContent> {
    let meta = doc.get_tree(root::FS).get_meta(id).ok()?;
    match kind {
        FileKind::Dir => None,
        FileKind::Text => {
            let text = node_text(&meta).map(|t| t.to_string()).unwrap_or_default();
            Some(FileContent::Text(text.into()))
        }
        FileKind::Asset => {
            let hash = string_value(meta.get(node::HASH)).filter(|h| !h.is_empty())?;
            Some(FileContent::Asset {
                hash,
                size: number(meta.get(node::SIZE)).unwrap_or(0),
                mime: string_value(meta.get(node::MIME))
                    .unwrap_or_else(|| "application/octet-stream".to_owned()),
            })
        }
    }
}

/// Like [`materialize`], but for the state at `frontiers`. Works on a fork,
/// so `doc` itself is never checked out and live editing is not disturbed.
pub fn materialize_at(doc: &LoroDoc, frontiers: &Frontiers) -> LoroResult<Vec<MaterializedFile>> {
    Ok(materialize(&doc.fork_at(frontiers)?))
}

/// The UI refuses names like `..` or ones with control characters, but a
/// modified client can write anything into the doc, and exported paths end
/// up on disk when someone unzips or checks out the project. Backslashes
/// count as separators here because Windows tools treat them as such, and
/// segments that some file system would read as `.git` or as a drive or
/// device are refused for the same reason.
pub fn is_safe_path(path: &str) -> bool {
    path.split(['/', '\\']).all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.chars().any(char::is_control)
            && is_portable_segment(segment)
    })
}

/// Sizes written by the browser arrive as doubles.
pub(crate) fn number(value: Option<ValueOrContainer>) -> Option<u64> {
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
        assert_eq!(
            files[2].content,
            FileContent::Text(starter_content("T").into())
        );
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
        for path in [
            ".GIT/config",
            "sub/.Git/config",
            "GIT~1/HEAD",
            ".git./config",
            ".typstry/doc.bin",
            "C:/x.typ",
            "a:b.typ",
            "nul.txt",
            "dir/notes.",
        ] {
            assert!(!is_safe_path(path), "{path}");
        }
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
        assert_eq!(
            old[0].content,
            FileContent::Text(starter_content("Old").into())
        );

        let now = materialize(&doc);
        assert_eq!(paths(&now), ["extra.typ", "main.typ"]);
        assert!(!doc.is_detached());
        assert_eq!(materialize(&doc), materialize(&doc));
    }
}
