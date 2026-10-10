//! Project setup shared by the integration tests. Each test binary runs
//! its own server, since they need different lifetimes for it.

// Every test binary compiles this module but uses only part of it.
#![allow(dead_code)]

use std::fs;
use std::path::Path;
use std::process::Command;

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
    let doc = loro::LoroDoc::new();
    doc.import(&fs::read(dir.join(STATE_DIR).join("doc.bin")).unwrap())
        .unwrap();
    doc
}

/// A new, empty project on the server at `origin`: `(edit, view)`.
pub async fn create_project(origin: &str) -> (ShareLink, ShareLink) {
    let created = Api::new(origin).unwrap().create_project().await.unwrap();
    let key = ProjectKey::generate_raw();
    (
        ShareLink::new(origin, &created.edit_token, &key),
        ShareLink::new(origin, &created.view_token, &key),
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
    init_project(&session.doc, title).unwrap();
    session.push_local().await.unwrap();
    session.disconnect().await;
    (edit.to_string(), view.to_string())
}
