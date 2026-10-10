//! Tests of the helper commands (init, link, open, info, version, export)
//! against an in-process server. Commands whose output matters run as the
//! real binary; everything else runs in-process like tests/cli.rs.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use clap::Parser;
use tempfile::TempDir;
use tokio::task::JoinHandle;
use typstry_cli::commands::{self, Cli};
use typstry_cli::engine::{Identity, set_peer_info};
use typstry_cli::link::ShareLink;
use typstry_cli::state::STATE_DIR;
use typstry_doc::init::starter_content;
use typstry_doc::paths::build_path_index;
use typstry_doc::versions::save_version;
use typstry_server::http::{AppState, router};
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::db;

/// Nothing listens here, so a command that tries the network fails.
const DEAD_SERVER: &str = "http://127.0.0.1:9";

struct Server {
    origin: String,
    task: JoinHandle<()>,
    _data: TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start() -> Self {
        let data = tempfile::tempdir().unwrap();
        let pool = db::open(&data.path().join("test.db")).await.unwrap();
        let state = AppState::new(pool, BlobStore::new(data.path()));
        let app = router(state, &data.path().join("no-dist"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            origin: format!("http://{addr}"),
            task,
            _data: data,
        }
    }

    async fn seeded_project(&self, title: &str) -> (String, String) {
        common::seeded_project(&self.origin, title).await
    }
}

/// A temp folder by its canonical path, so paths compare cleanly on macOS
/// where the temp dir sits behind a symlink.
fn temp() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    (dir, path)
}

async fn typstry(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    assert!(dir.is_absolute());
    let mut argv = vec!["typstry", "-C", dir.to_str().unwrap(), "--name", "Tester"];
    argv.extend(args);
    commands::run(Cli::try_parse_from(argv)?).await
}

/// Runs the real binary in `dir`, off the runtime thread so the
/// in-process server keeps serving it. Stdin is never a terminal.
async fn binary(dir: &Path, args: &[&str]) -> Output {
    assert!(dir.is_absolute());
    let dir = dir.to_path_buf();
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_typstry"))
            .arg("-C")
            .arg(&dir)
            .args(["--name", "Tester"])
            .args(&args)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .env_remove("TYPSTRY_SERVER")
            // Fails loudly instead of opening anything, should a test ever
            // reach the real opener.
            .env("TYPSTRY_BROWSER", "/nonexistent/typstry-test-browser")
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

fn stdout(out: &Output) -> String {
    assert!(
        out.status.success(),
        "failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout.clone()).unwrap()
}

fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).unwrap()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn has_git() -> bool {
    let ok = typstry_cli::git::available();
    if !ok {
        eprintln!("git is not installed, skipping");
    }
    ok
}

fn cached_doc(dir: &Path) -> loro::LoroDoc {
    let doc = loro::LoroDoc::new();
    doc.import(&fs::read(dir.join(STATE_DIR).join("doc.bin")).unwrap())
        .unwrap();
    doc
}

fn config(dir: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(dir.join(STATE_DIR).join("config.json")).unwrap())
        .unwrap()
}

/// Every file under `dir` but the state folder, by relative path.
fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            if rel == STATE_DIR || rel == ".git" {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.insert(rel.replace('\\', "/"), fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// The edit link `init` printed, read back from the folder's config.
fn edit_link(dir: &Path) -> String {
    let config = config(dir);
    ShareLink::new(
        config["server"].as_str().unwrap(),
        config["token"].as_str().unwrap(),
        config["key"].as_str().unwrap(),
    )
    .to_string()
}

fn png() -> Vec<u8> {
    [0x89, b'P', b'N', b'G', 0, 0xff]
        .into_iter()
        .chain((0..4000u32).map(|i| (i * 7 % 251) as u8))
        .collect()
}

#[tokio::test]
async fn init_uploads_a_folder_that_clones_back_identically() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let src = work.join("thesis");
    fs::create_dir_all(src.join("chapters")).unwrap();
    fs::write(src.join("main.typ"), "#include \"chapters/intro.typ\"\r\n").unwrap();
    fs::write(src.join("chapters/intro.typ"), "= Intro\n").unwrap();
    fs::write(src.join("refs.bib"), "@book{x, title={X}}\n").unwrap();
    fs::create_dir_all(src.join("fig")).unwrap();
    fs::write(src.join("fig/logo.png"), png()).unwrap();

    typstry(
        &work,
        &["init", "thesis", "--server", &server.origin, "--yes"],
    )
    .await
    .unwrap();
    let doc = cached_doc(&src);
    assert_eq!(typstry_doc::title(&doc).as_deref(), Some("thesis"));
    let config = config(&src);
    assert_eq!(config["permission"], "write");
    assert!(config["viewToken"].is_string());

    let (_out, out) = temp();
    typstry(&out, &["clone", &edit_link(&src), "copy"])
        .await
        .unwrap();
    let copy = out.join("copy");
    assert_eq!(tree(&copy), tree(&src));
    let cloned = cached_doc(&copy);
    let main = build_path_index(&cloned).by_path["main.typ"];
    assert_eq!(typstry_doc::main_file(&cloned), Some(main));

    // The folder is linked and in sync: nothing to push.
    typstry(&src, &["push"]).await.unwrap();
    assert_eq!(tree(&src), tree(&copy));
    // Once is enough.
    let err = typstry(
        &work,
        &["init", "thesis", "--server", &server.origin, "--yes"],
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("already linked"), "{err}");
}

#[tokio::test]
async fn init_seeds_an_empty_folder_with_the_starter() {
    let server = Server::start().await;
    let (_work, work) = temp();
    typstry(
        &work,
        &[
            "init",
            "fresh",
            "--title",
            "My Paper",
            "--server",
            &server.origin,
            "-y",
        ],
    )
    .await
    .unwrap();
    let dir = work.join("fresh");
    assert_eq!(
        fs::read_to_string(dir.join("main.typ")).unwrap(),
        starter_content("My Paper")
    );
    let (_out, out) = temp();
    typstry(&out, &["clone", &edit_link(&dir), "copy"])
        .await
        .unwrap();
    assert_eq!(tree(&out.join("copy")), tree(&dir));
    let doc = cached_doc(&out.join("copy"));
    assert_eq!(typstry_doc::title(&doc).as_deref(), Some("My Paper"));
    assert!(typstry_doc::main_file(&doc).is_some());
}

#[tokio::test]
async fn init_in_a_git_subfolder() {
    if !has_git() {
        return;
    }
    let server = Server::start().await;
    let (_work, work) = temp();
    let repo = work.join("repo");
    fs::create_dir_all(repo.join("paper/build")).unwrap();
    git(&repo, &["init", "--quiet"]);
    fs::write(repo.join(".gitignore"), "*.pdf\n").unwrap();
    fs::write(repo.join("code.rs"), "fn main() {}\n").unwrap();
    fs::write(repo.join("paper/.gitignore"), "build/\n").unwrap();
    fs::write(repo.join("paper/paper.typ"), "= Paper\n").unwrap();
    fs::write(repo.join("paper/paper.pdf"), "%PDF").unwrap();
    fs::write(repo.join("paper/build/tmp.typ"), "x").unwrap();
    fs::write(repo.join("paper/README.md"), "read me\n").unwrap();
    fs::write(repo.join("paper/.gitattributes"), "*.typ text\n").unwrap();
    fs::create_dir_all(repo.join("paper/.github/workflows")).unwrap();
    fs::write(repo.join("paper/.github/workflows/pdf.yml"), "on: push\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "--quiet", "-m", "init"]);
    let branch = git(&repo, &["symbolic-ref", "--short", "HEAD"])
        .trim()
        .to_owned();
    let paper = repo.join("paper");

    // A dry run shows the plan without any server at all.
    let out = binary(
        &repo,
        &["init", "paper", "--dry-run", "--server", DEAD_SERVER],
    )
    .await;
    let preview = stdout(&out);
    assert!(
        preview.contains("files:   2 (2 text, 0 asset(s))"),
        "{preview}"
    );
    // git's own files stay local, and the preview says so.
    for path in [".gitattributes", ".github", ".gitignore"] {
        assert!(
            preview.contains(&format!("  {path}: git file")),
            "{path}: {preview}"
        );
    }
    assert!(preview.contains("main:    paper.typ"), "{preview}");
    assert!(
        preview.contains(&format!("tracks branch {branch}")),
        "{preview}"
    );
    assert!(preview.contains("README.md"), "{preview}");
    assert!(!paper.join(STATE_DIR).exists());

    // Without a terminal and without --yes, init refuses rather than guess.
    fs::write(paper.join("paper.typ"), "= Paper, edited\n").unwrap();
    let out = binary(&paper, &["init", "--server", DEAD_SERVER]).await;
    assert!(!out.status.success());
    let err = stderr(&out);
    assert!(err.contains("--yes"), "{err}");
    assert!(err.contains("1 uncommitted change"), "{err}");
    assert!(!paper.join(STATE_DIR).exists());

    typstry(&paper, &["init", "--server", &server.origin, "--yes"])
        .await
        .unwrap();
    assert_eq!(config(&paper)["branch"], branch.as_str());
    let exclude = fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|l| l == ".typstry/"), "{exclude}");
    let status = git(&repo, &["status", "--porcelain"]);
    assert!(!status.contains(STATE_DIR), "{status}");

    let (_out, out) = temp();
    typstry(&out, &["clone", &edit_link(&paper), "copy"])
        .await
        .unwrap();
    let files: Vec<String> = tree(&out.join("copy")).into_keys().collect();
    assert_eq!(files, ["README.md", "paper.typ"]);
}

#[tokio::test]
async fn link_and_open_print_what_the_folder_knows() {
    let server = Server::start().await;
    let (edit, view) = server.seeded_project("Links").await;
    let (_work, work) = temp();
    typstry(&work, &["clone", &edit, "e"]).await.unwrap();
    typstry(&work, &["clone", &view, "v"]).await.unwrap();
    let e = work.join("e");
    let v = work.join("v");

    // Offline: the server is gone from here on.
    drop(server);
    let both = stdout(&binary(&e, &["link"]).await);
    assert_eq!(both, format!("Edit: {edit}\nView: {view}\n"));
    assert_eq!(
        stdout(&binary(&e, &["link", "--edit"]).await),
        format!("{edit}\n")
    );
    assert_eq!(
        stdout(&binary(&e, &["link", "--view"]).await),
        format!("{view}\n")
    );
    assert_eq!(
        stdout(&binary(&e, &["open", "--view", "--print"]).await),
        format!("{view}\n")
    );

    let out = binary(&v, &["link"]).await;
    assert_eq!(stdout(&out), format!("View: {view}\n"));
    assert!(stderr(&out).contains("view-only link"), "{}", stderr(&out));
    let out = binary(&v, &["link", "--edit"]).await;
    assert!(!out.status.success());
    let out = binary(&v, &["open"]).await;
    assert!(!out.status.success());
    assert!(stderr(&out).contains("edit link is not available"));
}

#[tokio::test]
async fn versions_are_saved_listed_and_exported() {
    let server = Server::start().await;
    let (edit, view) = server.seeded_project("Versions").await;
    let (_work, work) = temp();
    typstry(&work, &["clone", &edit, "a"]).await.unwrap();
    let a = work.join("a");
    let starter = starter_content("Versions");

    // Saving pushes the local edit first, so the version contains it.
    let v1 = format!("{starter}v1\n");
    fs::write(a.join("main.typ"), &v1).unwrap();
    fs::write(a.join("extra.typ"), "extra\n").unwrap();
    typstry(&a, &["version", "save", "  first draft "])
        .await
        .unwrap();
    fs::write(a.join("main.typ"), format!("{starter}v2\n")).unwrap();
    fs::remove_file(a.join("extra.typ")).unwrap();
    typstry(&a, &["push"]).await.unwrap();

    typstry(
        &a,
        &[
            "export",
            "--at",
            "first draft",
            &work.join("old").to_string_lossy(),
        ],
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(work.join("old/main.typ")).unwrap(), v1);
    assert_eq!(
        fs::read_to_string(work.join("old/extra.typ")).unwrap(),
        "extra\n"
    );
    assert!(!work.join("old").join(STATE_DIR).exists());
    typstry(&a, &["export", &work.join("now").to_string_lossy()])
        .await
        .unwrap();
    assert_eq!(tree(&work.join("now")), tree(&a));

    // Not into a folder with files, and not into the project itself.
    assert!(
        typstry(&a, &["export", &work.join("now").to_string_lossy()])
            .await
            .is_err()
    );
    let err = typstry(&a, &["export", &a.join("sub").to_string_lossy()])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("inside the project"), "{err}");

    // A browser saves a version under the same name, with its own author.
    let browser = tempfile::tempdir().unwrap();
    let mut session = common::seeder(&ShareLink::parse(&edit).unwrap(), browser.path()).await;
    set_peer_info(&session.doc, &Identity::new("Browser Ann")).unwrap();
    save_version(&session.doc, "first draft", 1_700_000_000_000).unwrap();
    session.push_local().await.unwrap();
    session.disconnect().await;

    let list = stdout(&binary(&a, &["version", "list"]).await);
    let lines: Vec<&str> = list.lines().collect();
    assert_eq!(lines.len(), 2, "{list}");
    // Newest first: ours was saved just now, the browser's in 2023.
    assert!(
        lines[0].starts_with("#0 ") && lines[0].contains("(Tester)"),
        "{list}"
    );
    assert!(
        lines[1].starts_with("#1 ")
            && lines[1].contains("2023-11-14 22:13 UTC  first draft  (Browser Ann)"),
        "{list}"
    );

    let err = typstry(
        &a,
        &[
            "export",
            "--at",
            "first draft",
            &work.join("x").to_string_lossy(),
        ],
    )
    .await
    .unwrap_err();
    assert!(
        err.to_string().contains("#0") && err.to_string().contains("#1"),
        "{err}"
    );
    typstry(
        &a,
        &["export", "--at", "#0", &work.join("x").to_string_lossy()],
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(work.join("x/main.typ")).unwrap(), v1);

    // A view clone can read versions but not save them.
    typstry(&work, &["clone", &view, "v"]).await.unwrap();
    let v = work.join("v");
    let err = typstry(&v, &["version", "save", "nope"]).await.unwrap_err();
    assert!(err.to_string().contains("view-only"), "{err}");
    typstry(&v, &["version", "list"]).await.unwrap();
}

#[tokio::test]
async fn info_works_offline() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Info").await;
    let (_work, work) = temp();
    typstry(&work, &["clone", &edit, "a"]).await.unwrap();
    let a = work.join("a");
    let online = stdout(&binary(&a, &["info"]).await);
    assert!(online.contains("Title:       Info"), "{online}");
    assert!(online.contains("Permission:  edit"), "{online}");
    assert!(online.contains("Main file:   main.typ"), "{online}");
    assert!(online.contains("Local:       up to date"), "{online}");

    drop(server);
    fs::write(a.join("new.typ"), "new\n").unwrap();
    let offline = stdout(&binary(&a, &["info", "--offline"]).await);
    assert!(offline.contains("Versions:    0 named"), "{offline}");
    assert!(
        offline.contains("Local:       1 change(s): 1 added, 0 modified, 0 deleted"),
        "{offline}"
    );
    assert!(!binary(&a, &["info"]).await.status.success());
}

/// Runs the real binary with `input` on stdin and extra environment.
async fn binary_with(dir: &Path, args: &[&str], input: &str, env: &[(&str, &str)]) -> Output {
    use std::io::Write;
    assert!(dir.is_absolute());
    let dir = dir.to_path_buf();
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    let input = input.to_owned();
    let env: Vec<(String, String)> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    tokio::task::spawn_blocking(move || {
        let mut child = Command::new(env!("CARGO_BIN_EXE_typstry"))
            .arg("-C")
            .arg(&dir)
            .args(["--name", "Tester"])
            .args(&args)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("TYPSTRY_LINK")
            .envs(env)
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn clone_reads_the_link_from_stdin_or_the_environment() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Hidden Link").await;
    let (_work, work) = temp();

    let out = binary_with(&work, &["clone", "-", "piped"], &format!("{edit}\n"), &[]).await;
    stdout(&out);
    assert_eq!(edit_link(&work.join("piped")), edit);

    let out = binary_with(&work, &["clone"], "", &[("TYPSTRY_LINK", &edit)]).await;
    stdout(&out);
    assert_eq!(edit_link(&work.join("Hidden-Link")), edit);

    let out = binary_with(&work, &["clone"], "", &[]).await;
    assert!(!out.status.success());
    assert!(stderr(&out).contains("TYPSTRY_LINK"), "{}", stderr(&out));
}
