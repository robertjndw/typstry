//! Named versions, mirroring `apps/web/src/doc/versions.ts`. Each one is a
//! plain map appended to the root `versions` list; see [`crate::version`]
//! for its keys.

use std::cmp::Ordering;
use std::collections::HashMap;

use loro::{
    ContainerID, ContainerType, Frontiers, ID, LoroDoc, LoroError, LoroMapValue, LoroValue,
};

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

#[derive(Debug, thiserror::Error)]
pub enum SaveVersionError {
    #[error("version name must be 1 to {MAX_VERSION_NAME_CHARS} characters")]
    InvalidName,
    #[error(transparent)]
    Loro(#[from] LoroError),
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

/// Every well-formed entry of the `versions` list that is not deleted,
/// oldest first. Entries written by a broken client are skipped.
pub fn named_versions(doc: &LoroDoc) -> Vec<NamedVersion> {
    let handler = doc.get_list(root::VERSIONS);
    let LoroValue::List(list) = handler.get_value() else {
        return Vec::new();
    };
    let deleted = doc.get_map(root::DELETED_VERSIONS);
    list.iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let id = handler.get_id_at(index)?;
            if deleted.get(&entry_key(id)).is_some() {
                return None;
            }
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

/// The named version (a tag in the browser) for the state at `frontiers`,
/// or the current state if `None`. Saving a version is itself a change, so
/// a version still matches as long as only bookkeeping happened between it
/// and `frontiers`. A state only ever gets one name. Mirrors `tagAt` in
/// apps/web/src/doc/history.ts.
pub fn tag_at(doc: &LoroDoc, frontiers: Option<&Frontiers>) -> Option<NamedVersion> {
    // get_changed_containers_in commits implicitly anyway; doing it first
    // keeps the current frontiers and the ranges below consistent.
    doc.commit();
    let target = frontiers.cloned().unwrap_or_else(|| doc.oplog_frontiers());
    let target_vv = doc.frontiers_to_vv(&target)?;
    // Newest first: the most recent version is the likeliest match.
    named_versions(doc).into_iter().rev().find(|version| {
        let earlier = matches!(
            doc.cmp_frontiers(&version.frontiers, &target),
            Ok(Some(Ordering::Less | Ordering::Equal))
        );
        let Some(version_vv) = doc.frontiers_to_vv(&version.frontiers) else {
            return false;
        };
        earlier
            && target_vv.iter().all(|(peer, &end)| {
                let start = version_vv.get(peer).copied().unwrap_or(0);
                start >= end
                    || doc
                        .get_changed_containers_in(ID::new(*peer, start), (end - start) as usize)
                        .iter()
                        .all(is_bookkeeping)
            })
    })
}

/// Root containers whose changes are bookkeeping rather than edits; must
/// match `META_CONTAINERS` in apps/web/src/doc/history.ts.
fn is_bookkeeping(id: &ContainerID) -> bool {
    let ContainerID::Root {
        name,
        container_type,
    } = id
    else {
        return false;
    };
    matches!(
        (name.as_str(), container_type),
        (root::PEERS, ContainerType::Map)
            | (root::VERSIONS, ContainerType::List)
            | (root::DELETED_VERSIONS, ContainerType::Map)
    )
}

/// How `deletedVersions` refers to a list entry; must match `entryId` in
/// apps/web/src/doc/versions.ts.
fn entry_key(id: ID) -> String {
    format!("{}@{}", id.counter, id.peer)
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

    #[test]
    fn tag_at_ignores_bookkeeping_but_not_edits() {
        let doc = LoroDoc::new();
        doc.set_peer_id(7).unwrap();
        init_project(&doc, "T").unwrap();
        assert_eq!(tag_at(&doc, None), None);

        let saved = save_version(&doc, "Tagged", 1).unwrap();
        assert_eq!(tag_at(&doc, None).as_ref(), Some(&saved));
        // Peer info is bookkeeping too.
        crate::peers::set_peer(&doc, "Me", "#000000").unwrap();
        assert_eq!(tag_at(&doc, None).as_ref(), Some(&saved));

        let tagged = doc.oplog_frontiers();
        let main = crate::paths::build_path_index(&doc).by_path["main.typ"];
        crate::text_content(&doc, main)
            .unwrap()
            .insert(0, "edit ")
            .unwrap();
        doc.commit();
        assert_eq!(tag_at(&doc, None), None);
        assert_eq!(tag_at(&doc, Some(&tagged)).as_ref(), Some(&saved));

        let id = doc.get_list(root::VERSIONS).get_id_at(saved.index).unwrap();
        doc.get_map(root::DELETED_VERSIONS)
            .insert(&entry_key(id), 2.0)
            .unwrap();
        doc.commit();
        assert_eq!(tag_at(&doc, Some(&tagged)), None);
    }
}
