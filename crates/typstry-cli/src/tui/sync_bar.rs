//! The status bar under the log of `typstry sync`.
//!
//! Everything the sync loop prints is captured (see [`crate::term`]) and
//! written above a two line inline viewport, so the log ends up in the
//! terminal's scrollback like plain output would and the bar stays put.

use std::path::Path;
use std::time::{Duration, Instant};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::backend::{Backend, ClearType};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line as Row, Span, Text};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use ratatui::{DefaultTerminal, TerminalOptions, Viewport};
use tokio::sync::mpsc;

use crate::commands::link::{self, Which};
use crate::commands::open;
use crate::commands::sync::{self, Args, Control, Notice};
use crate::commands::{Ctx, Line, Output};
use crate::state::StateDir;
use crate::term;

const BAR_HEIGHT: u16 = 2;

/// What the bar shows, fed by the loop's [`Notice`]s.
#[derive(Debug, Clone)]
pub struct BarState {
    title: String,
    link: Link,
    /// Git is busy or another branch is checked out.
    paused: bool,
    /// Outgoing changes wait for the user to publish.
    holding: bool,
    stopping: bool,
    up: usize,
    down: usize,
    last_sync: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Link {
    Connecting,
    Connected,
    Offline,
}

impl BarState {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            link: Link::Connecting,
            paused: false,
            holding: false,
            stopping: false,
            up: 0,
            down: 0,
            last_sync: None,
        }
    }

    pub fn apply(&mut self, notice: Notice) {
        self.apply_at(notice, Instant::now());
    }

    fn apply_at(&mut self, notice: Notice, now: Instant) {
        match notice {
            Notice::Ready => {}
            Notice::Connected => self.link = Link::Connected,
            Notice::Offline => self.link = Link::Offline,
            Notice::Paused => self.paused = true,
            Notice::Resumed => self.paused = false,
            Notice::Holding => self.holding = true,
            Notice::Released => self.holding = false,
            Notice::Synced { up, down } => {
                self.up += up;
                self.down += down;
                self.last_sync = Some(now);
            }
        }
    }

    pub fn stopping(&mut self) {
        self.stopping = true;
    }

    fn status(&self) -> (&'static str, Color) {
        if self.stopping {
            ("stopping...", Color::Yellow)
        } else if self.paused {
            ("paused for git", Color::Yellow)
        } else if self.holding {
            ("holding back changes", Color::Yellow)
        } else {
            match self.link {
                Link::Connecting => ("connecting", Color::DarkGray),
                Link::Connected => ("connected", Color::Green),
                Link::Offline => ("offline, reconnecting", Color::Red),
            }
        }
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer, now: Instant) {
        let dim = Style::default().fg(Color::DarkGray);
        let (text, color) = self.status();
        let mut top = vec![
            Span::styled(" \u{25cf} ", Style::default().fg(color)),
            Span::styled(
                text,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::raw(self.title.clone()),
            Span::raw("  "),
            Span::styled(
                format!("\u{2191}{}", self.up),
                Style::default().fg(Color::Green),
            ),
            Span::raw(" "),
            Span::styled(
                format!("\u{2193}{}", self.down),
                Style::default().fg(Color::Cyan),
            ),
        ];
        if let Some(at) = self.last_sync {
            top.push(Span::styled(
                format!("  last {} ago", age(now.saturating_duration_since(at))),
                dim,
            ));
        }
        let key = Style::default().add_modifier(Modifier::BOLD);
        let publish = if self.holding && !self.stopping {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            key
        };
        let hints = Row::from(vec![
            Span::raw(" "),
            Span::styled("p publish", publish),
            Span::raw("  "),
            Span::styled("o", key),
            Span::styled(" open  ", dim),
            Span::styled("l", key),
            Span::styled(" links  ", dim),
            Span::styled("q", key),
            Span::styled(" stop", dim),
        ]);
        Paragraph::new(Text::from(vec![Row::from(top), hints])).render(area, buf);
    }
}

/// `3s`, `2m`, `1h`: one unit is enough for "how stale is this".
fn age(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h", secs / 3600),
    }
}

/// A captured line as it appears in the log: warnings and errors in
/// color, sync's own chatter dimmed, and the arrows of synced files
/// colored like in the bar.
fn style(line: &Line) -> Text<'static> {
    let (text, stderr) = match line {
        Line::Stdout(text) => (text, false),
        Line::Stderr(text) => (text, true),
    };
    // Tabs and other control characters would move the cursor behind the
    // renderer's back and shear the bar.
    let clean: String = text
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    clean
        .split('\n')
        .map(|row| style_row(row, stderr))
        .collect()
}

fn style_row(row: &str, stderr: bool) -> Row<'static> {
    let paint = |color| Style::default().fg(color);
    if let Some(rest) = row.strip_prefix('\u{2191}') {
        return Row::from(vec![
            Span::styled("\u{2191}", paint(Color::Green)),
            Span::raw(rest.to_string()),
        ]);
    }
    if let Some(rest) = row.strip_prefix('\u{2193}') {
        return Row::from(vec![
            Span::styled("\u{2193}", paint(Color::Cyan)),
            Span::raw(rest.to_string()),
        ]);
    }
    let style = if row.starts_with("warning:") {
        paint(Color::Yellow)
    } else if row.starts_with("error:") {
        paint(Color::Red)
    } else if row.starts_with("sync:") && stderr {
        paint(Color::Yellow)
    } else if row.starts_with("sync:") {
        Style::default().add_modifier(Modifier::DIM)
    } else {
        Style::default()
    };
    Row::styled(row.to_string(), style)
}

/// How many rows `paragraph` takes at `width` columns.
fn rows(paragraph: &Paragraph<'_>, width: u16) -> u16 {
    let count = paragraph.line_count(width.max(1));
    u16::try_from(count).unwrap_or(u16::MAX).max(1)
}

fn log_paragraph(text: Text<'_>) -> Paragraph<'_> {
    Paragraph::new(text).wrap(Wrap { trim: false })
}

/// The terminal while the bar owns it. Dropping gives it back, on every
/// way out of [`run`].
pub struct Screen {
    terminal: DefaultTerminal,
    restored: bool,
}

impl Screen {
    /// Takes over the bottom of the terminal, or None when it cannot,
    /// e.g. because it never answers where the cursor is. Sync then runs
    /// plain instead of failing.
    pub fn new() -> Option<Self> {
        // Inline viewports only turn on raw mode; no alternate screen, so
        // the log stays in the scrollback.
        match ratatui::try_init_with_options(TerminalOptions {
            viewport: Viewport::Inline(BAR_HEIGHT),
        }) {
            Ok(terminal) => Some(Self {
                terminal,
                restored: false,
            }),
            Err(err) => {
                // Raw mode is already on by the time the viewport fails.
                let _ = crossterm::terminal::disable_raw_mode();
                tracing::debug!("no status bar: {err}");
                None
            }
        }
    }

    fn log(&mut self, line: &Line) {
        let paragraph = log_paragraph(style(line));
        let width = self.terminal.size().map_or(80, |size| size.width);
        let height = rows(&paragraph, width);
        // A failed write must not take the sync down with it.
        let _ = self.terminal.insert_before(height, |buf| {
            (&paragraph).render(buf.area, buf);
        });
    }

    fn draw(&mut self, state: &BarState) {
        let now = Instant::now();
        let _ = self
            .terminal
            .draw(|frame| state.render(frame.area(), frame.buffer_mut(), now));
    }

    /// Wipes the bar and leaves the cursor where it was, so what is
    /// printed next starts below the log instead of over the bar.
    fn restore(&mut self) {
        if std::mem::replace(&mut self.restored, true) {
            return;
        }
        self.release();
    }

    fn release(&mut self) {
        let top = self.terminal.get_frame().area().as_position();
        let backend = self.terminal.backend_mut();
        let _ = backend.set_cursor_position(top);
        let _ = backend.clear_region(ClearType::AfterCursor);
        let _ = self.terminal.show_cursor();
        let _ = crossterm::terminal::disable_raw_mode();
    }

    /// Gives the terminal back to the shell for a Ctrl+Z and, once the
    /// process is resumed, puts the bar under wherever the shell left the
    /// cursor. Sync itself is stopped along with the process meanwhile.
    fn suspend(&mut self) {
        if self.restored {
            return;
        }
        self.release();
        super::stop_self();
        if crossterm::terminal::enable_raw_mode().is_err() {
            return;
        }
        let options = TerminalOptions {
            viewport: Viewport::Inline(BAR_HEIGHT),
        };
        // Not ratatui::init again, which would stack another panic hook
        // on every suspend.
        match ratatui::Terminal::with_options(
            ratatui::backend::CrosstermBackend::new(std::io::stdout()),
            options,
        ) {
            Ok(terminal) => self.terminal = terminal,
            Err(err) => tracing::debug!("status bar not redrawn after resuming: {err}"),
        }
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        self.restore();
    }
}

/// `typstry sync` under the status bar.
pub async fn run(ctx: &Ctx, args: Args, mut screen: Screen) -> anyhow::Result<()> {
    // Output printed while the bar tears down is still caught instead of
    // landing on a half restored terminal: `screen` is dropped explicitly
    // below, before this guard.
    let (_capture, mut lines) = term::capture();
    let mut state = BarState::new(title(&ctx.dir));

    let (control, control_rx) = mpsc::unbounded_channel();
    let (notice_tx, mut notices) = mpsc::unbounded_channel();
    // A future that is polled here, not spawned: it only borrows `ctx`.
    let sync = sync::run_with(ctx, args, control_rx, Some(notice_tx), true);
    tokio::pin!(sync);

    // With raw mode on, Ctrl+C is a key press. The signal still matters
    // when something else sends SIGINT, or raw mode did not take.
    let (sigint_tx, mut sigint) = mpsc::unbounded_channel();
    let signals = tokio::spawn(async move {
        while tokio::signal::ctrl_c().await.is_ok() {
            if sigint_tx.send(()).is_err() {
                break;
            }
        }
    });

    let mut keys = Keys::start();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    screen.draw(&state);
    let result = loop {
        let mut interrupted = false;
        let mut pressed = None;
        tokio::select! {
            result = &mut sync => break result,
            Some(line) = lines.recv() => {
                // A burst of lines gets one redraw of the bar, not one each.
                screen.log(&line);
                while let Ok(line) = lines.try_recv() {
                    screen.log(&line);
                }
            }
            Some(notice) = notices.recv() => state.apply(notice),
            Some(()) = sigint.recv() => interrupted = true,
            Some(key) = keys.next() => pressed = Some(key),
            _ = tick.tick() => {}
        }
        if let Some(key) = pressed {
            match action(key) {
                Some(Action::Interrupt) => interrupted = true,
                Some(Action::Publish) => {
                    let _ = control.send(Control::Publish);
                }
                Some(Action::Open) => open_in_browser(&ctx.dir),
                Some(Action::Links) => print_links(&ctx.dir),
                Some(Action::Stop) => stop(&control, &mut state),
                Some(Action::Suspend) => screen.suspend(),
                None => {}
            }
        }
        if interrupted {
            if state.stopping {
                // The flush is stuck or the user is done waiting.
                screen.restore();
                eprintln!("sync: interrupted again, exiting without flushing");
                std::process::exit(130);
            }
            stop(&control, &mut state);
        }
        screen.draw(&state);
    };
    signals.abort();
    keys.stop();

    // Whatever the loop printed on its way out belongs in the log too.
    while let Ok(line) = lines.try_recv() {
        screen.log(&line);
    }
    drop(screen);
    result
}

/// Key presses, read on a thread of their own.
///
/// Not crossterm's EventStream: while it waits for a key it holds the lock
/// on terminal input, and ratatui asks the terminal where the cursor is
/// when it resizes the bar. That query would go unanswered for two seconds
/// and leave the bar half drawn. Polling in short slices keeps the lock
/// free in between.
struct Keys {
    rx: mpsc::UnboundedReceiver<KeyEvent>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Keys {
    const SLICE: Duration = Duration::from_millis(50);

    fn start() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match crossterm::event::poll(Self::SLICE) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    // stdin went away; the signal handler can still stop
                    // the sync.
                    Err(_) => break,
                }
                match crossterm::event::read() {
                    Ok(Event::Key(key)) if key.kind != KeyEventKind::Release => {
                        if tx.send(key).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
        Self {
            rx,
            stop,
            thread: Some(thread),
        }
    }

    async fn next(&mut self) -> Option<KeyEvent> {
        self.rx.recv().await
    }

    /// Waits for the thread, so it reads nothing meant for whatever runs
    /// after the bar.
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Keys {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stop(control: &mpsc::UnboundedSender<Control>, state: &mut BarState) {
    let _ = control.send(Control::Stop);
    state.stopping();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Publish,
    Open,
    Links,
    Stop,
    Interrupt,
    Suspend,
}

fn action(key: KeyEvent) -> Option<Action> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char('c') if ctrl => Some(Action::Interrupt),
        _ if super::is_suspend(&key) => Some(Action::Suspend),
        _ if ctrl => None,
        KeyCode::Char('p' | 'P') => Some(Action::Publish),
        KeyCode::Char('o' | 'O') => Some(Action::Open),
        KeyCode::Char('l' | 'L') => Some(Action::Links),
        KeyCode::Char('q' | 'Q') => Some(Action::Stop),
        _ => None,
    }
}

/// The project's title as `typstry list` shows it, else the folder's
/// name. The folder's own config does not keep the title.
fn title(dir: &Path) -> String {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_owned());
    let known = crate::user::projects().unwrap_or_default();
    match known
        .iter()
        .find(|p| std::fs::canonicalize(&p.dir).is_ok_and(|d| d == dir))
    {
        Some(project) => project.display_title(),
        None => dir.file_name().map_or_else(
            || "typstry".into(),
            |name| name.to_string_lossy().into_owned(),
        ),
    }
}

fn error(err: &anyhow::Error) {
    say_err!("error: {err:#}");
}

fn open_in_browser(dir: &Path) {
    let config = match StateDir::peek_config(dir) {
        Ok(config) => config,
        Err(err) => return error(&err),
    };
    // A view-only folder has no edit link; its view link is the next best.
    let (which, url) = match link::url(&config, Which::Edit) {
        Ok(url) => ("edit", url),
        Err(edit_err) => match link::url(&config, Which::View) {
            Ok(url) => ("view", url),
            Err(_) => return error(&edit_err),
        },
    };
    // The URL carries the key, so it stays out of the log.
    say!("Opening the {which} link in the browser");
    open::launch_in_background(url);
}

fn print_links(dir: &Path) {
    match StateDir::peek_config(dir) {
        Ok(config) => link::write_links(&mut Output::terminal(), &config),
        Err(err) => error(&err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn draw(state: &BarState, now: Instant) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(60, 2)).unwrap();
        terminal
            .draw(|frame| state.render(frame.area(), frame.buffer_mut(), now))
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..2)
            .map(|y| {
                (0..60)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn notices_drive_the_state() {
        let t0 = Instant::now();
        let mut state = BarState::new("thesis");
        assert_eq!(state.status().0, "connecting");

        state.apply_at(Notice::Connected, t0);
        assert_eq!(state.status(), ("connected", Color::Green));
        state.apply_at(Notice::Offline, t0);
        assert_eq!(state.status(), ("offline, reconnecting", Color::Red));
        state.apply_at(Notice::Connected, t0);

        state.apply_at(Notice::Holding, t0);
        assert_eq!(state.status().0, "holding back changes");
        state.apply_at(Notice::Paused, t0);
        assert_eq!(state.status().0, "paused for git");
        state.apply_at(Notice::Resumed, t0);
        assert_eq!(state.status().0, "holding back changes");
        state.apply_at(Notice::Released, t0);
        assert_eq!(state.status().0, "connected");

        state.apply_at(Notice::Synced { up: 2, down: 1 }, t0);
        state.apply_at(Notice::Synced { up: 1, down: 0 }, t0);
        assert_eq!((state.up, state.down), (3, 1));

        state.stopping();
        assert_eq!(state.status().0, "stopping...");
    }

    #[test]
    fn renders_state_totals_and_age() {
        let t0 = Instant::now();
        let mut state = BarState::new("thesis");
        state.apply_at(Notice::Connected, t0);
        state.apply_at(Notice::Synced { up: 4, down: 2 }, t0);

        let rows = draw(&state, t0 + Duration::from_secs(3));
        assert_eq!(
            rows[0],
            " \u{25cf} connected  thesis  \u{2191}4 \u{2193}2  last 3s ago"
        );
        assert_eq!(rows[1], " p publish  o open  l links  q stop");
    }

    #[test]
    fn no_age_before_the_first_sync() {
        let state = BarState::new("thesis");
        let rows = draw(&state, Instant::now());
        assert_eq!(rows[0], " \u{25cf} connecting  thesis  \u{2191}0 \u{2193}0");
    }

    #[test]
    fn publish_hint_lights_up_while_holding() {
        let t0 = Instant::now();
        let mut state = BarState::new("t");
        let mut terminal = Terminal::new(TestBackend::new(60, 2)).unwrap();
        let mut bg = |state: &BarState| {
            terminal
                .draw(|frame| state.render(frame.area(), frame.buffer_mut(), t0))
                .unwrap();
            terminal.backend().buffer()[(2, 1)].bg
        };
        assert_ne!(bg(&state), Color::Yellow);
        state.apply_at(Notice::Holding, t0);
        assert_eq!(bg(&state), Color::Yellow);
    }

    #[test]
    fn ages_use_one_unit() {
        assert_eq!(age(Duration::from_secs(0)), "0s");
        assert_eq!(age(Duration::from_secs(59)), "59s");
        assert_eq!(age(Duration::from_secs(60)), "1m");
        assert_eq!(age(Duration::from_secs(7200)), "2h");
    }

    #[test]
    fn long_lines_take_several_rows() {
        let rows_of = |text: &str| rows(&log_paragraph(style(&Line::Stdout(text.into()))), 10);
        assert_eq!(rows_of(&"a".repeat(25)), 3);
        assert_eq!(rows_of("one\ntwo"), 2);
        assert_eq!(rows_of(""), 1);
    }

    #[test]
    fn control_characters_stay_out_of_the_log() {
        let text = style(&Line::Stderr("a\tb\x1b[31mc".into()));
        assert_eq!(text.lines[0].to_string(), "a b[31mc");
    }

    #[test]
    fn keys_map_to_actions() {
        let key = |code, modifiers| KeyEvent::new(code, modifiers);
        let none = KeyModifiers::NONE;
        assert_eq!(action(key(KeyCode::Char('p'), none)), Some(Action::Publish));
        assert_eq!(action(key(KeyCode::Char('o'), none)), Some(Action::Open));
        assert_eq!(action(key(KeyCode::Char('l'), none)), Some(Action::Links));
        assert_eq!(action(key(KeyCode::Char('q'), none)), Some(Action::Stop));
        assert_eq!(
            action(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(Action::Interrupt)
        );
        assert_eq!(action(key(KeyCode::Char('p'), KeyModifiers::CONTROL)), None);
        assert_eq!(action(key(KeyCode::Enter, none)), None);
        assert_eq!(
            action(key(KeyCode::Char('z'), KeyModifiers::CONTROL)),
            cfg!(unix).then_some(Action::Suspend)
        );
    }
}
