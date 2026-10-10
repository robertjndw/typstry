//! Makes the `fs` tree match a flat list of files, the write-side
//! counterpart of [`materialize`](crate::materialize::materialize). This is
//! how a local folder gets pushed into the doc. It works like
//! `restoreVersion` in `apps/web/src/doc/restore.ts`, except that the target
//! is a list of paths rather than another doc, so nodes are matched by path
//! instead of by TreeID.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;

use loro::{LoroDoc, LoroResult, LoroText, LoroValue, TreeID, TreeParentId};

use crate::materialize::{
    FileContent, MaterializedFile, is_safe_path, materialize_indexed, number,
};
use crate::names::{NameError, validate_name};
use crate::paths::build_path_index;
use crate::{FileKind, main_file, meta, node, root, string_value, text_content};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// Files that did not exist (or were not visible to `materialize`).
    pub created: Vec<String>,
    /// Files whose content changed, including ones that switched between
    /// text and asset.
    pub modified: Vec<String>,
    /// Files that are gone. Directories are not listed.
    pub deleted: Vec<String>,
    /// Files that moved and kept their node, so history follows them.
    pub renamed: Vec<Renamed>,
    /// Input entries that were ignored.
    pub skipped: Vec<Skipped>,
    /// Whether anything was written (and committed).
    pub changed: bool,
}

impl ApplyReport {
    /// How many files changed, renames included.
    pub fn len(&self) -> usize {
        self.created.len() + self.modified.len() + self.deleted.len() + self.renamed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Adds the outcome of another apply, e.g. to a fork of another state.
    pub fn extend(&mut self, other: Self) {
        self.created.extend(other.created);
        self.modified.extend(other.modified);
        self.deleted.extend(other.deleted);
        self.renamed.extend(other.renamed);
        self.skipped.extend(other.skipped);
        self.changed |= other.changed;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Renamed {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    /// A path segment breaks the name rules.
    InvalidName { segment: String, error: NameError },
    /// The same path appeared earlier in the input; the first one wins.
    Duplicate,
    /// Another input file sits at one of this path's parent directories.
    InsideFile { file: String },
}

impl fmt::Display for SkipReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName { segment, error } => write!(f, "{segment:?}: {error}"),
            Self::Duplicate => f.write_str("duplicate path"),
            Self::InsideFile { file } => write!(f, "{file:?} is a file"),
        }
    }
}

/// Makes the doc's files equal `files`, which is the complete desired set:
/// every visible file not in it is deleted. Directories are implied by the
/// paths. Afterwards `materialize(doc)` returns exactly the valid entries of
/// `files`, sorted by path.
///
/// - Existing paths resolve through [`build_path_index`], so a clash path
///   like `main~3@42.typ` updates the node shown under that name. Nodes that
///   stay keep their TreeID; text changes go through `LoroText::update`, so
///   they merge with concurrent edits like typing would.
/// - A file that disappeared and one that appeared with identical content
///   are treated as a rename when that content is unique among both, which
///   keeps the node and its history.
/// - A file that changes between text and asset is deleted and recreated.
/// - A directory is deleted when it had visible files and none are left.
///   Directories that were empty to begin with are left alone, since a
///   folder on disk cannot tell them apart from not existing.
/// - Nodes `materialize` hides (assets without a hash, unsafe names) are
///   left alone unless a new file needs their path.
/// - `meta.mainFile` is cleared when its node is deleted.
///
/// Everything lands in one commit with `message`, and
/// nothing is written when the doc already matches. Entries with invalid
/// paths are skipped and reported instead of failing the whole push.
pub fn apply_files(
    doc: &LoroDoc,
    files: &[MaterializedFile],
    message: &str,
) -> LoroResult<ApplyReport> {
    // Keep unrelated pending edits out of the push commit.
    doc.commit();
    let mut report = ApplyReport::default();
    let desired = validate(files, &mut report.skipped);
    let desired_dirs: BTreeSet<&str> = desired.keys().flat_map(|p| ancestors(p)).collect();

    let tree = doc.get_tree(root::FS);
    let index = build_path_index(doc);
    let visible: BTreeMap<String, (TreeID, FileContent)> = materialize_indexed(doc, &index)
        .into_iter()
        .map(|(id, file)| (file.path, (id, file.content)))
        .collect();
    let main_before = main_file(doc);

    let mut dirs: HashMap<&str, TreeID> = HashMap::new();
    let mut reused: Vec<(&str, TreeID)> = Vec::new();
    let mut doomed: Vec<(usize, TreeID)> = Vec::new();
    let mut gone: Vec<(&str, TreeID, &FileContent)> = Vec::new();
    for (path, &id) in &index.by_path {
        // Unsafe paths are invisible to materialize and can never be asked
        // for, so they and their subtrees are someone else's problem.
        if !is_safe_path(path) {
            continue;
        }
        let kind = index.by_id[&id].kind;
        let wanted = desired.get(path.as_str()).copied();
        let as_dir = desired_dirs.contains(path.as_str());
        let keep = match kind {
            FileKind::Dir if as_dir => {
                dirs.insert(path, id);
                true
            }
            FileKind::Dir => wanted.is_none() && !has_visible_descendant(&visible, path),
            _ if wanted.is_some_and(|c| content_kind(c) == kind) => {
                reused.push((path, id));
                true
            }
            _ if wanted.is_some() || as_dir => false,
            _ => match visible.get(path) {
                Some((_, content)) => {
                    gone.push((path, id, content));
                    true
                }
                None => true,
            },
        };
        if !keep {
            doomed.push((depth(path), id));
        }
    }
    let taken: HashSet<&str> = reused.iter().map(|(p, _)| *p).collect();
    let added: Vec<&str> = desired
        .keys()
        .copied()
        .filter(|p| !taken.contains(p))
        .collect();
    // A path that only changes kind is an edit in place, not a rename target.
    let fresh: Vec<&str> = added
        .iter()
        .copied()
        .filter(|p| !visible.contains_key(*p))
        .collect();
    let renames = pair_renames(&gone, &fresh, &desired);

    let parent_of = |dirs: &HashMap<&str, TreeID>, path: &str| -> TreeParentId {
        match path.rsplit_once('/') {
            Some((parent, _)) => TreeParentId::Node(dirs[parent]),
            None => TreeParentId::Root,
        }
    };

    // BTreeSet order puts every directory after its parent.
    for &dir in &desired_dirs {
        if !dirs.contains_key(dir) {
            let id = tree.create(parent_of(&dirs, dir))?;
            let data = tree.get_meta(id)?;
            data.insert(node::KIND, FileKind::Dir.as_str())?;
            data.insert(node::NAME, basename(dir))?;
            dirs.insert(dir, id);
        }
    }

    let mut placed: Vec<(&str, TreeID)> = Vec::with_capacity(desired.len());
    let mut renamed_away: HashSet<TreeID> = HashSet::new();
    for &(from, to, id) in &renames {
        // Targets are directories that stay or were just created, never one
        // about to be deleted, which would take the moved file with it.
        let parent = parent_of(&dirs, to);
        if tree.parent(id) != Some(parent) {
            tree.mov(id, parent)?;
        }
        set_name(doc, id, basename(to))?;
        renamed_away.insert(id);
        placed.push((to, id));
        report.renamed.push(Renamed {
            from: from.to_owned(),
            to: to.to_owned(),
        });
    }
    let renamed_to: HashSet<&str> = renames.iter().map(|&(_, to, _)| to).collect();

    for &(path, id) in &reused {
        let content = desired[path];
        let before = visible.get(path).map(|(_, c)| c);
        if before != Some(content) {
            write_content(doc, id, content)?;
            if before.is_some() {
                report.modified.push(path.to_owned());
            } else {
                report.created.push(path.to_owned());
            }
        }
        placed.push((path, id));
    }

    for &path in &added {
        if renamed_to.contains(path) {
            continue;
        }
        let content = desired[path];
        let id = tree.create(parent_of(&dirs, path))?;
        let data = tree.get_meta(id)?;
        data.insert(node::KIND, content_kind(content).as_str())?;
        data.insert(node::NAME, basename(path))?;
        if let FileContent::Text(_) = content {
            data.insert_container(node::CONTENT, LoroText::new())?;
        }
        write_content(doc, id, content)?;
        placed.push((path, id));
        // A file that only changed kind is still the same file to the user.
        if visible.contains_key(path) {
            report.modified.push(path.to_owned());
        } else {
            report.created.push(path.to_owned());
        }
    }

    for &(path, id, _) in &gone {
        if !renamed_away.contains(&id) {
            doomed.push((depth(path), id));
            report.deleted.push(path.to_owned());
        }
    }
    for path in visible.keys() {
        if desired_dirs.contains(path.as_str()) {
            report.deleted.push(path.clone());
        }
    }
    // Parents first, so their subtrees are already gone when we get there
    // and do not cost an op each.
    doomed.sort();
    for (_, id) in doomed {
        if !tree.is_node_deleted(&id)? {
            tree.delete(id)?;
        }
    }
    if let Some(main) = main_before
        && tree.is_node_deleted(&main)?
    {
        doc.get_map(root::META)
            .insert(meta::MAIN_FILE, LoroValue::Null)?;
    }

    // A node that lost a same-name clash shows a derived name. Once the
    // winner is gone it would fall back to its stored name, so pin the name
    // the caller asked for. Skipped when nothing changed: then every path
    // is still what the index said.
    if doc.get_pending_txn_len() > 0 {
        let after = build_path_index(doc);
        for &(path, id) in &placed {
            if after.by_id.get(&id).map(|e| e.path.as_str()) != Some(path) {
                set_name(doc, id, basename(path))?;
            }
        }
    }

    report.created.sort();
    report.modified.sort();
    report.deleted.sort();
    if doc.get_pending_txn_len() > 0 {
        doc.set_next_commit_message(message);
        doc.commit();
        report.changed = true;
    }
    Ok(report)
}

/// The valid, unique entries of `files` by path. Everything else goes into
/// `skipped`.
fn validate<'a>(
    files: &'a [MaterializedFile],
    skipped: &mut Vec<Skipped>,
) -> BTreeMap<&'a str, &'a FileContent> {
    let mut desired = BTreeMap::new();
    for file in files {
        let invalid = file
            .path
            .split('/')
            .find_map(|segment| validate_name(segment).err().map(|e| (segment, e)));
        let reason = if let Some((segment, error)) = invalid {
            SkipReason::InvalidName {
                segment: segment.to_owned(),
                error,
            }
        } else if desired.contains_key(file.path.as_str()) {
            SkipReason::Duplicate
        } else {
            desired.insert(file.path.as_str(), &file.content);
            continue;
        };
        skipped.push(Skipped {
            path: file.path.clone(),
            reason,
        });
    }
    let nested: Vec<(&str, &str)> = desired
        .keys()
        .filter_map(|path| {
            ancestors(path)
                .find(|a| desired.contains_key(a))
                .map(|file| (*path, file))
        })
        .collect();
    for (path, file) in nested {
        desired.remove(path);
        skipped.push(Skipped {
            path: path.to_owned(),
            reason: SkipReason::InsideFile {
                file: file.to_owned(),
            },
        });
    }
    desired
}

/// Pairs each vanished file with the new file holding the same content,
/// when that content occurs exactly once on both sides. Anything less
/// certain stays a delete plus a create.
fn pair_renames<'a>(
    gone: &[(&'a str, TreeID, &FileContent)],
    added: &[&'a str],
    desired: &BTreeMap<&str, &FileContent>,
) -> Vec<(&'a str, &'a str, TreeID)> {
    #[derive(Default)]
    struct Candidates<'a> {
        from: Vec<(&'a str, TreeID)>,
        to: Vec<&'a str>,
    }
    let mut by_content: HashMap<&FileContent, Candidates<'a>> = HashMap::new();
    for &(path, id, content) in gone {
        by_content.entry(content).or_default().from.push((path, id));
    }
    for &path in added {
        if let Some(entry) = by_content.get_mut(desired[path]) {
            entry.to.push(path);
        }
    }
    let mut renames: Vec<_> = by_content
        .into_values()
        .filter_map(|c| match (c.from.as_slice(), c.to.as_slice()) {
            ([(from, id)], [to]) => Some((*from, *to, *id)),
            _ => None,
        })
        .collect();
    renames.sort();
    renames
}

fn write_content(doc: &LoroDoc, id: TreeID, content: &FileContent) -> LoroResult<()> {
    let data = doc.get_tree(root::FS).get_meta(id)?;
    match content {
        FileContent::Text(want) => {
            let text = match text_content(doc, id) {
                Some(text) => text,
                None => data.insert_container(node::CONTENT, LoroText::new())?,
            };
            if text.to_string() != *want {
                text.update(want, Default::default())
                    .expect("no timeout was set");
            }
        }
        FileContent::Asset { hash, size, mime } => {
            if string_value(data.get(node::HASH)).as_ref() != Some(hash) {
                data.insert(node::HASH, hash.as_str())?;
            }
            if number(data.get(node::SIZE)) != Some(*size) {
                // The browser writes JS numbers, so match its value type.
                data.insert(node::SIZE, *size as f64)?;
            }
            if string_value(data.get(node::MIME)).as_ref() != Some(mime) {
                data.insert(node::MIME, mime.as_str())?;
            }
        }
    }
    Ok(())
}

fn set_name(doc: &LoroDoc, id: TreeID, name: &str) -> LoroResult<()> {
    let data = doc.get_tree(root::FS).get_meta(id)?;
    if string_value(data.get(node::NAME)).as_deref() != Some(name) {
        data.insert(node::NAME, name)?;
    }
    Ok(())
}

fn content_kind(content: &FileContent) -> FileKind {
    match content {
        FileContent::Text(_) => FileKind::Text,
        FileContent::Asset { .. } => FileKind::Asset,
    }
}

fn has_visible_descendant<V>(visible: &BTreeMap<String, V>, dir: &str) -> bool {
    let prefix = format!("{dir}/");
    visible
        .range(prefix.clone()..)
        .next()
        .is_some_and(|(path, _)| path.starts_with(&prefix))
}

/// Proper ancestor directories of `path`, nearest last.
fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(move |(i, _)| &path[..i])
}

fn basename(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

fn depth(path: &str) -> usize {
    path.matches('/').count()
}
