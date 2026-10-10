//! Shared schema for the per-project LoroDoc.
//!
//! These names must stay in sync with `apps/web/src/doc/schema.ts`; both sides
//! read and write the same containers.

pub mod apply;
pub mod init;
pub mod materialize;
pub mod names;
pub mod paths;
pub mod peers;
#[cfg(any(test, feature = "test-util"))]
pub mod testing;
pub mod versions;

pub use versions::{NamedVersion, named_versions};

use std::fmt;
use std::str::FromStr;

use loro::{LoroDoc, LoroText, LoroValue, TreeID, ValueOrContainer};

/// Bumped whenever the document layout changes incompatibly.
pub const SCHEMA_VERSION: i64 = 1;

/// The doc's `meta.schema`, or None for a doc that was never initialized.
/// Browsers write JS numbers, so the value usually arrives as a double; a
/// fractional one rounds up so it can never pass for an older version.
pub fn schema_version(doc: &LoroDoc) -> Option<i64> {
    match doc
        .get_map(root::META)
        .get(meta::SCHEMA)?
        .into_value()
        .ok()?
    {
        LoroValue::I64(v) => Some(v),
        LoroValue::Double(v) if v.is_finite() => Some(v.ceil() as i64),
        _ => None,
    }
}

/// Loro merges consecutive local commits into one change while they are at
/// most this many seconds apart. Same value as the browser, see
/// `CHANGE_MERGE_INTERVAL_S` in schema.ts for the reasoning.
pub const CHANGE_MERGE_INTERVAL_S: i64 = 30;

/// Applies the per-instance settings the browser's `ProjectDoc` applies.
/// None of them are synced, so every doc that will be edited locally needs
/// this before its first commit.
pub fn configure(doc: &LoroDoc) {
    doc.get_tree(root::FS).disable_fractional_index();
    doc.set_record_timestamp(true);
    doc.set_change_merge_interval(CHANGE_MERGE_INTERVAL_S);
}

/// The project title from `meta.title`, if it is a non-empty string.
pub fn title(doc: &LoroDoc) -> Option<String> {
    match doc
        .get_map(root::META)
        .get(meta::TITLE)?
        .into_value()
        .ok()?
    {
        LoroValue::String(s) if !s.trim().is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// The content of a text node. None for other kinds, and for a text node
/// whose content container has not been synced yet.
pub fn text_content(doc: &LoroDoc, id: TreeID) -> Option<LoroText> {
    doc.get_tree(root::FS)
        .get_meta(id)
        .ok()?
        .get(node::CONTENT)?
        .into_container()
        .ok()?
        .into_text()
        .ok()
}

/// The main file from `meta.mainFile`, or None when unset or when it no
/// longer resolves to a live node (a peer may delete it without clearing
/// the field).
pub fn main_file(doc: &LoroDoc) -> Option<TreeID> {
    let value = string_value(doc.get_map(root::META).get(meta::MAIN_FILE))?;
    let id = TreeID::try_from(value.as_str()).ok()?;
    let tree = doc.get_tree(root::FS);
    (tree.contains(id) && !tree.is_node_deleted(&id).ok()?).then_some(id)
}

pub(crate) fn string_value(value: Option<ValueOrContainer>) -> Option<String> {
    match value? {
        ValueOrContainer::Value(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

/// Root container names.
pub mod root {
    /// Map with project-level settings (`schema`, `title`, `mainFile`).
    pub const META: &str = "meta";
    /// Map of `peerId -> {name, color}`, kept for history and git attribution.
    pub const PEERS: &str = "peers";
    /// Tree holding the project's files and directories.
    pub const FS: &str = "fs";
    /// Append-only list of named versions, see [`super::version`].
    pub const VERSIONS: &str = "versions";
    /// Map of deleted named versions: the entry's list element id
    /// (`counter@peer`) to the deletion time in unix ms. Entries stay in
    /// `versions` so that later indexes never shift.
    pub const DELETED_VERSIONS: &str = "deletedVersions";
}

/// Keys of each entry in the `versions` list. An entry names a point in
/// history; it is meant to become a git commit of `materialize_at(frontiers)`.
pub mod version {
    pub const NAME: &str = "name";
    /// `Frontiers::encode()` bytes (the JS `encodeFrontiers` format).
    pub const FRONTIERS: &str = "frontiers";
    /// Unix milliseconds.
    pub const CREATED_AT: &str = "createdAt";
    /// Peer id (decimal string) of whoever saved it.
    pub const AUTHOR: &str = "author";
}

/// Keys of each entry in the `peers` map.
pub mod peer {
    pub const NAME: &str = "name";
    pub const COLOR: &str = "color";
}

/// Keys inside the `meta` map.
pub mod meta {
    pub const SCHEMA: &str = "schema";
    pub const TITLE: &str = "title";
    pub const MAIN_FILE: &str = "mainFile";
}

/// Keys inside each `fs` tree node's data map.
pub mod node {
    pub const KIND: &str = "kind";
    /// A single path segment; full paths are derived from the tree.
    pub const NAME: &str = "name";
    /// LoroText with the file body, only for [`super::FileKind::Text`].
    pub const CONTENT: &str = "content";
    /// Content hash into the blob store, only for [`super::FileKind::Asset`].
    pub const HASH: &str = "hash";
    pub const SIZE: &str = "size";
    pub const MIME: &str = "mime";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileKind {
    Dir,
    Text,
    Asset,
}

impl FileKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dir => "dir",
            Self::Text => "text",
            Self::Asset => "asset",
        }
    }
}

impl fmt::Display for FileKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownFileKind(pub String);

impl fmt::Display for UnknownFileKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown file kind {:?}", self.0)
    }
}

impl std::error::Error for UnknownFileKind {}

impl FromStr for FileKind {
    type Err = UnknownFileKind;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "dir" => Ok(Self::Dir),
            "text" => Ok(Self::Text),
            "asset" => Ok(Self::Asset),
            other => Err(UnknownFileKind(other.to_owned())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro::{Frontiers, LoroText, ToJson};

    #[test]
    fn file_kind_round_trips() {
        for kind in [FileKind::Dir, FileKind::Text, FileKind::Asset] {
            assert_eq!(kind.as_str().parse::<FileKind>(), Ok(kind));
        }
        assert!("symlink".parse::<FileKind>().is_err());
    }

    #[test]
    fn builds_doc_with_schema_names() {
        let doc = LoroDoc::new();
        doc.get_map(root::META)
            .insert(meta::SCHEMA, SCHEMA_VERSION)
            .unwrap();

        let tree = doc.get_tree(root::FS);
        let id = tree.create(None).unwrap();
        let data = tree.get_meta(id).unwrap();
        data.insert(node::KIND, FileKind::Text.as_str()).unwrap();
        data.insert(node::NAME, "main.typ").unwrap();
        let content = data
            .insert_container(node::CONTENT, LoroText::new())
            .unwrap();
        content.insert(0, "= Hello").unwrap();
        doc.commit();

        let data = tree.get_meta(id).unwrap();
        let kind = data.get(node::KIND).unwrap().into_value().unwrap();
        assert_eq!(kind, LoroValue::from("text"));
        assert_eq!(content.to_string(), "= Hello");

        let json = doc.get_deep_value().to_json_value();
        assert_eq!(json[root::META][meta::SCHEMA], SCHEMA_VERSION);
        assert_eq!(schema_version(&doc), Some(SCHEMA_VERSION));
    }

    #[test]
    fn frontiers_encoding_matches_js() {
        // Bytes produced by `encodeFrontiers` from loro-crdt 1.16.4.
        let decoded = Frontiers::decode(&[2, 7, 6, 9, 2]).unwrap();
        let expected: Frontiers = [loro::ID::new(7, 3), loro::ID::new(9, 1)].as_slice().into();
        assert_eq!(decoded, expected);
        let single: Frontiers = loro::ID::new(7, 3).into();
        assert_eq!(single.encode(), [1, 7, 6]);
    }

    #[test]
    fn reads_schema_written_as_double() {
        let doc = LoroDoc::new();
        assert_eq!(schema_version(&doc), None);
        let meta_map = doc.get_map(root::META);
        meta_map.insert(meta::SCHEMA, 2.0).unwrap();
        assert_eq!(schema_version(&doc), Some(2));
        meta_map.insert(meta::SCHEMA, 1.5).unwrap();
        assert_eq!(schema_version(&doc), Some(2));
        meta_map.insert(meta::SCHEMA, "1").unwrap();
        assert_eq!(schema_version(&doc), None);
    }
}
