//! Project setup shared by the integration tests. Each test binary runs
//! its own server, since they need different lifetimes for it.

// Every test binary compiles this module but uses only part of it.
#![allow(dead_code)]

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

use clap::Parser;
use tempfile::TempDir;
use tokio::task::JoinHandle;
use typstry_cli::api::Api;
use typstry_cli::commands::{self, Cli};
use typstry_cli::engine::Identity;
use typstry_cli::engine::Session;
use typstry_cli::link::ShareLink;
use typstry_cli::state::STATE_DIR;
use typstry_doc::init::init_project;
use typstry_server::http::{AppState, router};
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::db;
use typstry_wire::crypto::LinkSecret;

/// The user-level state (person key, project list) of this test binary: a
/// temp folder, so the tests never touch the real config dir. Every folder
/// cloned in-process is then the same person; tests that need distinct
/// people or an inspectable config pass their own `TYPSTRY_CONFIG_DIR` to
/// [`binary_with`].
pub fn config_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<TempDir> = std::sync::OnceLock::new();
    let dir = DIR.get_or_init(|| tempfile::tempdir().unwrap());
    typstry_cli::user::override_config_dir(dir.path().to_owned());
    dir.path().to_owned()
}

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
        config_dir();
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
    config_dir();
    let mut argv = vec!["typstry", "-C", dir.to_str().unwrap(), "--name", "Tester"];
    argv.extend(args);
    commands::run(Cli::try_parse_from(argv)?).await
}

/// A temp folder by its canonical path, so paths compare cleanly on macOS
/// where the temp dir sits behind a symlink.
/// Fails unless only the owner can read and write `path`. Key material and
/// group state must never be readable by other local users.
pub fn assert_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "{}", path.display());
    }
    #[cfg(not(unix))]
    let _ = path;
}

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
    let config = config_dir();
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
            .env("TYPSTRY_CONFIG_DIR", &config)
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
    let secret = LinkSecret::generate_edit();
    let edit = ShareLink::new(origin, &created.edit_token, &secret.to_base64url());
    let view = ShareLink::new(origin, &created.view_token, &secret.view_secret());
    // The browser that creates a project starts its group; everyone else
    // joins it. This one only stands in for that, it does not sync. Like
    // `typstry init` it leaves the owner key on this machine, so the folders
    // cloned in-process (the same person) can rotate from the start.
    config_dir();
    typstry_cli::mls::create_group(
        &edit,
        &created.project_id,
        &Identity::new("Browser"),
        &typstry_cli::user::load_or_create_identity().unwrap(),
    )
    .await
    .unwrap();
    (edit, view)
}

/// A connected session standing in for a browser.
pub async fn seeder(link: &ShareLink, dir: &Path) -> Session {
    config_dir();
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    let mut session = Session::create(dir, link, &share, None, Some("Seeder")).unwrap();
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

/// A `typstry pair` that shows a code, still running.
pub struct Shower {
    child: Child,
    pub code: String,
    /// Reads the rest of stdout, so the child never blocks on a full pipe.
    rest: std::thread::JoinHandle<String>,
}

impl Shower {
    /// Starts `pair` in `dir` with `config` and reads its code off stdout.
    pub async fn start(dir: &Path, config: &Path, args: &[&str]) -> Self {
        let dir = dir.to_path_buf();
        let config = config.to_path_buf();
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        tokio::task::spawn_blocking(move || {
            let mut child = Command::new(env!("CARGO_BIN_EXE_typstry"))
                .arg("-C")
                .arg(&dir)
                .args(["--name", "Tester", "pair"])
                .args(&args)
                .current_dir(&dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_remove("TYPSTRY_SERVER")
                .env("TYPSTRY_CONFIG_DIR", &config)
                .spawn()
                .unwrap();
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            let code = loop {
                let line = lines
                    .next()
                    .expect("pair exited before showing a code")
                    .unwrap();
                if let Some(code) = line.strip_prefix("Pairing code: ") {
                    break code.to_owned();
                }
            };
            let rest = std::thread::spawn(move || {
                lines
                    .map_while(Result::ok)
                    .fold(String::new(), |mut out, line| {
                        out.push_str(&line);
                        out.push('\n');
                        out
                    })
            });
            Self { child, code, rest }
        })
        .await
        .unwrap()
    }

    pub async fn finish(self) -> std::process::Output {
        tokio::task::spawn_blocking(move || {
            let mut child = self.child;
            let status = child.wait().unwrap();
            let mut stderr = Vec::new();
            if let Some(mut pipe) = child.stderr.take() {
                std::io::Read::read_to_end(&mut pipe, &mut stderr).unwrap();
            }
            // Everything after the code line.
            let stdout = self.rest.join().unwrap().into_bytes();
            std::process::Output {
                status,
                stdout,
                stderr,
            }
        })
        .await
        .unwrap()
    }
}

pub fn config_in(dir: &Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::create_dir_all(&path).unwrap();
    path
}

/// Clones `link` as the person whose config is `config`.
pub async fn clone_as(config: &Path, link: &str, parent: &Path, name: &str) -> std::path::PathBuf {
    let env = [("TYPSTRY_CONFIG_DIR", config.to_str().unwrap())];
    stdout(&binary_with(parent, &["clone", link, name], "", &env).await);
    parent.join(name).canonicalize().unwrap()
}

/// Creates a project from a new folder as the person whose keys are in `config`.
pub async fn init_as(
    server: &Server,
    parent: &Path,
    name: &str,
    config: &Path,
) -> std::path::PathBuf {
    let env = [("TYPSTRY_CONFIG_DIR", config.to_str().unwrap())];
    let args = ["init", name, "--server", &server.origin, "--yes"];
    stdout(&binary_with(parent, &args, "", &env).await);
    parent.join(name).canonicalize().unwrap()
}

pub async fn run_as(dir: &Path, config: &Path, args: &[&str]) -> std::process::Output {
    let env = [("TYPSTRY_CONFIG_DIR", config.to_str().unwrap())];
    binary_with(dir, args, "", &env).await
}

/// The number of the first member that is not this device and has `role`.
pub fn other_leaf(listing: &str, role: &str) -> String {
    listing
        .lines()
        .filter(|l| l.trim_start().starts_with('#') && !l.contains("(this device)"))
        .find(|l| l.contains(role))
        .and_then(|l| l.trim_start().strip_prefix('#'))
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or_else(|| panic!("no {role} in {listing}"))
        .to_owned()
}
