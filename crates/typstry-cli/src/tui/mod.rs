//! Interactive views for a terminal. Each has a plain counterpart that
//! runs whenever [`crate::term::interactive`] says no.

pub mod chooser;
pub mod countdown;
pub mod picker;
pub mod sync_bar;
pub mod versions;

use anyhow::Context;
use futures_util::StreamExt;
use ratatui::crossterm::event::{
    Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use ratatui::style::{Modifier, Style, Stylize};
use ratatui::text::Line;
use ratatui::widgets::{List, ListItem, Paragraph};
use ratatui::{DefaultTerminal, Frame};

/// Takes over the whole terminal (alternate screen, raw mode). The guard
/// puts it back however the view ends, errors included. Create the view's
/// `EventStream` after the guard so it is dropped first.
pub fn full_screen() -> anyhow::Result<(DefaultTerminal, FullScreen)> {
    match ratatui::try_init() {
        Ok(terminal) => Ok((terminal, FullScreen(()))),
        Err(err) => {
            // try_init may fail after raw mode and the alternate screen
            // are already on.
            ratatui::restore();
            Err(err).context("cannot start the interactive view (try --plain)")
        }
    }
}

#[must_use]
pub struct FullScreen(());

impl Drop for FullScreen {
    fn drop(&mut self) {
        // Dropping crossterm's EventStream leaves a wakeup behind even when
        // nothing was waiting for input. The next poll takes it as "nothing
        // came", so a sync status bar started right after a view would give
        // up on reading the cursor position. Eat it here instead.
        let _ = ratatui::crossterm::event::poll(std::time::Duration::ZERO);
        ratatui::restore();
    }
}

/// Runs a full-screen view until `on_key` comes back with an outcome,
/// redrawing after every event. Input ending counts as `closed`.
pub(crate) async fn run_view<S, O>(
    state: &mut S,
    render: impl Fn(&mut Frame, &S),
    mut on_key: impl FnMut(&mut S, KeyEvent) -> Option<O>,
    closed: O,
) -> anyhow::Result<O> {
    let (mut terminal, _screen) = full_screen()?;
    let mut events = EventStream::new();
    loop {
        terminal.draw(|frame| render(frame, state))?;
        match events.next().await {
            Some(Ok(Event::Key(key))) if is_suspend(&key) => {
                suspend_full_screen(&mut terminal)?;
            }
            Some(Ok(Event::Key(key))) => {
                if let Some(outcome) = on_key(state, key) {
                    return Ok(outcome);
                }
            }
            Some(Ok(_)) => {}
            Some(Err(err)) => return Err(err.into()),
            None => return Ok(closed),
        }
    }
}

/// Whether `key` is Ctrl+Z. In raw mode the terminal hands it over as a
/// key instead of suspending the process, so the views do that
/// themselves. Only on Unix, where there is job control to hand over to.
pub(crate) fn is_suspend(key: &KeyEvent) -> bool {
    cfg!(unix)
        && key.kind != KeyEventKind::Release
        && key.modifiers.contains(KeyModifiers::CONTROL)
        && key.code == KeyCode::Char('z')
}

/// Stops the process like Ctrl+Z does outside raw mode and returns once
/// the shell resumes it (`fg`). Without job control the stop is discarded
/// and this returns right away.
pub(crate) fn stop_self() {
    // Raising a signal from inside the process takes unsafe code or another
    // dependency; kill(1) is there wherever a shell has job control.
    #[cfg(unix)]
    let _ = std::process::Command::new("kill")
        .arg("-TSTP")
        .arg(std::process::id().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Gives the terminal back to the shell for a Ctrl+Z, and takes it over
/// again, fully redrawn, once the process is resumed.
pub(crate) fn suspend_full_screen(terminal: &mut DefaultTerminal) -> anyhow::Result<()> {
    let _ = terminal.show_cursor();
    ratatui::restore();
    stop_self();
    ratatui::crossterm::terminal::enable_raw_mode()?;
    ratatui::crossterm::execute!(
        std::io::stdout(),
        ratatui::crossterm::terminal::EnterAlternateScreen
    )?;
    terminal.clear()?;
    Ok(())
}

/// Moves a cursor over `len` rows by one, stopping at either end instead
/// of wrapping.
pub(crate) fn step(selected: usize, len: usize, down: bool) -> usize {
    if down {
        (selected + 1).min(len.saturating_sub(1))
    } else {
        selected.saturating_sub(1)
    }
}

/// A list that marks the selected row the same way in every view.
pub(crate) fn highlight_list<'a>(items: impl IntoIterator<Item = ListItem<'a>>) -> List<'a> {
    List::new(items)
        .highlight_style(Style::new().add_modifier(Modifier::REVERSED))
        .highlight_symbol("> ")
}

/// The dim key hints, with the longer help under them while it is on.
pub(crate) fn footer<'a>(
    hints: impl Into<Line<'a>>,
    help: Option<impl Into<Line<'a>>>,
) -> Paragraph<'a> {
    let mut lines = vec![hints.into().dim()];
    lines.extend(help.map(|help| help.into().dim()));
    Paragraph::new(lines)
}

/// What `render` draws on a `width` x `height` screen, one row per line.
#[cfg(test)]
pub(crate) fn drawn(width: u16, height: u16, render: impl FnOnce(&mut Frame)) -> String {
    let mut terminal =
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
    terminal.draw(render).unwrap();
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
