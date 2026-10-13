//! Whether the terminal can take an interactive view, and where printed
//! lines go while one is on screen.
//!
//! Everything interactive falls back to the plain line output when this
//! says no, so scripts, pipes, CI and the tests never see a TUI.

use std::io::{IsTerminal, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::mpsc;

use crate::commands::Line;

static PLAIN: AtomicBool = AtomicBool::new(false);

/// While an interactive view owns the terminal, printed lines go here so
/// the view can place them instead of them landing on top of it.
static SINK: Mutex<Option<mpsc::UnboundedSender<Line>>> = Mutex::new(None);

/// Asks for plain output for the rest of the process (`--plain`).
pub fn set_plain(plain: bool) {
    PLAIN.store(plain, Ordering::Relaxed);
}

/// Whether to show an interactive view instead of plain lines.
pub fn interactive() -> bool {
    decide(
        std::io::stdin().is_terminal(),
        std::io::stdout().is_terminal(),
        std::env::var("TERM").ok().as_deref(),
        PLAIN.load(Ordering::Relaxed),
    )
}

/// Both ends have to be a terminal: keys come from stdin, and a view
/// drawn into a pipe would end up as escape codes in someone's file.
fn decide(stdin_tty: bool, stdout_tty: bool, term: Option<&str>, plain: bool) -> bool {
    stdin_tty && stdout_tty && term != Some("dumb") && !plain
}

/// Sends printed lines to the returned receiver until the guard drops.
pub fn capture() -> (Capture, mpsc::UnboundedReceiver<Line>) {
    let (tx, rx) = mpsc::unbounded_channel();
    *lock() = Some(tx);
    (Capture(()), rx)
}

/// Ends a [`capture`] when dropped, also when the view bails out early.
#[must_use]
pub struct Capture(());

impl Drop for Capture {
    fn drop(&mut self) {
        *lock() = None;
    }
}

fn lock() -> std::sync::MutexGuard<'static, Option<mpsc::UnboundedSender<Line>>> {
    // A panic while holding the lock leaves nothing half-written: the
    // option is replaced whole.
    SINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Hands `line` to the view that captures output, or gives it back when
/// none does.
pub(crate) fn send(line: Line) -> Result<(), Line> {
    match lock().as_ref() {
        Some(tx) => tx.send(line).map_err(|err| err.0),
        None => Err(line),
    }
}

/// The writer for log events: stderr, or the capturing view as one line
/// per event. tracing writes each event whole and then drops the writer.
#[derive(Default)]
pub struct LogWriter(Vec<u8>);

impl Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for LogWriter {
    fn drop(&mut self) {
        if self.0.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&self.0);
        let line = Line::Stderr(strip_ansi(text.trim_end()));
        if send(line).is_err() {
            let _ = std::io::stderr().write_all(&self.0);
        }
    }
}

/// Drops the color codes the log formatter adds: the view draws text
/// itself and would show them as garbage.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // CSI sequences end with a letter, e.g. `\x1b[2m`.
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_only_on_a_real_terminal() {
        assert!(decide(true, true, Some("xterm-256color"), false));
        assert!(decide(true, true, None, false));
        assert!(!decide(false, true, Some("xterm"), false));
        assert!(!decide(true, false, Some("xterm"), false));
        assert!(!decide(true, true, Some("dumb"), false));
        assert!(!decide(true, true, Some("xterm"), true));
    }

    #[test]
    fn strips_color_codes() {
        assert_eq!(
            strip_ansi("\x1b[33m WARN\x1b[0m \x1b[2mtypstry\x1b[0m: hi"),
            " WARN typstry: hi"
        );
    }
}
