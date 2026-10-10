//! Named versions, mirroring `apps/web/src/doc/versions.ts`. Each one is a
//! plain map appended to the root `versions` list; see [`crate::version`]
//! for its keys.

use std::collections::HashMap;
use std::fmt;

use loro::{Frontiers, LoroDoc, LoroError, LoroMapValue, LoroValue};

use crate::names::normalize_bounded;
use crate::{root, version};

pub const MAX_VERSION_NAME_CHARS: usize = 100;

/// A named version from the `versions` list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedVersion {
    /// Position in the list, counting malformed entries too, so it matches
    /// the index the browser shows. Stable because entries are never removed.
    pub index: usize,
    pub name: String,
    pub frontiers: Frontiers,
    pub created_at: i64,
    pub author: String,
}

/// Trimmed version name, or None when it is not 1 to
/// [`MAX_VERSION_NAME_CHARS`] characters long.
pub fn normalize_version_name(raw: &str) -> Option<&str> {
    normalize_bounded(raw, MAX_VERSION_NAME_CHARS)
}

#[derive(Debug)]
pub enum SaveVersionError {
    InvalidName,
    Loro(LoroError),
}

impl fmt::Display for SaveVersionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName => write!(
                f,
                "version name must be 1 to {MAX_VERSION_NAME_CHARS} characters"
            ),
            Self::Loro(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for SaveVersionError {}

impl From<LoroError> for SaveVersionError {
    fn from(err: LoroError) -> Self {
        Self::Loro(err)
    }
}

/// Names the current state of `doc`, writing the same entry `saveVersion`
/// in the browser writes.
pub fn save_version(
    doc: &LoroDoc,
    raw_name: &str,
    now_ms: i64,
) -> Result<NamedVersion, SaveVersionError> {
    let name = normalize_version_name(raw_name).ok_or(SaveVersionError::InvalidName)?;
    // Pending edits belong to the version being named.
    doc.commit();
    let frontiers = doc.oplog_frontiers();
    let author = doc.peer_id().to_string();
    let entry: HashMap<String, LoroValue> = [
        (version::NAME, LoroValue::from(name)),
        (version::FRONTIERS, LoroValue::from(frontiers.encode())),
        // The JS reader insists on a number, and JS numbers are doubles.
        (version::CREATED_AT, LoroValue::from(now_ms as f64)),
        (version::AUTHOR, LoroValue::from(author.as_str())),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let list = doc.get_list(root::VERSIONS);
    list.push(LoroValue::Map(LoroMapValue::from(entry)))?;
    doc.set_next_commit_message(&format!("save version {name}"));
    doc.commit();
    Ok(NamedVersion {
        index: list.len() - 1,
        name: name.to_owned(),
        frontiers,
        created_at: now_ms,
        author,
    })
}

/// Every well-formed entry of the `versions` list, oldest first. Entries
/// written by a broken client are skipped.
pub fn named_versions(doc: &LoroDoc) -> Vec<NamedVersion> {
    let LoroValue::List(list) = doc.get_list(root::VERSIONS).get_value() else {
        return Vec::new();
    };
    list.iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let LoroValue::Map(map) = entry else {
                return None;
            };
            let (
                Some(LoroValue::String(name)),
                Some(LoroValue::Binary(bytes)),
                Some(created),
                Some(LoroValue::String(author)),
            ) = (
                map.get(version::NAME),
                map.get(version::FRONTIERS),
                map.get(version::CREATED_AT),
                map.get(version::AUTHOR),
            )
            else {
                return None;
            };
            let created_at = match created {
                LoroValue::I64(v) => *v,
                LoroValue::Double(v) if v.is_finite() => *v as i64,
                _ => return None,
            };
            Some(NamedVersion {
                index,
                name: name.to_string(),
                frontiers: Frontiers::decode(bytes).ok()?,
                created_at,
                author: author.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::init_project;
    use crate::materialize::materialize_at;

    #[test]
    fn reads_named_versions() {
        let doc = LoroDoc::new();
        doc.set_peer_id(7).unwrap();
        init_project(&doc, "T").unwrap();
        let frontiers = doc.oplog_frontiers();
        let list = doc.get_list(root::VERSIONS);
        list.push("garbage").unwrap();
        let entry = LoroMapValue::from(
            [
                (version::NAME.to_owned(), LoroValue::from("Draft")),
                (
                    version::FRONTIERS.to_owned(),
                    LoroValue::from(frontiers.encode()),
                ),
                (version::CREATED_AT.to_owned(), LoroValue::from(1234.0)),
                (version::AUTHOR.to_owned(), LoroValue::from("7")),
            ]
            .into_iter()
            .collect::<HashMap<_, _>>(),
        );
        list.push(LoroValue::Map(entry)).unwrap();
        doc.commit();

        let versions = named_versions(&doc);
        assert_eq!(
            versions,
            [NamedVersion {
                index: 1,
                name: "Draft".into(),
                frontiers: frontiers.clone(),
                created_at: 1234,
                author: "7".into(),
            }]
        );
        let files = materialize_at(&doc, &versions[0].frontiers).unwrap();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn saves_versions_readable_by_named_versions() {
        let doc = LoroDoc::new();
        doc.set_peer_id(7).unwrap();
        init_project(&doc, "T").unwrap();
        let main = crate::paths::build_path_index(&doc).by_path["main.typ"];
        crate::text_content(&doc, main)
            .unwrap()
            .insert(0, "uncommitted ")
            .unwrap();

        let saved = save_version(&doc, "  Draft 1 ", 1_700_000_000_123).unwrap();
        assert_eq!(saved.name, "Draft 1");
        assert_eq!(saved.author, "7");
        assert_eq!(saved.index, 0);
        assert_eq!(named_versions(&doc), std::slice::from_ref(&saved));

        // The pending edit is part of the version, the entry itself is not.
        let old = doc.fork_at(&saved.frontiers).unwrap();
        assert!(old.get_list(root::VERSIONS).is_empty());
        let text = crate::text_content(&old, main).unwrap().to_string();
        assert!(text.starts_with("uncommitted "), "{text}");

        let entry = doc.get_list(root::VERSIONS).get_value();
        let LoroValue::List(list) = entry else {
            panic!("not a list");
        };
        let LoroValue::Map(map) = &list[0] else {
            panic!("not a map");
        };
        assert_eq!(
            map.get(version::CREATED_AT),
            Some(&LoroValue::Double(1_700_000_000_123.0))
        );
        let change = doc.get_change(doc.oplog_frontiers().as_single().unwrap());
        assert_eq!(
            change.unwrap().message.as_deref(),
            Some("save version Draft 1")
        );

        assert!(matches!(
            save_version(&doc, " ", 0),
            Err(SaveVersionError::InvalidName)
        ));
        assert!(save_version(&doc, &"v".repeat(101), 0).is_err());
        assert_eq!(named_versions(&doc).len(), 1);
    }
}
