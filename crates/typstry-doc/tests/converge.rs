//! Property test: three replicas apply random file-system and text edits
//! with random partial syncs in between. Once everything is exchanged they
//! must agree on every path and every materialized file, and applying those
//! files back must change nothing.

use loro::{LoroDoc, LoroText, TreeID};
use proptest::prelude::*;
use typstry_doc::apply::apply_files;
use typstry_doc::materialize::materialize;
use typstry_doc::paths::{PathIndex, build_path_index};
use typstry_doc::testing::{replica, sync};
use typstry_doc::{FileKind, node, root, text_content};

const PEERS: usize = 3;
// Few names so concurrent creates and renames clash often.
const NAMES: [&str; 5] = ["main.typ", "a.typ", "refs.bib", "img", ".hidden"];
const TEXTS: [&str; 4] = ["x", "hello ", "😀", "line\r\n"];

#[derive(Debug, Clone)]
enum Op {
    Create {
        peer: usize,
        parent: usize,
        name: usize,
        dir: bool,
    },
    Rename {
        peer: usize,
        node: usize,
        name: usize,
    },
    /// `parent` picks from every directory, including the node itself and
    /// its descendants, so cycle attempts are part of the mix.
    Move {
        peer: usize,
        node: usize,
        parent: usize,
    },
    Delete {
        peer: usize,
        node: usize,
    },
    Insert {
        peer: usize,
        node: usize,
        pos: usize,
        text: usize,
    },
    Remove {
        peer: usize,
        node: usize,
        pos: usize,
        len: usize,
    },
    Sync {
        a: usize,
        b: usize,
    },
}

fn op() -> impl Strategy<Value = Op> {
    let peer = 0..PEERS;
    let pick = 0..64usize;
    prop_oneof![
        4 => (peer.clone(), pick.clone(), 0..NAMES.len(), any::<bool>())
            .prop_map(|(peer, parent, name, dir)| Op::Create { peer, parent, name, dir }),
        2 => (peer.clone(), pick.clone(), 0..NAMES.len())
            .prop_map(|(peer, node, name)| Op::Rename { peer, node, name }),
        3 => (peer.clone(), pick.clone(), pick.clone())
            .prop_map(|(peer, node, parent)| Op::Move { peer, node, parent }),
        1 => (peer.clone(), pick.clone()).prop_map(|(peer, node)| Op::Delete { peer, node }),
        4 => (peer.clone(), pick.clone(), pick.clone(), 0..TEXTS.len())
            .prop_map(|(peer, node, pos, text)| Op::Insert { peer, node, pos, text }),
        2 => (peer.clone(), pick.clone(), pick.clone(), 1..8usize)
            .prop_map(|(peer, node, pos, len)| Op::Remove { peer, node, pos, len }),
        3 => (peer.clone(), peer).prop_map(|(a, b)| Op::Sync { a, b }),
    ]
}

fn nth<T: Copy>(items: &[T], i: usize) -> Option<T> {
    (!items.is_empty()).then(|| items[i % items.len()])
}

fn of_kind(index: &PathIndex, kind: FileKind) -> Vec<TreeID> {
    index
        .by_id
        .iter()
        .filter(|(_, e)| e.kind == kind)
        .map(|(id, _)| *id)
        .collect()
}

fn text_of(doc: &LoroDoc, id: TreeID) -> LoroText {
    text_content(doc, id).unwrap()
}

/// Applies one op. Ops that do not make sense for the replica's current
/// state (no such node, a move into its own subtree) are rejected by Loro
/// or skipped here, just like the UI would refuse them.
fn apply(docs: &[LoroDoc], op: &Op) {
    if let Op::Sync { a, b } = *op {
        if a != b {
            sync(&docs[a], &docs[b]);
        }
        return;
    }
    let peer = match *op {
        Op::Create { peer, .. }
        | Op::Rename { peer, .. }
        | Op::Move { peer, .. }
        | Op::Delete { peer, .. }
        | Op::Insert { peer, .. }
        | Op::Remove { peer, .. } => peer,
        Op::Sync { .. } => unreachable!(),
    };
    let doc = &docs[peer];
    let tree = doc.get_tree(root::FS);
    let index = build_path_index(doc);
    let all: Vec<TreeID> = index.by_id.keys().copied().collect();
    let dirs = of_kind(&index, FileKind::Dir);
    let texts = of_kind(&index, FileKind::Text);
    // Slot 0 is the root.
    let parent_at = |i: usize| (i % (dirs.len() + 1)).checked_sub(1).map(|d| dirs[d]);

    match *op {
        Op::Create {
            parent, name, dir, ..
        } => {
            let id = tree.create(parent_at(parent)).unwrap();
            let meta = tree.get_meta(id).unwrap();
            let kind = if dir { FileKind::Dir } else { FileKind::Text };
            meta.insert(node::KIND, kind.as_str()).unwrap();
            meta.insert(node::NAME, NAMES[name]).unwrap();
            if !dir {
                meta.insert_container(node::CONTENT, LoroText::new())
                    .unwrap();
            }
        }
        Op::Rename { node, name, .. } => {
            if let Some(id) = nth(&all, node) {
                tree.get_meta(id)
                    .unwrap()
                    .insert(node::NAME, NAMES[name])
                    .unwrap();
            }
        }
        Op::Move { node, parent, .. } => {
            if let Some(id) = nth(&all, node) {
                let _ = tree.mov(id, parent_at(parent));
            }
        }
        Op::Delete { node, .. } => {
            if let Some(id) = nth(&all, node) {
                tree.delete(id).unwrap();
            }
        }
        Op::Insert {
            node, pos, text, ..
        } => {
            if let Some(id) = nth(&texts, node) {
                let content = text_of(doc, id);
                let at = pos % (content.len_unicode() + 1);
                content.insert(at, TEXTS[text]).unwrap();
            }
        }
        Op::Remove { node, pos, len, .. } => {
            if let Some(id) = nth(&texts, node) {
                let content = text_of(doc, id);
                let total = content.len_unicode();
                if total > 0 {
                    let at = pos % total;
                    content.delete(at, len.min(total - at)).unwrap();
                }
            }
        }
        Op::Sync { .. } => unreachable!(),
    }
    doc.commit();
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

    #[test]
    fn replicas_converge_to_identical_files(ops in prop::collection::vec(op(), 1..80)) {
        // Peer ids on both sides of the u64 midpoint, like the clash test.
        let docs = [replica(7), replica(1 << 63 | 3), replica(10)];
        for op in &ops {
            apply(&docs, op);
        }
        for (a, b) in [(0, 1), (1, 2), (0, 2), (0, 1)] {
            sync(&docs[a], &docs[b]);
        }

        let index = build_path_index(&docs[0]);
        let files = materialize(&docs[0]);
        // Every live node got its own path.
        prop_assert_eq!(index.by_path.len(), index.by_id.len());
        prop_assert!(files.windows(2).all(|w| w[0].path < w[1].path));
        for doc in &docs[1..] {
            prop_assert_eq!(&build_path_index(doc), &index);
            prop_assert_eq!(&materialize(doc), &files);
        }

        // Pushing an untouched checkout must not write anything, whatever
        // clashes and empty folders the history left behind.
        let vv = docs[0].oplog_vv();
        let report = apply_files(&docs[0], &files, "test apply").unwrap();
        prop_assert!(!report.changed, "{:?}", report);
        prop_assert_eq!(docs[0].oplog_vv(), vv);
    }
}
