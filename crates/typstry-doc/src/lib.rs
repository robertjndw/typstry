//! Shared schema for the per-project LoroDoc.
//!
//! These names must stay in sync with `apps/web/src/doc/schema.ts`; both sides
//! read and write the same containers.

pub mod apply;
pub mod directory;
pub mod init;
pub mod materialize;
pub mod names;
pub mod paths;
pub mod peers;
#[cfg(any(test, feature = "test-util"))]
pub mod testing;
pub mod versions;

pub use names::{MAX_TITLE_CHARS, normalize_title};
pub use versions::{NamedVersion, named_versions};

use std::fmt;
use std::str::FromStr;

use loro::{LoroDoc, LoroMap, LoroText, LoroValue, TreeID, ValueOrContainer};

/// Bumped whenever the document layout changes incompatibly, meaning an
/// older client writing into the doc would corrupt it. Additive data older
/// clients ignore (like `deletedVersions`) doesn't count. Docs are never
/// rewritten wholesale, so readers have to keep handling every schema from
/// 1 up. Must match `SCHEMA_VERSION` in schema.ts.
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

/// The doc was written in a layout newer than this build understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error(
    "this project uses document layout {found}, but this typstry only supports up to {supported}; upgrade typstry"
)]
pub struct SchemaTooNew {
    pub found: i64,
    pub supported: i64,
}

/// The doc's `meta.kind`, or None while it is unset or not a string.
pub fn doc_kind(doc: &LoroDoc) -> Option<String> {
    string_value(doc.get_map(root::META).get(meta::KIND))
}

/// The doc is some other kind of space than a project, say a person's
/// directory reached through a link that was meant for a project.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("this link does not open a project")]
pub struct ForeignKind {
    pub found: String,
}

/// Why a project doc must not be used.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Unsupported {
    #[error(transparent)]
    TooNew(#[from] SchemaTooNew),
    #[error(transparent)]
    ForeignKind(#[from] ForeignKind),
}

/// Fails for a doc that is not a project, or whose `meta.schema` is newer
/// than [`SCHEMA_VERSION`]. Anyone about to write into the doc must check
/// this first: an older client editing a newer layout would corrupt it for
/// everyone. A doc without a kind or schema yet (still syncing, or not
/// initialized) passes.
pub fn ensure_supported(doc: &LoroDoc) -> Result<(), Unsupported> {
    if let Some(found) = doc_kind(doc)
        && found != kind::PROJECT
    {
        return Err(ForeignKind { found }.into());
    }
    match schema_version(doc) {
        Some(found) if found > SCHEMA_VERSION => Err(SchemaTooNew {
            found,
            supported: SCHEMA_VERSION,
        }
        .into()),
        _ => Ok(()),
    }
}

/// One migration step: `MIGRATIONS[i]` brings a doc from schema `i + 1` to
/// `i + 2`.
type Migration = fn(&LoroDoc) -> loro::LoroResult<()>;

/// Steps must be deterministic and idempotent: two peers can migrate the
/// same doc at once and the CRDT merges both sets of ops, so a step has to
/// write exactly what any other peer would, and do nothing on a doc that is
/// already (partly) migrated. No random ids, timestamps or peer ids.
/// Mirrors `MIGRATIONS` in schema.ts step by step.
const MIGRATIONS: &[Migration] = &[];

const _: () = assert!(MIGRATIONS.len() as i64 == SCHEMA_VERSION - 1);

/// Brings an older doc up to [`SCHEMA_VERSION`] and returns whether it
/// changed anything. Only for writers, and only once the doc has caught up
/// with the server so the steps see the whole project. Docs without a
/// schema (empty, or about to be seeded by their creator) and newer docs
/// are left alone; call [`ensure_supported`] first for the latter.
pub fn migrate(doc: &LoroDoc) -> loro::LoroResult<bool> {
    let Some(from) = schema_version(doc) else {
        return Ok(false);
    };
    if from >= SCHEMA_VERSION {
        return Ok(false);
    }
    // Schemas start at 1, so anything smaller is garbage. Run every step.
    let first = usize::try_from(from.max(1) - 1).unwrap_or(0);
    for step in &MIGRATIONS[first..] {
        step(doc)?;
    }
    // A double, like the browser writes, so concurrent migrations from
    // both sides store the same value.
    doc.get_map(root::META)
        .insert(meta::SCHEMA, SCHEMA_VERSION as f64)?;
    doc.set_next_commit_message("migrate schema");
    doc.commit();
    Ok(true)
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
    configure_commits(doc);
}

/// The part of [`configure`] every kind of doc shares.
pub(crate) fn configure_commits(doc: &LoroDoc) {
    doc.set_record_timestamp(true);
    doc.set_change_merge_interval(CHANGE_MERGE_INTERVAL_S);
}

/// The project title from `meta.title`, normalized with
/// [`normalize_title`]. None when it is missing or not a usable title.
pub fn title(doc: &LoroDoc) -> Option<String> {
    match doc
        .get_map(root::META)
        .get(meta::TITLE)?
        .into_value()
        .ok()?
    {
        LoroValue::String(s) => normalize_title(&s).map(str::to_owned),
        _ => None,
    }
}

/// The content of a text node. None for other kinds, and for a text node
/// whose content container has not been synced yet.
pub fn text_content(doc: &LoroDoc, id: TreeID) -> Option<LoroText> {
    node_text(&doc.get_tree(root::FS).get_meta(id).ok()?)
}

/// [`text_content`] for a node whose data map is already at hand.
pub(crate) fn node_text(data: &LoroMap) -> Option<LoroText> {
    data.get(node::CONTENT)?
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

/// Whether `value` is the string `want`, without copying it out.
pub(crate) fn is_string(value: Option<ValueOrContainer>, want: &str) -> bool {
    matches!(value, Some(ValueOrContainer::Value(LoroValue::String(s))) if s.as_str() == want)
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

/// Values of `meta.kind`. A project link must never open a directory, nor
/// the other way around.
pub mod kind {
    pub const PROJECT: &str = "project";
    pub const DIRECTORY: &str = "directory";
}

/// Keys inside the `meta` map.
pub mod meta {
    /// Which kind of doc this is, see [`super::kind`]. Absent on docs
    /// written before the marker existed, which are projects.
    pub const KIND: &str = "kind";
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

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown file kind {0:?}")]
pub struct UnknownFileKind(pub String);

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
    fn a_newer_schema_is_refused() {
        let doc = LoroDoc::new();
        assert_eq!(ensure_supported(&doc), Ok(()));
        let meta_map = doc.get_map(root::META);
        meta_map
            .insert(meta::SCHEMA, SCHEMA_VERSION as f64)
            .unwrap();
        assert_eq!(ensure_supported(&doc), Ok(()));
        meta_map.insert(meta::SCHEMA, 2.0).unwrap();
        let err = ensure_supported(&doc).unwrap_err();
        assert_eq!(
            err,
            Unsupported::TooNew(SchemaTooNew {
                found: 2,
                supported: SCHEMA_VERSION
            })
        );
        assert!(err.to_string().contains("upgrade typstry"), "{err}");
    }

    #[test]
    fn a_foreign_kind_is_refused() {
        let doc = LoroDoc::new();
        let meta_map = doc.get_map(root::META);
        meta_map.insert(meta::KIND, kind::PROJECT).unwrap();
        assert_eq!(ensure_supported(&doc), Ok(()));
        meta_map.insert(meta::KIND, kind::DIRECTORY).unwrap();
        let err = ensure_supported(&doc).unwrap_err();
        assert_eq!(
            err,
            Unsupported::ForeignKind(ForeignKind {
                found: "directory".to_owned()
            })
        );
        assert_eq!(err.to_string(), "this link does not open a project");
    }

    #[test]
    fn init_marks_the_doc_as_a_project() {
        let doc = LoroDoc::new();
        init::init_project(&doc, "T").unwrap();
        assert_eq!(doc_kind(&doc).as_deref(), Some(kind::PROJECT));
        let bare = LoroDoc::new();
        init::init_bare_project(&bare, "T").unwrap();
        assert_eq!(doc_kind(&bare).as_deref(), Some(kind::PROJECT));
    }

    #[test]
    fn migrate_leaves_a_current_doc_alone() {
        let doc = LoroDoc::new();
        assert!(!migrate(&doc).unwrap());
        assert_eq!(schema_version(&doc), None);

        init::init_project(&doc, "T").unwrap();
        let before = doc.oplog_vv();
        assert!(!migrate(&doc).unwrap());
        assert_eq!(doc.oplog_vv(), before);
        assert_eq!(schema_version(&doc), Some(SCHEMA_VERSION));
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

    #[test]
    fn reads_titles_like_the_browser() {
        let doc = LoroDoc::new();
        let meta_map = doc.get_map(root::META);
        for (stored, read) in [
            (" Thesis\u{feff}", Some("Thesis")),
            ("\u{feff}", None),
            ("\u{85}", Some("\u{85}")),
            ("", None),
        ] {
            meta_map.insert(meta::TITLE, stored).unwrap();
            assert_eq!(title(&doc).as_deref(), read, "{stored:?}");
        }
        meta_map
            .insert(meta::TITLE, "x".repeat(MAX_TITLE_CHARS + 1))
            .unwrap();
        assert_eq!(title(&doc), None);
    }
}
