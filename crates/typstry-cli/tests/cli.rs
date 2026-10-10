//! End-to-end tests of the CLI against an in-process server, driving the
//! commands the way a user would and checking the folders and the doc.

mod common;

use common::{Server, cached_doc, git, has_git, typstry};

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use typstry_cli::api::Api;
use typstry_cli::client::{Client, Event};
use typstry_cli::engine::{Conflicts, Mode, Scope, Session};
use typstry_cli::link::{ShareLink, ws_url};
use typstry_cli::state::STATE_DIR;
use typstry_doc::apply::apply_files;
use typstry_doc::init::starter_content;
use typstry_doc::materialize::{FileContent, MaterializedFile, materialize};
use typstry_doc::paths::build_path_index;
use typstry_doc::{FileKind, node, root};
use typstry_wire::crypto::ProjectKey;
use typstry_wire::elo::encode_container;

async fn clone(link: &str, parent: &Path, name: &str) -> PathBuf {
    typstry(parent, &["clone", link, name]).await.unwrap();
    parent.join(name)
}

fn read(dir: &Path, path: &str) -> String {
    fs::read_to_string(dir.join(path)).unwrap()
}

#[tokio::test]
async fn clones_an_empty_project() {
    let server = Server::start().await;
    let (edit, _) = server.create_project().await;
    let work = tempfile::tempdir().unwrap();
    let dir = clone(&edit, work.path(), "empty").await;
    let entries: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(entries, [STATE_DIR]);
    typstry(&dir, &["status"]).await.unwrap();
    typstry(&dir, &["pull"]).await.unwrap();
}

#[tokio::test]
async fn clones_into_a_folder_named_after_the_title() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("My Thesis").await;
    let work = tempfile::tempdir().unwrap();
    typstry(work.path(), &["clone", &edit]).await.unwrap();
    let dir = work.path().join("My-Thesis");
    assert_eq!(read(&dir, "main.typ"), starter_content("My Thesis"));
    let config: serde_json::Value =
        serde_json::from_str(&read(&dir, ".typstry/config.json")).unwrap();
    assert_eq!(config["permission"], "write");
    assert!(config["viewToken"].is_string());
    // A second clone may not reuse the folder.
    assert!(typstry(work.path(), &["clone", &edit]).await.is_err());
}

#[tokio::test]
async fn concurrent_pushes_keep_both_edits() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Merge").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;

    let starter = starter_content("Merge");
    fs::write(a.join("main.typ"), format!("{starter}from a\n")).unwrap();
    fs::write(b.join("main.typ"), format!("from b\n{starter}")).unwrap();
    fs::write(b.join("notes.typ"), "b notes\n").unwrap();

    typstry(&a, &["push"]).await.unwrap();
    typstry(&b, &["push"]).await.unwrap();
    let merged = format!("from b\n{starter}from a\n");
    assert_eq!(read(&b, "main.typ"), merged);

    typstry(&a, &["pull"]).await.unwrap();
    assert_eq!(read(&a, "main.typ"), merged);
    assert_eq!(read(&a, "notes.typ"), "b notes\n");

    // Nothing left to do on either side, and the author got recorded.
    typstry(&a, &["push"]).await.unwrap();
    let doc = cached_doc(&a);
    let peers = doc.get_map(typstry_doc::root::PEERS).get_deep_value();
    assert!(format!("{peers:?}").contains("Tester"), "{peers:?}");
}

#[tokio::test]
async fn pull_refuses_to_overwrite_local_edits() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Conflict").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;

    let starter = starter_content("Conflict");
    fs::write(a.join("main.typ"), starter.replace("Hello", "Hi")).unwrap();
    fs::write(a.join("notes.typ"), "a notes\n").unwrap();
    typstry(&a, &["push"]).await.unwrap();
    let local = format!("{starter}local\n");
    fs::write(b.join("main.typ"), &local).unwrap();
    fs::write(b.join("extra.typ"), "untouched\n").unwrap();

    let err = typstry(&b, &["pull"]).await.unwrap_err();
    let conflicts = err.downcast_ref::<Conflicts>().expect("a conflict error");
    assert_eq!(conflicts.paths, ["main.typ"]);
    assert_eq!(read(&b, "main.typ"), local);
    // Everything that does not conflict still came in.
    assert_eq!(read(&b, "notes.typ"), "a notes\n");
    // A refused pull releases the folder like any other run.
    typstry(&b, &["status"]).await.unwrap();

    // Push merges instead, without applying the pulled file a second time.
    fs::write(b.join("notes.typ"), "a notes\nb notes\n").unwrap();
    typstry(&b, &["push"]).await.unwrap();
    assert_eq!(
        read(&b, "main.typ"),
        format!("{}local\n", starter.replace("Hello", "Hi"))
    );
    assert_eq!(read(&b, "notes.typ"), "a notes\nb notes\n");
    typstry(&a, &["pull"]).await.unwrap();
    assert_eq!(read(&a, "notes.typ"), "a notes\nb notes\n");
}

#[tokio::test]
async fn view_links_cannot_push() {
    let server = Server::start().await;
    let (_, view) = server.seeded_project("Read only").await;
    let work = tempfile::tempdir().unwrap();
    let dir = clone(&view, work.path(), "view").await;
    assert_eq!(read(&dir, "main.typ"), starter_content("Read only"));

    // Pulling and pushing nothing is fine.
    typstry(&dir, &["push"]).await.unwrap();
    fs::write(dir.join("main.typ"), "vandalism\n").unwrap();
    let err = typstry(&dir, &["push"]).await.unwrap_err();
    assert!(err.to_string().contains("view-only"), "{err}");
}

#[tokio::test]
async fn assets_round_trip() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Assets").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;

    let png: Vec<u8> = [0x89, b'P', b'N', b'G', 0, 0xff]
        .into_iter()
        .chain((0..5000u32).map(|i| (i % 251) as u8))
        .collect();
    fs::create_dir_all(a.join("fig")).unwrap();
    fs::write(a.join("fig/logo.png"), &png).unwrap();
    typstry(&a, &["push"]).await.unwrap();

    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(fs::read(b.join("fig/logo.png")).unwrap(), png);
    let files = materialize(&cached_doc(&b));
    let logo = files.iter().find(|f| f.path == "fig/logo.png").unwrap();
    let FileContent::Asset { size, mime, hash } = &logo.content else {
        panic!("expected an asset, got {:?}", logo.content);
    };
    assert_eq!(*size, png.len() as u64);
    assert_eq!(mime, "image/png");
    assert!(hash.starts_with("sha256:"));

    // Unchanged assets are not uploaded again; changed ones are.
    typstry(&b, &["push"]).await.unwrap();
    let mut changed = png.clone();
    changed.push(1);
    fs::write(b.join("fig/logo.png"), &changed).unwrap();
    typstry(&b, &["push"]).await.unwrap();
    typstry(&a, &["pull"]).await.unwrap();
    assert_eq!(fs::read(a.join("fig/logo.png")).unwrap(), changed);

    fs::remove_file(a.join("fig/logo.png")).unwrap();
    typstry(&a, &["push"]).await.unwrap();
    typstry(&b, &["pull"]).await.unwrap();
    assert!(!b.join("fig").exists());
}

#[tokio::test]
async fn renames_keep_the_node() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Rename").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let before = build_path_index(&cached_doc(&a)).by_path["main.typ"];

    fs::create_dir_all(a.join("src")).unwrap();
    fs::rename(a.join("main.typ"), a.join("src/thesis.typ")).unwrap();
    typstry(&a, &["push"]).await.unwrap();

    let b = clone(&edit, work.path(), "b").await;
    let index = build_path_index(&cached_doc(&b));
    assert_eq!(index.by_path.get("src/thesis.typ"), Some(&before));
    assert!(!index.by_path.contains_key("main.typ"));
    // The main file followed the node.
    assert_eq!(typstry_doc::main_file(&cached_doc(&b)), Some(before));
}

#[tokio::test]
async fn clone_with_git_makes_one_commit() {
    if !has_git() {
        return;
    }
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Git").await;
    let work = tempfile::tempdir().unwrap();
    typstry(work.path(), &["clone", &edit, "repo", "--git"])
        .await
        .unwrap();
    let repo = work.path().join("repo");
    let log = git(&repo, &["log", "--format=%s"]);
    assert_eq!(log.trim(), "import from typstry: Git");
    assert_eq!(git(&repo, &["ls-files"]).trim(), "main.typ");
    assert_eq!(git(&repo, &["status", "--porcelain"]).trim(), "");
    let branch = git(&repo, &["symbolic-ref", "--short", "HEAD"]);
    let config: serde_json::Value =
        serde_json::from_str(&read(&repo, ".typstry/config.json")).unwrap();
    assert_eq!(config["branch"], branch.trim());

    // No nested repositories.
    let err = typstry(&repo, &["clone", &edit, "nested", "--git"])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already inside"), "{err}");
    assert!(!repo.join("nested").exists());
}

#[tokio::test]
async fn sync_only_happens_on_the_tracked_branch() {
    if !has_git() {
        return;
    }
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Branches").await;
    let work = tempfile::tempdir().unwrap();
    typstry(work.path(), &["clone", &edit, "repo", "--git"])
        .await
        .unwrap();
    let repo = work.path().join("repo");
    let tracked = git(&repo, &["symbolic-ref", "--short", "HEAD"])
        .trim()
        .to_owned();

    git(&repo, &["switch", "--quiet", "-c", "draft"]);
    fs::write(repo.join("draft.typ"), "draft\n").unwrap();
    for cmd in ["push", "pull"] {
        let err = typstry(&repo, &[cmd]).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("on branch draft") && msg.contains(&tracked),
            "{msg}"
        );
    }
    typstry(&repo, &["push", "--force"]).await.unwrap();
    typstry(&repo, &["pull", "--force"]).await.unwrap();

    typstry(&repo, &["track", "draft"]).await.unwrap();
    typstry(&repo, &["push"]).await.unwrap();
    let err = {
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "--quiet", "-m", "draft"]);
        git(&repo, &["switch", "--quiet", &tracked]);
        typstry(&repo, &["pull"]).await.unwrap_err()
    };
    assert!(err.to_string().contains("typstry tracks draft"), "{err}");

    // A detached HEAD is never the tracked branch.
    git(&repo, &["switch", "--quiet", "--detach", "draft"]);
    assert!(typstry(&repo, &["push"]).await.is_err());
}

#[tokio::test]
async fn large_files_survive_fragmentation() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Large").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;

    // The text travels as an update well above the 240 KiB fragment size,
    // the asset as a blob of several megabytes.
    let text: String = (0..20_000u64)
        .map(|i| format!("line {i} {}\n", i * 7919 % 10007))
        .collect();
    let blob: Vec<u8> = (0..3_000_000u64).map(|i| (i * 31 % 251) as u8).collect();
    fs::write(a.join("data.txt"), &text).unwrap();
    fs::write(a.join("data.bin"), &blob).unwrap();
    typstry(&a, &["push"]).await.unwrap();

    let b = clone(&edit, work.path(), "b").await;
    assert_eq!(read(&b, "data.txt"), text);
    assert_eq!(fs::read(b.join("data.bin")).unwrap(), blob);
}

#[tokio::test]
async fn writers_compact_the_server_log() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Compact").await;
    let link = ShareLink::parse(&edit).unwrap();
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut session = Session::create(work.path(), &link, &share, None).unwrap();
    session.connect().await.unwrap();
    let text = session.doc.get_text("scratch");
    for i in 0..210 {
        text.insert(0, &i.to_string()).unwrap();
        session.doc.commit();
        session.push_local().await.unwrap();
    }
    session.disconnect().await;

    let records = typstry_server::store::docs::record_count(&server.state.db, &share.project_id)
        .await
        .unwrap();
    assert!(records < 20, "{records} records left after compaction");
    let other = tempfile::tempdir().unwrap();
    let b = clone(&edit, other.path(), "b").await;
    let doc = cached_doc(&b);
    assert_eq!(doc.get_text("scratch").to_string(), text.to_string());
}

/// Whether the folder's file system treats names that differ only in case
/// as the same file, like the macOS and Windows defaults.
fn case_insensitive(dir: &Path) -> bool {
    let probe = dir.join("case-probe");
    fs::write(&probe, "").unwrap();
    let insensitive = dir.join("CASE-PROBE").exists();
    fs::remove_file(probe).unwrap();
    insensitive
}

/// What `dir`'s cached doc holds, by path.
fn doc_files(dir: &Path) -> std::collections::BTreeMap<String, FileContent> {
    materialize(&cached_doc(dir))
        .into_iter()
        .map(|f| (f.path, f.content))
        .collect()
}

fn text(content: Option<&FileContent>) -> Option<&str> {
    match content {
        Some(FileContent::Text(text)) => Some(text),
        _ => None,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_write_after_pushing_does_not_duplicate_the_edit() {
    use std::os::unix::fs::PermissionsExt;
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Retry").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    let starter = starter_content("Retry");
    fs::create_dir_all(b.join("box")).unwrap();
    fs::write(b.join("box/new.typ"), "new\n").unwrap();
    fs::write(b.join("main.typ"), format!("from b\n{starter}")).unwrap();
    typstry(&b, &["push"]).await.unwrap();

    // The push goes out, then writing the co-author's file fails, before
    // main.typ gets its turn.
    fs::create_dir_all(a.join("box")).unwrap();
    fs::set_permissions(a.join("box"), fs::Permissions::from_mode(0o555)).unwrap();
    fs::write(a.join("main.typ"), format!("{starter}from a\n")).unwrap();
    let failed = typstry(&a, &["push"]).await;
    fs::set_permissions(a.join("box"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err());

    typstry(&a, &["push"]).await.unwrap();
    let merged = format!("from b\n{starter}from a\n");
    assert_eq!(read(&a, "main.typ"), merged);
    assert_eq!(read(&a, "box/new.typ"), "new\n");
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "main.typ"), merged);
}

#[tokio::test]
async fn a_remote_file_never_replaces_an_unsynced_local_one() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Unsynced").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fs::write(a.join(".typstryignore"), "README.md\n").unwrap();
    fs::write(a.join("README.md"), "my notes\n").unwrap();
    fs::write(b.join("README.md"), "theirs\n").unwrap();
    typstry(&b, &["push"]).await.unwrap();

    typstry(&a, &["pull"]).await.unwrap();
    assert_eq!(read(&a, "README.md"), "my notes\n");
    typstry(&a, &["push"]).await.unwrap();
    assert_eq!(read(&a, "README.md"), "my notes\n");
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "README.md"), "theirs\n");
}

#[tokio::test]
async fn git_files_in_the_project_are_neither_written_nor_deleted() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Git files").await;
    let link = ShareLink::parse(&edit).unwrap();
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    // Uploaded in the browser, or pushed by an older CLI.
    let seed = tempfile::tempdir().unwrap();
    let mut browser = Session::create(seed.path(), &link, &share, Some("Browser")).unwrap();
    browser.connect().await.unwrap();
    let set = |extra: &[(&str, &str)], doc: &loro::LoroDoc| {
        let mut files: Vec<MaterializedFile> = materialize(doc)
            .into_iter()
            .filter(|f| !extra.iter().any(|(p, _)| *p == f.path))
            .collect();
        files.extend(extra.iter().map(|(path, text)| MaterializedFile {
            path: (*path).to_owned(),
            content: FileContent::Text((*text).to_owned()),
        }));
        apply_files(doc, &files, "test apply").unwrap();
    };
    set(
        &[
            (".gitignore", "*.pdf\n"),
            (".github/workflows/pdf.yml", "on: push\n"),
        ],
        &browser.doc,
    );
    browser.push_local().await.unwrap();

    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    assert!(!a.join(".gitignore").exists());
    assert!(!a.join(".github").exists());

    // The folder's own .gitignore is not the project's, and pushing does
    // not delete the project's.
    fs::write(a.join(".gitignore"), "local\n").unwrap();
    fs::write(a.join("main.typ"), "= Edited\n").unwrap();
    typstry(&a, &["push"]).await.unwrap();
    let files = doc_files(&a);
    assert_eq!(text(files.get("main.typ")), Some("= Edited\n"));
    assert_eq!(text(files.get(".gitignore")), Some("*.pdf\n"));
    assert_eq!(
        text(files.get(".github/workflows/pdf.yml")),
        Some("on: push\n")
    );
    assert_eq!(read(&a, ".gitignore"), "local\n");

    // A remote edit does not overwrite it either.
    set(&[(".gitignore", "*.pdf\nbuild/\n")], &browser.doc);
    browser.push_local().await.unwrap();
    browser.disconnect().await;
    typstry(&a, &["pull"]).await.unwrap();
    typstry(&a, &["push"]).await.unwrap();
    assert_eq!(read(&a, ".gitignore"), "local\n");
    assert_eq!(
        text(doc_files(&a).get(".gitignore")),
        Some("*.pdf\nbuild/\n")
    );

    // Nor does removing the local one remove the project's.
    fs::remove_file(a.join(".gitignore")).unwrap();
    typstry(&a, &["push"]).await.unwrap();
    assert!(!a.join(".gitignore").exists());
    assert_eq!(
        text(doc_files(&a).get(".gitignore")),
        Some("*.pdf\nbuild/\n")
    );
}

/// Writes a node straight into the doc, the way a modified client could,
/// without the name rules `apply_files` enforces.
fn plant(
    doc: &loro::LoroDoc,
    parent: Option<loro::TreeID>,
    name: &str,
    body: Option<&str>,
) -> loro::TreeID {
    let tree = doc.get_tree(root::FS);
    let id = tree.create(parent).unwrap();
    let meta = tree.get_meta(id).unwrap();
    let kind = if body.is_some() {
        FileKind::Text
    } else {
        FileKind::Dir
    };
    meta.insert(node::KIND, kind.as_str()).unwrap();
    meta.insert(node::NAME, name).unwrap();
    if let Some(body) = body {
        let content = meta
            .insert_container(node::CONTENT, loro::LoroText::new())
            .unwrap();
        content.insert(0, body).unwrap();
    }
    doc.commit();
    id
}

#[tokio::test]
async fn a_shared_git_dir_in_another_spelling_is_never_written() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Planted").await;
    let link = ShareLink::parse(&edit).unwrap();
    let seed = tempfile::tempdir().unwrap();
    let mut attacker = common::seeder(&link, seed.path()).await;
    // On macOS and Windows `.GIT` is `.git`, so this would be the clone's
    // git config, and git runs `core.fsmonitor` on the next `git add`.
    let config = "[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch pwned\n";
    for top in [".GIT", "GIT~1", ".git."] {
        let dir = plant(&attacker.doc, None, top, None);
        plant(&attacker.doc, Some(dir), "config", Some(config));
        plant(
            &attacker.doc,
            Some(dir),
            "HEAD",
            Some("ref: refs/heads/main\n"),
        );
    }
    let sub = plant(&attacker.doc, None, "sub", None);
    let nested = plant(&attacker.doc, Some(sub), ".Git", None);
    plant(&attacker.doc, Some(nested), "config", Some(config));
    plant(&attacker.doc, None, "C:", None);
    plant(&attacker.doc, None, "nul.typ", Some("x"));
    attacker.push_local().await.unwrap();
    attacker.disconnect().await;

    let work = tempfile::tempdir().unwrap();
    let mut args = vec!["clone", edit.as_str(), "repo"];
    if has_git() {
        args.push("--git");
    }
    typstry(work.path(), &args).await.unwrap();
    let repo = work.path().join("repo");

    let mut names: Vec<String> = fs::read_dir(&repo)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    let mut expected = vec![STATE_DIR, "main.typ"];
    if has_git() {
        expected.insert(0, ".git");
    }
    assert_eq!(names, expected);
    assert!(!work.path().join("pwned").exists());
    assert!(!repo.join("pwned").exists());
    if has_git() {
        let config = read(&repo, ".git/config");
        assert!(!config.contains("pwned"), "{config}");
    }
}

#[tokio::test]
async fn a_remote_file_never_replaces_a_case_variant() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Case").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fs::write(a.join("Notes.typ"), "mine\n").unwrap();
    fs::write(b.join("notes.typ"), "theirs\n").unwrap();
    typstry(&b, &["push"]).await.unwrap();

    typstry(&a, &["pull"]).await.unwrap();
    let names: Vec<String> = fs::read_dir(&a)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.eq_ignore_ascii_case("notes.typ"))
        .collect();
    if case_insensitive(&a) {
        assert_eq!(names, ["Notes.typ"]);
        assert_eq!(read(&a, "Notes.typ"), "mine\n");
    } else {
        assert_eq!(read(&a, "Notes.typ"), "mine\n");
        assert_eq!(read(&a, "notes.typ"), "theirs\n");
    }
}

#[tokio::test]
async fn case_variants_from_another_file_system_are_kept() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Variants").await;
    let link = ShareLink::parse(&edit).unwrap();
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    // A co-author on a case-sensitive file system has both files.
    let seed = tempfile::tempdir().unwrap();
    let mut other = Session::create(seed.path(), &link, &share, Some("Linux")).unwrap();
    other.connect().await.unwrap();
    let with = |extra: &[(&str, &str)], doc: &loro::LoroDoc| {
        let mut files: Vec<MaterializedFile> = materialize(doc)
            .into_iter()
            .filter(|f| !extra.iter().any(|(p, _)| *p == f.path))
            .collect();
        files.extend(extra.iter().map(|(path, text)| MaterializedFile {
            path: (*path).to_owned(),
            content: FileContent::Text((*text).to_owned()),
        }));
        apply_files(doc, &files, "test apply").unwrap();
    };
    with(
        &[("Notes.typ", "upper\n"), ("notes.typ", "lower\n")],
        &other.doc,
    );
    other.push_local().await.unwrap();

    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    with(&[("notes.typ", "lower, edited\n")], &other.doc);
    other.push_local().await.unwrap();
    other.disconnect().await;

    // The way sync looks at remote changes: only the paths they touch.
    let mut session = Session::open(&a, Some("Tester")).unwrap();
    session.connect().await.unwrap();
    session
        .reconcile(&Scope::Paths(BTreeSet::new()), Mode::Push)
        .await
        .unwrap();
    session.disconnect().await;
    drop(session);
    typstry(&a, &["push"]).await.unwrap();

    let files = doc_files(&a);
    assert_eq!(text(files.get("Notes.typ")), Some("upper\n"));
    assert_eq!(text(files.get("notes.typ")), Some("lower, edited\n"));
    if !case_insensitive(&a) {
        assert_eq!(read(&a, "Notes.typ"), "upper\n");
        assert_eq!(read(&a, "notes.typ"), "lower, edited\n");
    }
}

#[tokio::test]
async fn an_edit_saved_while_pushing_is_not_overwritten() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Race").await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    let starter = starter_content("Race");
    fs::write(b.join("main.typ"), format!("{starter}from b\n")).unwrap();
    typstry(&b, &["push"]).await.unwrap();

    fs::write(a.join("main.typ"), format!("from a\n{starter}")).unwrap();
    let late = format!("from a\nlate\n{starter}");
    let mut session = Session::open(&a, Some("Tester")).unwrap();
    let main = a.join("main.typ");
    let saved = late.clone();
    // The editor saves again while the push waits for the server.
    session.before_write = Some(Box::new(move |_| fs::write(&main, &saved).unwrap()));
    session.connect().await.unwrap();
    let report = session.reconcile(&Scope::Full, Mode::Push).await.unwrap();
    session.disconnect().await;
    drop(session);
    assert_eq!(read(&a, "main.typ"), late);
    assert!(
        report.warnings.iter().any(|w| w.contains("main.typ")),
        "{:?}",
        report.warnings
    );

    // The next push merges the late edit instead of reverting b's.
    typstry(&a, &["push"]).await.unwrap();
    let merged = format!("from a\nlate\n{starter}from b\n");
    assert_eq!(read(&a, "main.typ"), merged);
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "main.typ"), merged);
}

#[tokio::test]
async fn push_after_a_branch_round_trip_needs_force() {
    if !has_git() {
        return;
    }
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Round trip").await;
    let work = tempfile::tempdir().unwrap();
    typstry(work.path(), &["clone", &edit, "repo", "--git"])
        .await
        .unwrap();
    let repo = work.path().join("repo");
    let b = clone(&edit, work.path(), "b").await;
    let starter = starter_content("Round trip");
    let theirs = format!("{starter}co-author\n");
    fs::write(b.join("main.typ"), &theirs).unwrap();
    typstry(&b, &["push"]).await.unwrap();
    typstry(&repo, &["pull"]).await.unwrap();

    // The pulled edit is committed on a draft only, so coming back drops it.
    git(&repo, &["switch", "--quiet", "-c", "draft"]);
    git(&repo, &["commit", "--quiet", "-am", "draft"]);
    git(&repo, &["switch", "--quiet", "-"]);
    assert_eq!(read(&repo, "main.typ"), starter);

    let err = typstry(&repo, &["push"]).await.unwrap_err();
    assert!(err.to_string().contains("--force"), "{err}");
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "main.typ"), theirs);

    typstry(&repo, &["push", "--force"]).await.unwrap();
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "main.typ"), starter);
}

/// Stores one delta record under a key other than the link's, as a client
/// with a wrong or tampered key would.
async fn inject_foreign_record(link: &str) {
    let link = ShareLink::parse(link).unwrap();
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    let key = ProjectKey::from_base64url(&ProjectKey::generate_raw()).unwrap();
    let doc = loro::LoroDoc::new();
    doc.set_peer_id(4242).unwrap();
    doc.get_text("foreign").insert(0, "x").unwrap();
    doc.commit();
    let end = *doc.oplog_vv().get(&4242).unwrap();
    let plaintext = doc
        .export(loro::ExportMode::updates_in_range(vec![loro::IdSpan::new(
            4242, 0, end,
        )]))
        .unwrap();
    let record = key.encrypt_delta(4242, 0, end as u64, &plaintext).unwrap();
    let mut client = Client::connect(&ws_url(&link.origin).unwrap(), &share.project_id)
        .await
        .unwrap();
    client
        .join(&link.token, &loro::VersionVector::new())
        .await
        .unwrap();
    client
        .send_update(&encode_container(&[&record]))
        .await
        .unwrap();
    loop {
        if let Event::Ack { status, .. } = client.next_event().await.unwrap() {
            assert_eq!(status, loro_protocol::UpdateStatusCode::Ok);
            break;
        }
    }
    client.close().await;
}

#[tokio::test]
async fn records_under_another_key_are_skipped() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Foreign").await;
    inject_foreign_record(&edit).await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    assert_eq!(read(&a, "main.typ"), starter_content("Foreign"));
    fs::write(a.join("notes.typ"), "notes\n").unwrap();
    typstry(&a, &["push"]).await.unwrap();

    // A project made entirely of such records means the link's key is wrong.
    let (empty, _) = server.create_project().await;
    inject_foreign_record(&empty).await;
    let err = typstry(work.path(), &["clone", &empty, "wrong"])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("key"), "{err}");
}

#[tokio::test]
async fn a_refused_compaction_is_not_fatal() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Huge").await;
    let link = ShareLink::parse(&edit).unwrap();
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut session = Session::create(work.path(), &link, &share, None).unwrap();
    session.connect().await.unwrap();
    // More than the server reassembles, so it refuses the snapshot.
    let text = session.doc.get_text("scratch");
    let mut state = 0x2545_f491_u32;
    for _ in 0..10 {
        let chunk: String = (0..900_000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                char::from(b'a' + (state % 26) as u8)
            })
            .collect();
        text.insert(0, &chunk).unwrap();
        session.doc.commit();
        session.push_local().await.unwrap();
    }
    for i in 0..200 {
        text.insert(0, &i.to_string()).unwrap();
        session.doc.commit();
        session.push_local().await.unwrap();
    }
    session.disconnect().await;
}
