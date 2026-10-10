//! Makes the `fs` tree match a flat list of files, the write-side
//! counterpart of [`materialize`](crate::materialize::materialize). This is
//! how a local folder gets pushed into the doc. It works like
//! `restoreVersion` in `apps/web/src/doc/restore.ts`, except that the target
//! is a list of paths rather than another doc, so nodes are matched by path
//! instead of by TreeID.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;

use loro::{LoroDoc, LoroResult, LoroText, LoroTree, LoroValue, TreeID, TreeParentId};

use crate::materialize::{
    FileContent, MaterializedFile, file_content, is_safe_path, materialize_indexed, number,
};
use crate::names::{NameError, validate_path};
use crate::paths::{LiveNode, PathIndex, build_path_index, read_node, resolve_sibling_names};
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
///
/// This works out the difference to the current files and hands it to
/// [`apply_changes`]; when the caller already knows what changed, calling
/// that directly saves reading every file.
pub fn apply_files(
    doc: &LoroDoc,
    files: &[MaterializedFile],
    message: &str,
) -> LoroResult<ApplyReport> {
    // Keep unrelated pending edits out of the push commit.
    doc.commit();
    let mut report = ApplyReport::default();
    let desired = validate(files, &mut report.skipped);
    let index = build_path_index(doc);
    let visible = materialize_indexed(doc, &index);
    let visible: HashMap<&str, &FileContent> = visible
        .iter()
        .map(|(_, file)| (file.path.as_str(), &file.content))
        .collect();
    let deletes = visible
        .keys()
        .copied()
        .filter(|path| !desired.contains_key(path))
        .collect();
    let puts = desired
        .into_iter()
        .filter(|(path, content)| visible.get(path) != Some(content))
        .collect();
    apply_valid(doc, &index, puts, deletes, report, message)
}

/// Writes `changes` on top of the doc's files: `Some` creates or replaces
/// the file at that path, `None` deletes it. Paths that are not mentioned
/// stay as they are.
///
/// For the paths it names this behaves like [`apply_files`] given the
/// current files with `changes` laid over them: the same validation, rename
/// pairing between the deleted and the new files, folder handling, clash
/// paths and single commit. Leaving everything else alone makes for two
/// differences. A visible file whose name breaks the name rules survives,
/// where `apply_files` would drop it. And when a new file takes the place
/// of a folder, the files inside are reported as deleted only, not also as
/// skipped. Deleting a path that holds no visible file, such as a folder,
/// does nothing.
///
/// Only the named paths, and the folders around them, are read, so the
/// cost grows with the size of the change rather than of the project,
/// apart from indexing the paths once.
pub fn apply_changes(
    doc: &LoroDoc,
    changes: &BTreeMap<String, Option<FileContent>>,
    message: &str,
) -> LoroResult<ApplyReport> {
    doc.commit();
    let mut report = ApplyReport::default();
    let index = build_path_index(doc);
    let current = Current { doc, index: &index };
    let mut puts = BTreeMap::new();
    let mut deletes = BTreeSet::new();
    for (path, content) in changes {
        let Some(content) = content else {
            deletes.insert(path.as_str());
            continue;
        };
        match validate_path(path) {
            Ok(()) => {
                puts.insert(path.as_str(), content);
            }
            Err(invalid) => report.skipped.push(Skipped {
                path: path.clone(),
                reason: SkipReason::InvalidName {
                    segment: invalid.segment.to_owned(),
                    error: invalid.error,
                },
            }),
        }
    }
    // A file the change leaves alone still blocks a folder at its path, the
    // same as a file in the full list would.
    let nested = nested_in_files(&puts, |path| {
        puts.contains_key(path) || (!changes.contains_key(path) && current.shows(path))
    });
    for (path, file) in nested {
        puts.remove(path);
        report.skipped.push(Skipped {
            path: path.to_owned(),
            reason: SkipReason::InsideFile {
                file: file.to_owned(),
            },
        });
    }
    apply_valid(doc, &index, puts, deletes, report, message)
}

/// The part both entry points share. `puts` holds valid paths with no other
/// put above them, `deletes` may name anything. `index` must be fresh.
fn apply_valid<'a>(
    doc: &LoroDoc,
    index: &'a PathIndex,
    puts: BTreeMap<&'a str, &'a FileContent>,
    deletes: BTreeSet<&'a str>,
    mut report: ApplyReport,
    message: &str,
) -> LoroResult<ApplyReport> {
    let tree = doc.get_tree(root::FS);
    let current = Current { doc, index };
    let main_before = main_file(doc);
    let desired_dirs: BTreeSet<&str> = puts.keys().flat_map(|p| ancestors(p)).collect();

    // Visible files that go away, unless a rename keeps them.
    let mut removed: BTreeMap<&str, (TreeID, FileContent)> = BTreeMap::new();
    for &path in &deletes {
        if let Some(file) = current.file(path) {
            removed.insert(path, file);
        }
    }
    let mut doomed: Vec<(usize, TreeID)> = Vec::new();
    let mut reused: Vec<(&str, TreeID)> = Vec::new();
    let mut before: HashMap<&str, FileContent> = HashMap::new();
    for (&path, &content) in &puts {
        let Some((id, kind)) = current.node(path) else {
            continue;
        };
        if kind == FileKind::Dir {
            // The folder goes, and with it everything inside.
            doomed.push((depth(path), id));
            for inner in current.files_under(path) {
                if let Some(file) = current.file(inner) {
                    removed.insert(inner, file);
                }
            }
        } else if kind == content_kind(content) {
            reused.push((path, id));
        } else {
            doomed.push((depth(path), id));
        }
        if let Some((_, content)) = current.file(path) {
            before.insert(path, content);
        }
    }
    let mut dirs: HashMap<&str, TreeID> = HashMap::new();
    for &dir in &desired_dirs {
        match current.node(dir) {
            Some((id, FileKind::Dir)) => {
                dirs.insert(dir, id);
            }
            Some((id, _)) => {
                doomed.push((depth(dir), id));
                if current.shows(dir) {
                    report.deleted.push(dir.to_owned());
                }
                removed.remove(dir);
            }
            None => {}
        }
    }
    // A folder goes with its last visible file. Folders that were empty to
    // begin with never get here.
    let emptied: BTreeSet<&str> = removed
        .keys()
        .flat_map(|path| ancestors(path))
        .filter(|dir| !desired_dirs.contains(dir))
        .collect();
    for dir in emptied {
        if let Some((id, FileKind::Dir)) = current.node(dir)
            && current
                .files_under(dir)
                .all(|path| removed.contains_key(path))
        {
            doomed.push((depth(dir), id));
        }
    }

    let taken: HashSet<&str> = reused.iter().map(|(p, _)| *p).collect();
    let added: Vec<&str> = puts
        .keys()
        .copied()
        .filter(|p| !taken.contains(p))
        .collect();
    // A path that only changes kind is an edit in place, not a rename target.
    let fresh: Vec<&str> = added
        .iter()
        .copied()
        .filter(|p| !before.contains_key(p))
        .collect();
    let gone: Vec<(&str, TreeID, &FileContent)> = removed
        .iter()
        .map(|(&path, (id, content))| (path, *id, content))
        .collect();
    let renames = pair_renames(&gone, &fresh, &puts);

    let parent_of = |dirs: &HashMap<&str, TreeID>, path: &str| -> TreeParentId {
        match path.rsplit_once('/') {
            Some((parent, _)) => TreeParentId::Node(dirs[parent]),
            None => TreeParentId::Root,
        }
    };
    let mut names = Names::default();

    // BTreeSet order puts every directory after its parent.
    for &dir in &desired_dirs {
        if !dirs.contains_key(dir) {
            let parent = parent_of(&dirs, dir);
            let id = tree.create(parent)?;
            let data = tree.get_meta(id)?;
            data.insert(node::KIND, FileKind::Dir.as_str())?;
            data.insert(node::NAME, basename(dir))?;
            names.joined(parent, id, basename(dir));
            dirs.insert(dir, id);
        }
    }

    let mut renamed_away: HashSet<TreeID> = HashSet::new();
    for &(from, to, id) in &renames {
        names.left(&tree, id);
        // Targets are directories that stay or were just created, never one
        // about to be deleted, which would take the moved file with it.
        let parent = parent_of(&dirs, to);
        if tree.parent(id) != Some(parent) {
            tree.mov(id, parent)?;
        }
        set_name(doc, id, basename(to))?;
        names.joined(parent, id, basename(to));
        renamed_away.insert(id);
        report.renamed.push(Renamed {
            from: from.to_owned(),
            to: to.to_owned(),
        });
    }
    let renamed_to: HashSet<&str> = renames.iter().map(|&(_, to, _)| to).collect();

    for &(path, id) in &reused {
        let content = puts[path];
        let before = before.get(path);
        if before != Some(content) {
            write_content(doc, id, content)?;
            if before.is_some() {
                report.modified.push(path.to_owned());
            } else {
                report.created.push(path.to_owned());
            }
        }
    }

    for &path in &added {
        if renamed_to.contains(path) {
            continue;
        }
        let content = puts[path];
        let parent = parent_of(&dirs, path);
        let id = tree.create(parent)?;
        let data = tree.get_meta(id)?;
        data.insert(node::KIND, content_kind(content).as_str())?;
        data.insert(node::NAME, basename(path))?;
        if let FileContent::Text(_) = content {
            data.insert_container(node::CONTENT, LoroText::new())?;
        }
        write_content(doc, id, content)?;
        names.joined(parent, id, basename(path));
        // A file that only changed kind is still the same file to the user.
        if before.contains_key(path) {
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
    // Parents first, so their subtrees are already gone when we get there
    // and do not cost an op each.
    doomed.sort();
    for (_, id) in doomed {
        if !tree.is_node_deleted(&id)? {
            names.left(&tree, id);
            tree.delete(id)?;
        }
    }
    if let Some(main) = main_before
        && tree.is_node_deleted(&main)?
    {
        doc.get_map(root::META)
            .insert(meta::MAIN_FILE, LoroValue::Null)?;
    }
    names.pin(doc, index)?;

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

/// Read access to the doc's files by path, through an index built once.
#[derive(Clone, Copy)]
struct Current<'a> {
    doc: &'a LoroDoc,
    index: &'a PathIndex,
}

impl<'a> Current<'a> {
    /// The node at `path`, unless `materialize` hides everything there.
    fn node(self, path: &str) -> Option<(TreeID, FileKind)> {
        if !is_safe_path(path) {
            return None;
        }
        let id = *self.index.by_path.get(path)?;
        Some((id, self.index.by_id.get(&id)?.kind))
    }

    /// The file `materialize` lists at `path`.
    fn file(self, path: &str) -> Option<(TreeID, FileContent)> {
        let (id, kind) = self.node(path)?;
        Some((id, file_content(self.doc, id, kind)?))
    }

    /// Whether `materialize` lists a file at `path`, without reading text.
    fn shows(self, path: &str) -> bool {
        match self.node(path) {
            Some((_, FileKind::Text)) => true,
            Some((id, kind @ FileKind::Asset)) => file_content(self.doc, id, kind).is_some(),
            _ => false,
        }
    }

    /// Paths of the visible files anywhere below `dir`.
    fn files_under(self, dir: &str) -> impl Iterator<Item = &'a str> {
        let prefix = format!("{dir}/");
        self.index
            .by_path
            .range(prefix.clone()..)
            .take_while(move |(path, _)| path.starts_with(&prefix))
            .map(|(path, _)| path.as_str())
            .filter(move |path| self.shows(path))
    }
}

/// Sibling groups whose members came or went. A node that lost a same-name
/// clash shows a derived name; when the winner leaves, or a new node joins
/// the group, the shown names can shift. Pinning the names the caller saw
/// keeps every path stable, including those of files nobody touched.
#[derive(Default)]
struct Names<'a> {
    touched: HashMap<TreeParentId, HashSet<String>>,
    /// Names for nodes this apply placed. Everything else keeps the name
    /// the index showed before.
    wanted: HashMap<TreeID, &'a str>,
}

impl<'a> Names<'a> {
    fn joined(&mut self, parent: TreeParentId, id: TreeID, name: &'a str) {
        self.touched
            .entry(parent)
            .or_default()
            .insert(name.to_owned());
        self.wanted.insert(id, name);
    }

    /// Call before moving or deleting the node.
    fn left(&mut self, tree: &LoroTree, id: TreeID) {
        if let (Some(parent), Some(node)) = (tree.parent(id), read_node(tree, id)) {
            self.touched.entry(parent).or_default().insert(node.name);
        }
    }

    fn pin(self, doc: &LoroDoc, before: &PathIndex) -> LoroResult<()> {
        let tree = doc.get_tree(root::FS);
        let mut pins = Vec::new();
        for (parent, names) in &self.touched {
            if let TreeParentId::Node(dir) = parent
                && tree.is_node_deleted(dir)?
            {
                continue;
            }
            let group: Vec<LiveNode> = tree
                .children(*parent)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|id| read_node(&tree, id))
                .filter(|node| names.contains(&node.name))
                .collect();
            for (node, shown, _) in resolve_sibling_names(group) {
                let wanted = self
                    .wanted
                    .get(&node.id)
                    .copied()
                    .or_else(|| before.by_id.get(&node.id).map(|e| basename(&e.path)));
                if let Some(wanted) = wanted
                    && shown != wanted
                {
                    pins.push((node.id, wanted));
                }
            }
        }
        for (id, name) in pins {
            set_name(doc, id, name)?;
        }
        Ok(())
    }
}

/// The valid, unique entries of `files` by path. Everything else goes into
/// `skipped`.
fn validate<'a>(
    files: &'a [MaterializedFile],
    skipped: &mut Vec<Skipped>,
) -> BTreeMap<&'a str, &'a FileContent> {
    let mut desired = BTreeMap::new();
    for file in files {
        let reason = if let Err(invalid) = validate_path(&file.path) {
            SkipReason::InvalidName {
                segment: invalid.segment.to_owned(),
                error: invalid.error,
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
    let nested = nested_in_files(&desired, |path| desired.contains_key(path));
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

/// Paths in `desired` below a path `is_file` accepts, each with the
/// outermost such file.
fn nested_in_files<'a, V>(
    desired: &BTreeMap<&'a str, V>,
    is_file: impl Fn(&str) -> bool,
) -> Vec<(&'a str, &'a str)> {
    desired
        .keys()
        .filter_map(|path| {
            ancestors(path)
                .find(|a| is_file(a))
                .map(|file| (*path, file))
        })
        .collect()
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
