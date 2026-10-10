//! Path derivation for the `fs` tree.
//!
//! Must produce byte-identical results to `apps/web/src/doc/paths.ts`;
//! `tests/fixture.rs` checks both against a snapshot written by the TS side.

use std::collections::{BTreeMap, HashMap};

use loro::{LoroDoc, LoroTree, TreeID, TreeParentId};

use crate::{FileKind, node, root, string_value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathEntry {
    pub path: String,
    pub kind: FileKind,
    /// True when the node lost a same-name clash and shows a derived name.
    pub renamed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PathIndex {
    pub by_path: BTreeMap<String, TreeID>,
    pub by_id: BTreeMap<TreeID, PathEntry>,
}

/// Name shown for a node that lost a same-name clash: `main.typ` with id
/// `3@42` becomes `main~3@42.typ`. A leading dot does not start an
/// extension, so `.gitignore` becomes `.gitignore~3@42`.
pub fn disambiguated_name(name: &str, id: TreeID) -> String {
    let split = match name.rfind('.') {
        Some(dot) if dot > 0 => dot,
        _ => name.len(),
    };
    let (stem, ext) = name.split_at(split);
    format!("{stem}~{}@{}{ext}", id.counter, id.peer)
}

pub(crate) struct LiveNode {
    pub(crate) id: TreeID,
    pub(crate) name: String,
    pub(crate) kind: FileKind,
}

pub(crate) fn read_node(tree: &LoroTree, id: TreeID) -> Option<LiveNode> {
    let meta = tree.get_meta(id).ok()?;
    let name = string_value(meta.get(node::NAME)).filter(|n| !n.is_empty())?;
    let kind = string_value(meta.get(node::KIND))?.parse().ok()?;
    Some(LiveNode { id, name, kind })
}

/// Derives every live node's path.
///
/// Nodes whose metadata has no valid name or kind are skipped together with
/// their subtree; our own ops never produce them, so they can only come from
/// a broken or foreign client.
pub fn build_path_index(doc: &LoroDoc) -> PathIndex {
    let tree = doc.get_tree(root::FS);
    let mut children: HashMap<Option<TreeID>, Vec<LiveNode>> = HashMap::new();
    for n in tree.get_nodes(false) {
        let parent = match n.parent {
            TreeParentId::Node(p) => Some(p),
            TreeParentId::Root => None,
            TreeParentId::Deleted | TreeParentId::Unexist => continue,
        };
        if let Some(live) = read_node(&tree, n.id) {
            children.entry(parent).or_default().push(live);
        }
    }

    let mut index = PathIndex::default();
    let mut stack: Vec<(Option<TreeID>, String)> = vec![(None, String::new())];
    while let Some((parent, prefix)) = stack.pop() {
        let Some(siblings) = children.remove(&parent) else {
            continue;
        };
        for (live, name, renamed) in resolve_sibling_names(siblings) {
            let path = format!("{prefix}{name}");
            index.by_path.insert(path.clone(), live.id);
            if live.kind == FileKind::Dir {
                stack.push((Some(live.id), format!("{path}/")));
            }
            index.by_id.insert(
                live.id,
                PathEntry {
                    path,
                    kind: live.kind,
                    renamed,
                },
            );
        }
    }
    index
}

pub(crate) fn resolve_sibling_names(siblings: Vec<LiveNode>) -> Vec<(LiveNode, String, bool)> {
    let mut groups: BTreeMap<String, Vec<LiveNode>> = BTreeMap::new();
    for live in siblings {
        groups.entry(live.name.clone()).or_default().push(live);
    }
    let mut out = Vec::new();
    for mut group in groups.into_values() {
        // TreeID's derived Ord compares peer (u64) first, then counter.
        group.sort_by_key(|live| live.id);
        for (i, live) in group.into_iter().enumerate() {
            // A derived name could in theory equal a real sibling's name
            // (someone literally named a file "main~3@42.typ"). That is
            // vanishingly rare and left unresolved; only one of the two ends
            // up in by_path.
            if i == 0 {
                let name = live.name.clone();
                out.push((live, name, false));
            } else {
                let name = disambiguated_name(&live.name, live.id);
                out.push((live, name, true));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{add, replica, sync};

    fn id(counter: i32, peer: u64) -> TreeID {
        TreeID { peer, counter }
    }

    #[test]
    fn disambiguates_names() {
        assert_eq!(disambiguated_name("main.typ", id(3, 42)), "main~3@42.typ");
        assert_eq!(
            disambiguated_name(".gitignore", id(3, 42)),
            ".gitignore~3@42"
        );
        assert_eq!(
            disambiguated_name("archive.tar.gz", id(0, 7)),
            "archive.tar~0@7.gz"
        );
        assert_eq!(disambiguated_name("Makefile", id(1, 2)), "Makefile~1@2");
        assert_eq!(
            disambiguated_name("a.typ", id(0, u64::MAX - 1)),
            format!("a~0@{}.typ", u64::MAX - 1)
        );
    }

    #[test]
    fn tree_id_display_matches_js_format() {
        assert_eq!(id(3, 42).to_string(), "3@42");
    }

    #[test]
    fn builds_nested_paths_and_skips_deleted() {
        let doc = replica(1);
        let dir = add(&doc, None, "chapters", FileKind::Dir);
        let intro = add(&doc, Some(dir), "intro.typ", FileKind::Text);
        let gone = add(&doc, Some(dir), "old.typ", FileKind::Text);
        doc.get_tree(root::FS).delete(gone).unwrap();
        doc.commit();

        let index = build_path_index(&doc);
        let paths: Vec<_> = index
            .by_path
            .iter()
            .map(|(p, id)| (p.as_str(), *id))
            .collect();
        assert_eq!(paths, [("chapters", dir), ("chapters/intro.typ", intro)]);
        assert!(!index.by_id.contains_key(&gone));
    }

    #[test]
    fn concurrent_same_name_keeps_lowest_tree_id() {
        // 9 < 10 numerically but "10" < "9" as text.
        let a = replica(10);
        let b = replica(9);
        let c = replica(1 << 63 | 5);
        let fa = add(&a, None, "main.typ", FileKind::Text);
        let fb = add(&b, None, "main.typ", FileKind::Text);
        let fc = add(&c, None, "main.typ", FileKind::Text);
        sync(&a, &b);
        sync(&a, &c);
        sync(&a, &b);

        let index = build_path_index(&a);
        assert_eq!(index, build_path_index(&b));
        assert_eq!(index, build_path_index(&c));
        assert_eq!(
            index.by_id[&fb],
            PathEntry {
                path: "main.typ".into(),
                kind: FileKind::Text,
                renamed: false
            }
        );
        assert_eq!(index.by_id[&fa].path, "main~0@10.typ");
        assert!(index.by_id[&fa].renamed);
        assert_eq!(
            index.by_id[&fc].path,
            format!("main~0@{}.typ", 1u64 << 63 | 5)
        );
    }

    #[test]
    fn skips_nodes_with_invalid_metadata_and_their_subtree() {
        let doc = replica(1);
        let tree = doc.get_tree(root::FS);
        let bare = tree.create(None).unwrap();
        let child = add(&doc, Some(bare), "x.typ", FileKind::Text);
        let index = build_path_index(&doc);
        assert!(index.by_id.is_empty());
        assert!(!index.by_id.contains_key(&child));
    }
}
