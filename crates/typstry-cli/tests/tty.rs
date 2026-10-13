//! The interactive views, driven through a pseudo terminal the way a
//! person at a keyboard would: keys go in, and what the binary drew is
//! read back from a terminal emulator.
//!
//! Every other test runs the binary with piped stdio and so only ever sees
//! the plain output.

#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

use common::{Server, binary_with, stdout, temp};

const ROWS: u16 = 30;
const COLS: u16 = 120;
const WAIT: Duration = Duration::from_secs(20);

/// The binary running in a pseudo terminal.
struct Tty {
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    parser: Arc<Mutex<vt100::Parser>>,
    /// Everything the binary wrote, escape codes included.
    raw: Arc<Mutex<Vec<u8>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cursor {
    /// Answers "where is the cursor?" like a real terminal does.
    Answered,
    /// Never answers, like some minimal terminals and multiplexers.
    Ignored,
}

impl Tty {
    fn spawn(dir: &Path, config: &Path, args: &[&str], env: &[(&str, &str)]) -> Self {
        Self::spawn_with(dir, config, args, env, Cursor::Answered)
    }

    fn spawn_with(
        dir: &Path,
        config: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        cursor: Cursor,
    ) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: ROWS,
                cols: COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_typstry"));
        cmd.args(["-C", dir.to_str().unwrap(), "--name", "Tester"]);
        cmd.args(args);
        cmd.cwd(dir);
        // Only what the binary needs, so the typstry variables of whoever
        // runs the tests (TYPSTRY_PLAIN above all) stay out.
        cmd.env_clear();
        for key in ["PATH", "HOME"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("TYPSTRY_CONFIG_DIR", config);
        cmd.env("TYPSTRY_BROWSER", "/nonexistent/typstry-test-browser");
        cmd.env("GIT_CONFIG_GLOBAL", "/dev/null");
        cmd.env("GIT_CONFIG_NOSYSTEM", "1");
        for (key, value) in env {
            cmd.env(key, value);
        }
        let child = pair.slave.spawn_command(cmd).unwrap();
        // The child has its own copy; holding ours would keep the reader
        // from ever seeing the end once the child exits.
        drop(pair.slave);

        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let parser = Arc::new(Mutex::new(vt100::Parser::new(ROWS, COLS, 1000)));
        let raw = Arc::new(Mutex::new(Vec::new()));
        let mut reader = pair.master.try_clone_reader().unwrap();
        {
            let (writer, parser, raw) = (writer.clone(), parser.clone(), raw.clone());
            std::thread::spawn(move || {
                // Keeps the master open for as long as the reader runs.
                let _master = pair.master;
                let mut buf = [0u8; 8192];
                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let chunk = &buf[..n];
                    let mut parser = parser.lock().unwrap();
                    parser.process(chunk);
                    let mut raw = raw.lock().unwrap();
                    let before = raw.len();
                    raw.extend_from_slice(chunk);
                    // Looked for across the chunk boundary too.
                    let from = before.saturating_sub(3);
                    if cursor == Cursor::Answered && contains(&raw[from..], b"\x1b[6n") {
                        let (row, col) = parser.screen().cursor_position();
                        let reply = format!("\x1b[{};{}R", row + 1, col + 1);
                        let _ = writer.lock().unwrap().write_all(reply.as_bytes());
                    }
                }
            });
        }
        Self {
            child,
            writer,
            parser,
            raw,
        }
    }

    fn send(&self, keys: &str) {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(keys.as_bytes()).unwrap();
        writer.flush().unwrap();
        drop(writer);
        // Gives the view a moment, so keys sent one after another are not
        // read as one paste.
        std::thread::sleep(Duration::from_millis(100));
    }

    /// The visible screen as text.
    fn screen(&self) -> String {
        self.parser.lock().unwrap().screen().contents()
    }

    fn alternate_screen(&self) -> bool {
        self.parser.lock().unwrap().screen().alternate_screen()
    }

    fn raw(&self) -> String {
        String::from_utf8_lossy(&self.raw.lock().unwrap()).into_owned()
    }

    /// Waits until the screen shows `text`.
    fn wait_for(&self, text: &str) {
        self.wait_until(&format!("{text:?} on screen"), |screen| {
            screen.contains(text)
        });
    }

    fn wait_until(&self, what: &str, done: impl Fn(&str) -> bool) {
        let deadline = Instant::now() + WAIT;
        loop {
            let screen = self.screen();
            if done(&screen) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; the screen:\n{screen}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Waits for the binary to exit and returns whether it succeeded.
    fn wait_exit(&mut self) -> bool {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.success();
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                panic!("the binary did not exit; the screen:\n{}", self.screen());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Tty {
    fn drop(&mut self) {
        // A failed test must not leave a sync running.
        let _ = self.child.kill();
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// A person of their own: a config dir and a folder to work in.
struct Person {
    _config: tempfile::TempDir,
    config: PathBuf,
    _work: tempfile::TempDir,
    work: PathBuf,
}

impl Person {
    fn new() -> Self {
        let (_config, config) = temp();
        let (_work, work) = temp();
        Self {
            _config,
            config,
            _work,
            work,
        }
    }

    fn env(&self) -> [(&str, &str); 1] {
        [("TYPSTRY_CONFIG_DIR", self.config.to_str().unwrap())]
    }

    /// Creates the project `title` from a new folder `name` with one file.
    async fn init(&self, server: &Server, name: &str, title: &str) -> PathBuf {
        let dir = self.work.join(name);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("main.typ"), format!("= {title}\n")).unwrap();
        let args = [
            "init",
            "--server",
            &server.origin,
            "--title",
            title,
            "--yes",
        ];
        stdout(&binary_with(&dir, &args, "", &self.env()).await);
        dir
    }

    /// A project of this person that has no folder on this device.
    async fn missing(&self, server: &Server, title: &str) {
        let dir = self.init(server, "gone", title).await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    async fn plain(&self, dir: &Path, args: &[&str]) -> String {
        stdout(&binary_with(dir, args, "", &self.env()).await)
    }

    fn tty(&self, dir: &Path, args: &[&str]) -> Tty {
        Tty::spawn(dir, &self.config, args, &[])
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn list_opens_a_picker_and_gives_the_terminal_back() {
    let server = Server::start().await;
    let me = Person::new();
    me.init(&server, "alpha", "Alpha").await;
    me.missing(&server, "Gone").await;

    let mut tty = me.tty(&me.work, &["list"]);
    tty.wait_for("not on this device");
    let screen = tty.screen();
    assert!(screen.contains("1. Alpha"), "{screen}");
    assert!(screen.contains("2. Gone"), "{screen}");
    assert!(screen.contains("q quit"), "{screen}");
    assert!(tty.alternate_screen());

    tty.send("q");
    assert!(tty.wait_exit());
    assert!(!tty.alternate_screen());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_picker_filters_by_title_and_keeps_the_numbers() {
    let server = Server::start().await;
    let me = Person::new();
    me.init(&server, "alpha", "Alpha").await;
    me.init(&server, "beta", "Beta").await;

    let mut tty = me.tty(&me.work, &["list"]);
    tty.wait_for("2. Beta");
    tty.send("/");
    tty.send("bet");
    tty.wait_until("only Beta left", |s| {
        s.contains("2. Beta") && !s.contains("Alpha")
    });
    // Enter ends the typing; the filter stays until Esc.
    tty.send("\r");
    tty.send("q");
    assert!(tty.wait_exit());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_picker_opens_the_browser_without_showing_the_link() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;
    let edit = me.plain(&alpha, &["link", "--edit"]).await;
    let opened = me.work.join("opened.txt");
    let browser = me.work.join("browser.sh");
    std::fs::write(
        &browser,
        format!("#!/bin/sh\necho \"$1\" > '{}'\n", opened.display()),
    )
    .unwrap();
    std::fs::set_permissions(
        &browser,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();

    let browser = browser.to_str().unwrap();
    let mut tty = Tty::spawn(
        &me.work,
        &me.config,
        &["list"],
        &[("TYPSTRY_BROWSER", browser)],
    );
    tty.wait_for("1. Alpha");
    tty.send("o");
    tty.wait_for("Opening Alpha in the browser");
    let deadline = Instant::now() + WAIT;
    while !opened.exists() {
        assert!(Instant::now() < deadline, "the browser was never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        std::fs::read_to_string(&opened).unwrap().trim(),
        edit.trim()
    );
    // The link holds the key, so it must not end up in the scrollback.
    let key = edit.trim().split('#').nth(1).unwrap();
    assert!(!tty.raw().contains(key));

    tty.send("q");
    assert!(tty.wait_exit());
}

#[tokio::test(flavor = "multi_thread")]
async fn enter_in_the_picker_starts_sync_with_its_bar() {
    let server = Server::start().await;
    let me = Person::new();
    me.init(&server, "alpha", "Alpha").await;

    let mut tty = me.tty(&me.work, &["list"]);
    tty.wait_for("1. Alpha");
    tty.send("\r");
    // The picker's input reader must not swallow the bar's question for
    // the cursor position, or sync falls back to plain lines.
    tty.wait_for("q stop");
    tty.wait_for("sync: connected to");
    tty.send("q");
    assert!(tty.wait_exit(), "{}", tty.screen());
}

#[tokio::test(flavor = "multi_thread")]
async fn clone_without_a_link_clones_the_picked_project() {
    let server = Server::start().await;
    let me = Person::new();
    me.init(&server, "alpha", "Alpha").await;
    me.missing(&server, "Gone").await;

    let mut tty = me.tty(&me.work, &["clone"]);
    // Only the projects without a folder here.
    tty.wait_for("2. Gone");
    assert!(!tty.screen().contains("Alpha"), "{}", tty.screen());
    tty.send("\r");
    assert!(tty.wait_exit(), "{}", tty.screen());
    assert!(tty.screen().contains("Cloned \"Gone\""), "{}", tty.screen());
    assert_eq!(common::read(&me.work.join("Gone"), "main.typ"), "= Gone\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_mode_prints_the_list_in_a_terminal_too() {
    let server = Server::start().await;
    let me = Person::new();
    me.missing(&server, "Gone").await;

    let mut tty = me.tty(&me.work, &["--plain", "list"]);
    assert!(tty.wait_exit());
    assert!(tty.screen().contains("typstry clone 1"), "{}", tty.screen());
    assert!(
        !tty.raw().contains("\x1b[?1049h"),
        "entered the alternate screen"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_shows_a_status_bar_under_its_log() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;

    let mut tty = me.tty(&alpha, &["sync"]);
    tty.wait_for("q stop");
    tty.wait_until("connected and named", |s| {
        s.contains("connected") && s.contains("Alpha") && s.contains("sync: connected to")
    });
    std::fs::write(alpha.join("new.typ"), "fresh\n").unwrap();
    tty.wait_for("\u{2191} new.typ (new)");
    tty.wait_for("\u{2191}1 \u{2193}0");
    // The whole bar, not just the cells that changed since the last draw.
    tty.wait_for("p publish  o open  l links  q stop");

    tty.send("q");
    assert!(tty.wait_exit(), "{}", tty.screen());
    let screen = tty.screen();
    // The log stays, the bar is gone.
    assert!(screen.contains("\u{2191} new.typ (new)"), "{screen}");
    assert!(screen.contains("sync: stopping"), "{screen}");
    assert!(!screen.contains("q stop"), "{screen}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_runs_plain_when_the_terminal_does_not_answer() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;

    let mut tty = Tty::spawn_with(&alpha, &me.config, &["sync"], &[], Cursor::Ignored);
    tty.wait_for("sync: connected to");
    assert!(!tty.screen().contains("q stop"), "{}", tty.screen());
    // Raw mode is off again, so Ctrl+C is a signal and sync flushes.
    tty.send("\x03");
    assert!(tty.wait_exit(), "{}", tty.screen());
    assert!(tty.screen().contains("sync: stopping"), "{}", tty.screen());
}

#[tokio::test(flavor = "multi_thread")]
async fn version_list_saves_a_new_version() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;

    let mut tty = me.tty(&alpha, &["version", "list"]);
    tty.wait_for("No named versions yet");
    tty.send("n");
    tty.wait_for("New version name");
    tty.send("first draft");
    tty.send("\r");
    assert!(tty.wait_exit(), "{}", tty.screen());
    assert!(tty.screen().contains("Saved version"), "{}", tty.screen());

    let listed = me.plain(&alpha, &["version", "list"]).await;
    assert!(listed.contains("first draft"), "{listed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn version_list_exports_the_picked_version() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;
    me.plain(&alpha, &["version", "save", "v1"]).await;

    let mut tty = me.tty(&alpha, &["version", "list"]);
    tty.wait_for("v1");
    tty.send("e");
    tty.wait_for("Export to folder");
    tty.send("\r");
    assert!(tty.wait_exit(), "{}", tty.screen());
    // The suggested folder sits next to the project.
    assert_eq!(
        common::read(&me.work.join("alpha-v1"), "main.typ"),
        "= Alpha\n"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn share_reset_asks_first_and_keeps_the_links_on_no() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;
    let before = me.plain(&alpha, &["link"]).await;

    let mut tty = me.tty(&alpha, &["share", "reset"]);
    tty.wait_for("[y/N]");
    tty.send("n\r");
    assert!(tty.wait_exit());
    assert!(
        tty.screen().contains("Nothing replaced."),
        "{}",
        tty.screen()
    );
    assert_eq!(me.plain(&alpha, &["link"]).await, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn members_and_devices_open_as_lists() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;

    let mut tty = me.tty(&alpha, &["members"]);
    tty.wait_for("(this device)");
    // The owner may remove members.
    assert!(tty.screen().contains("d remove"), "{}", tty.screen());
    tty.send("q");
    assert!(tty.wait_exit());

    let mut tty = me.tty(&alpha, &["devices"]);
    tty.wait_for("(this device)");
    assert!(
        tty.screen().contains("cannot revoke itself"),
        "{}",
        tty.screen()
    );
    tty.send("q");
    assert!(tty.wait_exit());
}

#[tokio::test(flavor = "multi_thread")]
async fn pair_counts_down_while_it_waits() {
    let server = Server::start().await;
    let me = Person::new();
    let alpha = me.init(&server, "alpha", "Alpha").await;

    let mut tty = me.tty(&alpha, &["pair", "--server", &server.origin]);
    tty.wait_for(" left");
    let first = tty.screen();
    // The line is redrawn in place with less time left.
    tty.wait_until("the countdown to move", |s| {
        s.contains(" left") && s != first
    });
    assert_eq!(tty.screen().matches(" left").count(), 1, "{}", tty.screen());
    tty.send("\x03");
    assert!(!tty.wait_exit());
}
