//! `typstry sync` against an in-process server: the live loop runs as a
//! task in the test, a second folder plays the co-author through one-shot
//! pull and push, and the server can be killed and restarted in place.

mod common;

use common::{binary, cached_doc, clone, failed, read, stdout, try_read, typstry};

use std::fs;
use std::future::Future;
use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use tempfile::TempDir;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use typstry_cli::commands::Ctx;
use typstry_cli::commands::sync::{self, Control, Notice};
use typstry_cli::state::STATE_DIR;
use typstry_server::http::{AppState, router};
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::db;

/// A server on its own runtime, so stopping it really drops every
/// connection, the way a crash would.
struct Server {
    data: TempDir,
    addr: SocketAddr,
    runtime: Option<tokio::runtime::Runtime>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Server {
    async fn start() -> Self {
        let data = tempfile::tempdir().unwrap();
        let (runtime, addr) = launch(data.path(), None).await;
        Self {
            data,
            addr,
            runtime: Some(runtime),
        }
    }

    fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn stop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }

    /// Same port, same database: clients reconnect as if it rebooted.
    async fn restart(&mut self) {
        self.stop();
        let (runtime, _) = launch(self.data.path(), Some(self.addr)).await;
        self.runtime = Some(runtime);
    }

    async fn seeded_project(&self) -> (String, String) {
        common::seeded_project(&self.origin(), "Live").await
    }
}

async fn launch(data: &Path, addr: Option<SocketAddr>) -> (tokio::runtime::Runtime, SocketAddr) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let data = data.to_path_buf();
    let (tx, rx) = oneshot::channel();
    runtime.spawn(async move {
        let pool = db::open(&data.join("test.db")).await.unwrap();
        let state = AppState::new(pool, BlobStore::new(&data));
        let app = router(state, &data.join("no-dist"));
        let listener = bind(addr).await;
        tx.send(listener.local_addr().unwrap()).unwrap();
        axum::serve(listener, app).await.unwrap();
    });
    let addr = rx.await.unwrap();
    (runtime, addr)
}

/// The old runtime lets go of the port in the background, so binding it
/// again may take a few tries.
async fn bind(addr: Option<SocketAddr>) -> tokio::net::TcpListener {
    let addr = addr.unwrap_or_else(|| "127.0.0.1:0".parse().unwrap());
    for _ in 0..100 {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_reuseaddr(true).unwrap();
        if socket.bind(addr).is_ok()
            && let Ok(listener) = socket.listen(1024)
        {
            return listener;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("cannot bind {addr}");
}

/// Polls `check` until it holds or `secs` pass.
async fn eventually<F, Fut>(secs: u64, what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if check().await {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// What the co-author's folder holds at `path` after a pull.
async fn pulled(dir: &Path, path: &str) -> Option<String> {
    typstry(dir, &["pull"]).await.unwrap();
    try_read(dir, path)
}

/// Writes `path` in the co-author's folder and pushes it.
async fn push_edit(dir: &Path, path: &str, content: &str) {
    fs::write(dir.join(path), content).unwrap();
    typstry(dir, &["push"]).await.unwrap();
}

/// Makes `dir` look like a git checkout of `branch` as far as typstry can
/// tell; it only ever reads HEAD and looks for lock files.
fn fake_git(dir: &Path, branch: &str) {
    fs::create_dir_all(dir.join(".git")).unwrap();
    checkout(dir, branch);
}

/// Swaps HEAD in one rename, as git does, so sync never reads half of it.
fn checkout(dir: &Path, branch: &str) {
    let tmp = dir.join(".git/HEAD.lock");
    fs::write(&tmp, format!("ref: refs/heads/{branch}\n")).unwrap();
    fs::rename(tmp, dir.join(".git/HEAD")).unwrap();
}

/// Total ops in the doc a folder cached on its last command.
fn op_count(dir: &Path) -> i64 {
    cached_doc(dir)
        .oplog_vv()
        .iter()
        .map(|(_, &n)| i64::from(n))
        .sum()
}

struct Live {
    control: mpsc::UnboundedSender<Control>,
    notices: mpsc::UnboundedReceiver<Notice>,
    task: JoinHandle<anyhow::Result<()>>,
}

impl Live {
    async fn start(dir: &Path) -> Self {
        Self::start_with(dir, sync::Args::default()).await
    }

    async fn start_with(dir: &Path, args: sync::Args) -> Self {
        let (control, control_rx) = mpsc::unbounded_channel();
        let (notice_tx, notices) = mpsc::unbounded_channel();
        let ctx = Ctx {
            dir: dir.to_path_buf(),
            name: Some("Live".into()),
        };
        let task =
            tokio::spawn(
                async move { sync::run_with(&ctx, args, control_rx, Some(notice_tx)).await },
            );
        let mut live = Self {
            control,
            notices,
            task,
        };
        live.wait_for(Notice::Ready).await;
        live
    }

    /// Waits for `notice`, skipping any others.
    async fn wait_for(&mut self, notice: Notice) {
        let wait = async {
            while let Some(seen) = self.notices.recv().await {
                if seen == notice {
                    return;
                }
            }
            panic!("sync ended before {notice:?}");
        };
        tokio::time::timeout(Duration::from_secs(20), wait)
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {notice:?}"));
    }

    async fn stop(self) {
        self.control.send(Control::Stop).unwrap();
        tokio::time::timeout(Duration::from_secs(20), self.task)
            .await
            .expect("sync did not stop")
            .unwrap()
            .unwrap();
    }
}

/// Long enough for sync to have acted on something if it was going to:
/// the debounce, the coalescing delay and a round trip, with room.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1500)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn syncs_both_ways_without_echoes() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    let live = Live::start(&a).await;

    // Commands that cannot ask it refuse to run next to it, and say why.
    let err = typstry(&a, &["track", "main"]).await.unwrap_err();
    assert!(err.to_string().contains("typstry sync"), "{err}");

    fs::write(a.join("main.typ"), "= From the folder\n").unwrap();
    eventually(15, "local edit reaches the other client", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= From the folder\n")
    })
    .await;

    push_edit(&b, "notes.typ", "remote notes\n").await;
    eventually(15, "remote edit lands on disk", || async {
        try_read(&a, "notes.typ").as_deref() == Some("remote notes\n")
    })
    .await;

    // Writing notes.typ fired the watcher in a; none of it may come back
    // as new ops.
    settle().await;
    typstry(&b, &["pull"]).await.unwrap();
    let ops = op_count(&b);
    settle().await;
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(op_count(&b), ops, "sync echoed its own write");

    // Stopping flushes an edit the watcher has not even reported yet.
    fs::write(a.join("late.typ"), "late\n").unwrap();
    live.stop().await;
    assert_eq!(pulled(&b, "late.typ").await.as_deref(), Some("late\n"));
    // And the lock is free again.
    typstry(&a, &["track", "main"]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_git_lock_pauses_sync() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    let mut live = Live::start(&a).await;
    let original = read(&a, "main.typ");

    fs::write(a.join(".git/index.lock"), "").unwrap();
    live.wait_for(Notice::Paused).await;
    fs::write(a.join("main.typ"), "= Mid merge\n").unwrap();
    settle().await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));

    // The edit was kept, not dropped, and goes out once git is done.
    fs::remove_file(a.join(".git/index.lock")).unwrap();
    live.wait_for(Notice::Resumed).await;
    eventually(15, "the edit goes out after the lock is gone", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Mid merge\n")
    })
    .await;
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn another_branch_pauses_and_the_tracked_one_resumes() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    let mut live = Live::start(&a).await;

    checkout(&a, "draft");
    live.wait_for(Notice::Paused).await;
    push_edit(&b, "notes.typ", "while on draft\n").await;
    settle().await;
    assert_eq!(try_read(&a, "notes.typ"), None);

    checkout(&a, "main");
    live.wait_for(Notice::Resumed).await;
    eventually(15, "remote edit lands after resuming", || async {
        try_read(&a, "notes.typ").as_deref() == Some("while on draft\n")
    })
    .await;

    // Back to normal in both directions.
    fs::write(a.join("main.typ"), "= Back on main\n").unwrap();
    eventually(15, "local edit goes out after resuming", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Back on main\n")
    })
    .await;
    assert!(!a.join(STATE_DIR).join("hold").exists());
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_tree_after_a_branch_switch_is_held_until_published() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    let mut live = Live::start(&a).await;
    let original = read(&a, "main.typ");

    // The checkout back to main leaves the folder different from the last
    // sync, like one that drops edits pulled while on the draft.
    checkout(&a, "draft");
    live.wait_for(Notice::Paused).await;
    fs::write(a.join("main.typ"), "= Not what main had\n").unwrap();
    checkout(&a, "main");
    live.wait_for(Notice::Holding).await;
    assert!(a.join(STATE_DIR).join("hold").exists());

    // Incoming changes still arrive, outgoing ones wait, including new
    // edits made while holding.
    push_edit(&b, "notes.typ", "incoming\n").await;
    eventually(15, "remote edit lands while holding", || async {
        try_read(&a, "notes.typ").as_deref() == Some("incoming\n")
    })
    .await;
    fs::write(a.join("extra.typ"), "made while holding\n").unwrap();
    settle().await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));
    assert_eq!(try_read(&b, "extra.typ"), None);

    live.control.send(Control::Publish).unwrap();
    live.wait_for(Notice::Released).await;
    eventually(15, "held changes go out after publishing", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Not what main had\n")
            && try_read(&b, "extra.typ").as_deref() == Some("made while holding\n")
    })
    .await;
    assert!(!a.join(STATE_DIR).join("hold").exists());
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restarted_sync_keeps_holding() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    let original = read(&a, "main.typ");

    let mut live = Live::start(&a).await;
    checkout(&a, "draft");
    live.wait_for(Notice::Paused).await;
    fs::write(a.join("main.typ"), "= Held\n").unwrap();
    checkout(&a, "main");
    live.wait_for(Notice::Holding).await;
    live.stop().await;

    // Restarting does not publish behind the user's back...
    let live = Live::start(&a).await;
    settle().await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));
    live.stop().await;

    // ...but --publish does.
    let live = Live::start_with(&a, sync::Args { publish: true }).await;
    eventually(15, "--publish sends the held change", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Held\n")
    })
    .await;
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn offline_edits_go_out_after_the_server_comes_back() {
    let mut server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    let mut live = Live::start(&a).await;

    server.stop();
    live.wait_for(Notice::Offline).await;
    fs::write(a.join("main.typ"), "= Written offline\n").unwrap();
    settle().await;

    server.restart().await;
    live.wait_for(Notice::Connected).await;
    eventually(15, "offline edit reaches the server", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Written offline\n")
    })
    .await;
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_view_link_only_receives() {
    let server = Server::start().await;
    let (edit, view) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let v = clone(&view, work.path(), "v").await;
    let b = clone(&edit, work.path(), "b").await;
    let live = Live::start(&v).await;

    let original = read(&b, "main.typ");
    fs::write(v.join("main.typ"), "= Not allowed\n").unwrap();
    push_edit(&b, "notes.typ", "for viewers\n").await;
    eventually(15, "remote edit lands in the view clone", || async {
        try_read(&v, "notes.typ").as_deref() == Some("for viewers\n")
    })
    .await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));
    live.stop().await;
}

/// Appends a HEAD reflog entry, the way git logs every move of HEAD.
fn reflog(dir: &Path, message: &str) {
    use std::io::Write;
    fs::create_dir_all(dir.join(".git/logs")).unwrap();
    let zero = "0".repeat(40);
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(".git/logs/HEAD"))
        .unwrap();
    writeln!(
        log,
        "{zero} {zero} Test <test@example.com> 1700000000 +0000\t{message}"
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_branch_switch_while_sync_was_stopped_is_held() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    reflog(&a, "commit (initial): import");
    let original = read(&a, "main.typ");
    Live::start(&a).await.stop().await;

    reflog(&a, "checkout: moving from main to draft");
    fs::write(a.join("main.typ"), "= Draft only\n").unwrap();
    reflog(&a, "checkout: moving from draft to main");

    let mut live = Live::start(&a).await;
    assert!(a.join(STATE_DIR).join("hold").exists());
    settle().await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));

    // The reflog still shows the switch after publishing, which must not
    // put the hold straight back.
    live.control.send(Control::Publish).unwrap();
    live.wait_for(Notice::Released).await;
    eventually(15, "publishing sends the held change", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Draft only\n")
    })
    .await;
    assert!(!a.join(STATE_DIR).join("hold").exists());
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn publish_on_start_sends_a_change_held_after_a_branch_switch() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    reflog(&a, "commit (initial): import");
    Live::start(&a).await.stop().await;

    reflog(&a, "checkout: moving from main to draft");
    fs::write(a.join("main.typ"), "= Draft only\n").unwrap();
    reflog(&a, "checkout: moving from draft to main");

    let live = Live::start_with(&a, sync::Args { publish: true }).await;
    eventually(15, "--publish sends the held change", || async {
        pulled(&b, "main.typ").await.as_deref() == Some("= Draft only\n")
    })
    .await;
    assert!(!a.join(STATE_DIR).join("hold").exists());
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reset_under_a_git_lock_is_checked_like_a_branch_switch() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    reflog(&a, "commit (initial): import");
    let original = read(&a, "main.typ");
    let mut live = Live::start(&a).await;

    // `git reset --hard` rewrites files while it holds the index lock and
    // stays on the same branch.
    fs::write(a.join(".git/index.lock"), "").unwrap();
    live.wait_for(Notice::Paused).await;
    fs::write(a.join("main.typ"), "= Reset away\n").unwrap();
    settle().await;
    reflog(&a, "reset: moving to HEAD~1");
    fs::remove_file(a.join(".git/index.lock")).unwrap();
    live.wait_for(Notice::Holding).await;
    settle().await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_next_to_sync_ask_it() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    let live = Live::start(&a).await;

    // Saved right after an edit, before the watcher has reported it: the
    // version still holds it.
    fs::write(a.join("main.typ"), "= In the version\n").unwrap();
    let saved = stdout(&binary(&a, &["version", "save", "Draft 1"]).await);
    assert!(saved.contains("Saved version #0 \"Draft 1\"."), "{saved}");
    let export = work.path().join("export");
    typstry(&b, &["export", "--at", "Draft 1", export.to_str().unwrap()])
        .await
        .unwrap();
    assert_eq!(
        try_read(&export, "main.typ").as_deref(),
        Some("= In the version\n")
    );

    let list = stdout(&binary(&a, &["version", "list"]).await);
    assert!(list.contains("Draft 1"), "{list}");
    let status = stdout(&binary(&a, &["status"]).await);
    assert!(status.contains("Everything up to date."), "{status}");
    let info = stdout(&binary(&a, &["info"]).await);
    assert!(info.contains("Sync:        running (pid "), "{info}");
    assert!(info.contains("Versions:    1 named"), "{info}");
    assert!(info.contains("Local:       up to date"), "{info}");
    let pull = stdout(&binary(&a, &["pull"]).await);
    assert!(pull.contains("already pulls remote changes"), "{pull}");

    // An explicit push is confirmed by the server before it returns. What
    // it lists depends on whether the watcher got there first.
    fs::write(a.join("notes.typ"), "pushed by hand\n").unwrap();
    stdout(&binary(&a, &["push"]).await);
    assert_eq!(
        pulled(&b, "notes.typ").await.as_deref(),
        Some("pushed by hand\n")
    );

    let err = failed(&binary(&a, &["track", "main"]).await);
    assert!(err.contains("typstry sync"), "{err}");
    live.stop().await;

    // Nothing is left in the mailbox.
    let mailbox = a.join(STATE_DIR).join("requests");
    assert_eq!(fs::read_dir(mailbox).unwrap().count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn push_next_to_a_holding_sync_needs_force() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    let b = clone(&edit, work.path(), "b").await;
    fake_git(&a, "main");
    let mut live = Live::start(&a).await;
    let original = read(&a, "main.typ");

    // While paused on a draft, nothing may be published or named.
    checkout(&a, "draft");
    live.wait_for(Notice::Paused).await;
    let err = failed(&binary(&a, &["version", "save", "On draft"]).await);
    assert!(err.contains("paused (on branch draft"), "{err}");
    let err = failed(&binary(&a, &["push", "--force"]).await);
    assert!(err.contains("paused"), "{err}");
    let status = stdout(&binary(&a, &["status"]).await);
    assert!(status.contains("sync: paused, on branch draft"), "{status}");

    fs::write(a.join("main.typ"), "= Held back\n").unwrap();
    checkout(&a, "main");
    live.wait_for(Notice::Holding).await;

    // Like a one-shot push after a branch switch: listed, refused...
    let err = failed(&binary(&a, &["push"]).await);
    assert!(
        err.contains("M main.typ") && err.contains("--force"),
        "{err}"
    );
    let info = stdout(&binary(&a, &["info"]).await);
    assert!(info.contains("holding back outgoing changes"), "{info}");
    settle().await;
    assert_eq!(pulled(&b, "main.typ").await, Some(original));

    // ...and published with --force, which ends the hold.
    let pushed = stdout(&binary(&a, &["push", "--force"]).await);
    assert!(pushed.contains("\u{2191} main.typ"), "{pushed}");
    live.wait_for(Notice::Released).await;
    assert_eq!(
        pulled(&b, "main.typ").await.as_deref(),
        Some("= Held back\n")
    );
    assert!(!a.join(STATE_DIR).join("hold").exists());
    live.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_key_stops_sync_instead_of_retrying() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project().await;
    let work = tempfile::tempdir().unwrap();
    let a = clone(&edit, work.path(), "a").await;
    // A folder that never synced, with a key that is not the project's.
    let state = a.join(STATE_DIR);
    let config_path = state.join("config.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    let other = typstry_wire::crypto::ProjectKey::generate_raw();
    config["key"] = serde_json::Value::String(other.to_string());
    fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    for name in ["doc.bin", "doc.log", "base.json"] {
        let _ = fs::remove_file(state.join(name));
    }
    fs::remove_file(a.join("main.typ")).unwrap();

    let live = Live::start(&a).await;
    let err = tokio::time::timeout(Duration::from_secs(20), live.task)
        .await
        .expect("sync kept retrying")
        .unwrap()
        .unwrap_err();
    assert!(format!("{err:#}").contains("encrypted with key"), "{err:#}");
}
