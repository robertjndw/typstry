//! Project setup shared by the integration tests. Each test binary runs
//! its own server, since they need different lifetimes for it.

// Every test binary compiles this module but uses only part of it.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use clap::Parser;
use tempfile::TempDir;
use tokio::task::JoinHandle;
use typstry_cli::api::Api;
use typstry_cli::commands::{self, Cli};
use typstry_cli::engine::Session;
use typstry_cli::link::ShareLink;
use typstry_cli::state::STATE_DIR;
use typstry_doc::init::init_project;
use typstry_server::http::{AppState, router};
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::db;
use typstry_wire::crypto::ProjectKey;

/// A server on the test's runtime, stopped when dropped.
pub struct Server {
    pub origin: String,
    pub state: AppState,
    task: JoinHandle<()>,
    _data: TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    pub async fn start() -> Self {
        let data = tempfile::tempdir().unwrap();
        let pool = db::open(&data.path().join("test.db")).await.unwrap();
        let state = AppState::new(pool, BlobStore::new(data.path()));
        let app = router(state.clone(), &data.path().join("no-dist"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            origin: format!("http://{addr}"),
            state,
            task,
            _data: data,
        }
    }

    /// A new, empty project: `(edit link, view link)`.
    pub async fn create_project(&self) -> (String, String) {
        let (edit, view) = create_project(&self.origin).await;
        (edit.to_string(), view.to_string())
    }

    pub async fn seeded_project(&self, title: &str) -> (String, String) {
        seeded_project(&self.origin, title).await
    }
}

/// Runs a command in-process, as `typstry -C dir --name Tester args..`.
pub async fn typstry(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    let mut argv = vec!["typstry", "-C", dir.to_str().unwrap(), "--name", "Tester"];
    argv.extend(args);
    commands::run(Cli::try_parse_from(argv)?).await
}

/// A temp folder by its canonical path, so paths compare cleanly on macOS
/// where the temp dir sits behind a symlink.
pub fn temp() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    (dir, path)
}

/// Clones `link` in-process into `parent/name` and returns its canonical
/// path.
pub async fn clone(link: &str, parent: &Path, name: &str) -> PathBuf {
    typstry(parent, &["clone", link, name]).await.unwrap();
    parent.join(name).canonicalize().unwrap()
}

pub fn read(dir: &Path, path: &str) -> String {
    let file = dir.join(path);
    fs::read_to_string(&file).unwrap_or_else(|err| panic!("{}: {err}", file.display()))
}

/// The file's text, or None when it is missing.
pub fn try_read(dir: &Path, path: &str) -> Option<String> {
    fs::read_to_string(dir.join(path)).ok()
}

/// Runs the real binary in `dir`, off the runtime thread so an in-process
/// server or sync keeps serving it. Stdin is never a terminal.
pub async fn binary(dir: &Path, args: &[&str]) -> Output {
    binary_with(dir, args, "", &[]).await
}

/// Runs the real binary with `input` on stdin and extra environment. The
/// typstry variables of whoever runs the tests are cleared first.
pub async fn binary_with(dir: &Path, args: &[&str], input: &str, env: &[(&str, &str)]) -> Output {
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
            .env_remove("TYPSTRY_SERVER")
            // Fails loudly instead of opening anything, should a test ever
            // reach the real opener.
            .env("TYPSTRY_BROWSER", "/nonexistent/typstry-test-browser")
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

/// Stdout of a run that must have succeeded.
pub fn stdout(out: &Output) -> String {
    assert!(
        out.status.success(),
        "failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout.clone()).unwrap()
}

pub fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).unwrap()
}

/// Stderr of a run that must have failed.
pub fn failed(out: &Output) -> String {
    assert!(
        !out.status.success(),
        "succeeded: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    stderr(out)
}

pub fn git(dir: &Path, args: &[&str]) -> String {
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

pub fn has_git() -> bool {
    let ok = typstry_cli::git::available();
    if !ok {
        eprintln!("git is not installed, skipping");
    }
    ok
}

/// The doc as cached by the last command in `dir`.
pub fn cached_doc(dir: &Path) -> loro::LoroDoc {
    typstry_cli::state::read_doc(&dir.join(STATE_DIR)).unwrap()
}

/// A new, empty project on the server at `origin`: `(edit, view)`.
pub async fn create_project(origin: &str) -> (ShareLink, ShareLink) {
    let created = Api::new(origin).unwrap().create_project().await.unwrap();
    let key = ProjectKey::generate_raw();
    let view_key = ProjectKey::from_base64url(&key).unwrap().view_secret();
    (
        ShareLink::new(origin, &created.edit_token, &key),
        ShareLink::new(origin, &created.view_token, &view_key),
    )
}

/// A connected session standing in for a browser.
pub async fn seeder(link: &ShareLink, dir: &Path) -> Session {
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    let mut session = Session::create(dir, link, &share, Some("Seeder")).unwrap();
    session.connect().await.unwrap();
    session
}

/// A project seeded like the browser does, with a title and the starter
/// main.typ: `(edit link, view link)`.
pub async fn seeded_project(origin: &str, title: &str) -> (String, String) {
    let (edit, view) = create_project(origin).await;
    let seed = tempfile::tempdir().unwrap();
    let mut session = seeder(&edit, seed.path()).await;
    init_project(session.doc(), title).unwrap();
    session.push_local().await.unwrap();
    session.disconnect().await;
    (edit.to_string(), view.to_string())
}
