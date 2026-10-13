//! The project picker of `typstry list` and `typstry clone`.
//!
//! [`Picker`] holds the state and turns keys into [`Action`]s without
//! touching the terminal, so the rules can be tested; [`pick`] owns the
//! terminal and the event loop around it.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use futures_util::StreamExt;
use ratatui::Frame;
use ratatui::crossterm::event::{
    Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use ratatui::widgets::{ListItem, ListState, Paragraph};

use crate::commands::link;
use crate::commands::open::launch_in_background;
use crate::state::StateDir;
use crate::user::{CatalogEntry, catalog};
use crate::{space, term};

/// What the picker is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// `typstry list`: sync what is here, clone what is not.
    List,
    /// `typstry clone` without a link: only cloning makes sense.
    Clone,
}

/// What the person chose. The picker has left the terminal by then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Sync(PathBuf),
    /// The project's share link rather than its number, because `typstry
    /// clone` refreshes the catalog again and a project that arrived in the
    /// meantime would shift the numbers.
    Clone(String),
    Quit,
}

/// What a key asks the event loop to do beyond changing the state.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    None,
    Refresh,
    /// Index into the full list.
    Open(usize),
    Done(Outcome),
}

struct Picker {
    mode: Mode,
    entries: Vec<CatalogEntry>,
    filter: String,
    filtering: bool,
    missing_only: bool,
    /// Position among the visible rows, not in the full list.
    selected: usize,
    help: bool,
    status: Option<String>,
    refreshing: bool,
}

impl Picker {
    fn new(mode: Mode, entries: Vec<CatalogEntry>, missing_only: bool) -> Self {
        Self {
            mode,
            entries,
            filter: String::new(),
            filtering: false,
            missing_only,
            selected: 0,
            help: false,
            status: None,
            refreshing: false,
        }
    }

    /// Indices into the full list of the rows to show. The number a row
    /// shows is its index plus one whatever is filtered out, so it means
    /// the same as in `typstry list`.
    fn visible(&self) -> Vec<usize> {
        let needle = self.filter.to_lowercase();
        (0..self.entries.len())
            .filter(|&i| {
                let entry = &self.entries[i];
                (!self.missing_only || entry.dir.is_none())
                    && (needle.is_empty() || entry.title.to_lowercase().contains(&needle))
            })
            .collect()
    }

    fn current(&self) -> Option<usize> {
        self.visible().get(self.selected).copied()
    }

    fn clamp(&mut self) {
        let len = self.visible().len();
        self.selected = self.selected.min(len.saturating_sub(1));
    }

    fn step(&mut self, down: bool) {
        self.selected = super::step(self.selected, self.visible().len(), down);
    }

    /// Swaps in a freshly read list and keeps the cursor on the same
    /// project if it is still there.
    fn replace(&mut self, entries: Vec<CatalogEntry>) {
        let kept = self.current().map(|i| self.entries[i].link.clone());
        self.entries = entries;
        if let Some(link) = kept
            && let Some(pos) = self
                .visible()
                .iter()
                .position(|&i| self.entries[i].link == link)
        {
            self.selected = pos;
        }
        self.clamp();
    }

    fn on_key(&mut self, key: KeyEvent) -> Action {
        // Windows also reports releases; acting on both would double every key.
        if key.kind == KeyEventKind::Release {
            return Action::None;
        }
        self.status = None;
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Action::Done(Outcome::Quit);
        }
        if self.filtering {
            return self.on_filter_key(key);
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.step(false),
            KeyCode::Down | KeyCode::Char('j') => self.step(true),
            KeyCode::Char('/') => self.filtering = true,
            KeyCode::Char('m') => {
                self.missing_only = !self.missing_only;
                self.clamp();
            }
            KeyCode::Char('?') => self.help = !self.help,
            KeyCode::Char('r') => return Action::Refresh,
            KeyCode::Char('o') => return self.open(),
            KeyCode::Char('s') => return self.sync(),
            KeyCode::Char('c') => return self.clone_it(),
            KeyCode::Enter => {
                return match self.current().map(|i| self.entries[i].dir.is_some()) {
                    Some(true) => self.sync(),
                    Some(false) => self.clone_it(),
                    None => Action::None,
                };
            }
            KeyCode::Esc if !self.filter.is_empty() => {
                self.filter.clear();
                self.clamp();
            }
            KeyCode::Esc | KeyCode::Char('q') => return Action::Done(Outcome::Quit),
            _ => {}
        }
        Action::None
    }

    fn on_filter_key(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Enter | KeyCode::Esc => self.filtering = false,
            KeyCode::Backspace => {
                self.filter.pop();
            }
            KeyCode::Up => self.step(false),
            KeyCode::Down => self.step(true),
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.filter.push(c);
            }
            _ => {}
        }
        // The list shrinks or grows under the cursor as the text changes.
        self.clamp();
        Action::None
    }

    /// The selected entry, unless there is none or it is unavailable, in
    /// which case the status says why.
    fn usable(&mut self, verb: &str) -> Option<usize> {
        let i = self.current()?;
        match self.entries[i].unavailable() {
            Some(why) => {
                self.status = Some(format!("Cannot {verb} this project: {why}"));
                None
            }
            None => Some(i),
        }
    }

    fn open(&mut self) -> Action {
        match self.usable("open") {
            Some(i) => Action::Open(i),
            None => Action::None,
        }
    }

    fn sync(&mut self) -> Action {
        if self.mode == Mode::Clone {
            self.status = Some("This picker only clones; use `typstry list` to sync".into());
            return Action::None;
        }
        let Some(i) = self.usable("sync") else {
            return Action::None;
        };
        match self.entries[i].dir.clone() {
            Some(dir) => Action::Done(Outcome::Sync(dir)),
            None => {
                self.status = Some("Not on this device; press c to clone it".into());
                Action::None
            }
        }
    }

    fn clone_it(&mut self) -> Action {
        let Some(i) = self.usable("clone") else {
            return Action::None;
        };
        if self.entries[i].dir.is_some() {
            self.status = Some("Already on this device".into());
            return Action::None;
        }
        Action::Done(Outcome::Clone(self.entries[i].link.clone()))
    }
}

fn hints(mode: Mode) -> &'static str {
    match mode {
        Mode::List => {
            "j/k move  enter sync/clone  o open  / filter  m missing  r refresh  ? help  q quit"
        }
        Mode::Clone => {
            "j/k move  enter clone  o open  / filter  m missing  r refresh  ? help  q quit"
        }
    }
}

const HELP: &str = "up/down or j/k move, / filter by title (enter or esc to stop typing, esc clears), \
m only projects missing here, s sync, c clone, o open in the browser, r refresh from your other devices";

fn render(frame: &mut Frame, picker: &Picker) {
    let [header, body, status, keys] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(if picker.help { 2 } else { 1 }),
    ])
    .areas(frame.area());

    let mut title = vec![Span::from("typstry projects").bold()];
    if picker.missing_only {
        title.push(Span::from("  [missing only]").yellow());
    }
    if picker.filtering || !picker.filter.is_empty() {
        title.push(Span::from(format!("  /{}", picker.filter)));
        if picker.filtering {
            title.push(Span::from("_"));
        }
    }
    frame.render_widget(Line::from(title), header);

    let visible = picker.visible();
    if visible.is_empty() {
        let text = if picker.entries.is_empty() {
            "No projects yet. Create one with `typstry init`, or pair with a device of yours."
        } else if picker.missing_only && picker.filter.is_empty() {
            "Every project is on this device."
        } else {
            "No project matches."
        };
        frame.render_widget(Paragraph::new(text).dim(), body);
    } else {
        let items = visible.iter().map(|&i| {
            let entry = &picker.entries[i];
            let why = entry.unavailable();
            let place = match (&entry.dir, why) {
                (_, Some(why)) => format!("unavailable: {why}"),
                (Some(dir), None) => dir.display().to_string(),
                (None, None) => "not on this device".to_owned(),
            };
            let item = ListItem::new(vec![
                Line::from(format!("{:>3}. {}", i + 1, entry.title)),
                Line::from(format!("     {place}")).dim(),
            ]);
            if why.is_some() { item.dim() } else { item }
        });
        let list = super::highlight_list(items);
        let mut state = ListState::default().with_selected(Some(picker.selected));
        frame.render_stateful_widget(list, body, &mut state);
    }

    let note = match (&picker.status, picker.refreshing) {
        (Some(status), _) => status.clone(),
        (None, true) => "refreshing...".to_owned(),
        (None, false) => String::new(),
    };
    frame.render_widget(Line::from(note), status);
    frame.render_widget(
        super::footer(hints(picker.mode), picker.help.then_some(HELP)),
        keys,
    );
}

/// Where `o` sends the browser: the edit link of a local folder when it
/// has one, otherwise the share link of the catalog.
fn open_url(entry: &CatalogEntry) -> String {
    entry
        .dir
        .as_deref()
        .and_then(|dir| StateDir::peek_config(dir).ok())
        .and_then(|config| link::url(&config, link::Which::Edit).ok())
        .unwrap_or_else(|| entry.link.clone())
}

type Refresh = Pin<Box<dyn Future<Output = ()>>>;

/// Shows the projects until the person picks one or quits. The terminal
/// is restored before this returns.
pub async fn pick(mode: Mode, missing_only: bool) -> anyhow::Result<Outcome> {
    // Read before taking over the screen so a failure prints normally.
    let mut picker = Picker::new(mode, catalog()?, missing_only || mode == Mode::Clone);
    let (mut terminal, _screen) = super::full_screen()?;
    // Warnings of the refresh would land on top of the screen otherwise.
    let (_capture, mut warnings) = term::capture();

    // Not spawned: the refresh only needs polling while we wait for keys.
    let mut refresh: Option<Refresh> = Some(Box::pin(space::sync_bound()));
    let mut events = EventStream::new();

    loop {
        picker.refreshing = refresh.is_some();
        terminal.draw(|frame| render(frame, &picker))?;
        let mut finished = false;
        let action = tokio::select! {
            event = events.next() => match event {
                Some(Ok(Event::Key(key))) if super::is_suspend(&key) => {
                    super::suspend_full_screen(&mut terminal)?;
                    Action::None
                }
                Some(Ok(Event::Key(key))) => picker.on_key(key),
                Some(Ok(_)) => Action::None,
                Some(Err(err)) => return Err(err.into()),
                None => Action::Done(Outcome::Quit),
            },
            Some(line) = warnings.recv() => {
                let (crate::commands::Line::Stdout(text) | crate::commands::Line::Stderr(text)) = line;
                picker.status = Some(text);
                Action::None
            }
            () = async { refresh.as_mut().expect("guarded").await }, if refresh.is_some() => {
                finished = true;
                Action::None
            }
        };
        if finished {
            refresh = None;
            reload(&mut picker);
        }
        match action {
            Action::None => {}
            Action::Done(outcome) => return Ok(outcome),
            Action::Refresh if refresh.is_none() => {
                refresh = Some(Box::pin(space::sync_bound()));
            }
            Action::Refresh => picker.status = Some("Already refreshing".into()),
            Action::Open(i) => {
                let entry = &picker.entries[i];
                picker.status = Some(format!("Opening {} in the browser", entry.title));
                // A failure comes back through the captured lines into
                // the status.
                launch_in_background(open_url(entry));
            }
        }
    }
}

fn reload(picker: &mut Picker) {
    match catalog() {
        Ok(entries) => picker.replace(entries),
        Err(err) => picker.status = Some(format!("Cannot read your projects: {err:#}")),
    }
}

#[cfg(test)]
mod tests {
    use typstry_doc::directory::State;

    use super::*;

    fn entry(title: &str, dir: Option<&str>, state: State) -> CatalogEntry {
        CatalogEntry {
            title: title.into(),
            link: format!("https://example.test/{title}"),
            dir: dir.map(PathBuf::from),
            project_id: None,
            state,
        }
    }

    fn sample() -> Vec<CatalogEntry> {
        vec![
            entry("Thesis", Some("/work/thesis"), State::Listed),
            entry("Paper", None, State::Listed),
            entry("Old notes", None, State::Removed),
            entry("Thesis slides", None, State::Listed),
            entry("Lost", Some("/work/lost"), State::Gone),
        ]
    }

    fn press(picker: &mut Picker, code: KeyCode) -> Action {
        picker.on_key(KeyEvent::from(code))
    }

    fn type_text(picker: &mut Picker, text: &str) {
        for c in text.chars() {
            press(picker, KeyCode::Char(c));
        }
    }

    fn numbers(picker: &Picker) -> Vec<usize> {
        picker.visible().iter().map(|i| i + 1).collect()
    }

    #[test]
    fn numbers_stay_those_of_the_full_list() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        assert_eq!(numbers(&picker), [1, 2, 3, 4, 5]);
        press(&mut picker, KeyCode::Char('m'));
        assert_eq!(numbers(&picker), [2, 3, 4]);
        press(&mut picker, KeyCode::Char('/'));
        type_text(&mut picker, "SLIDES");
        assert_eq!(numbers(&picker), [4]);
    }

    #[test]
    fn filter_is_a_case_insensitive_substring() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        press(&mut picker, KeyCode::Char('/'));
        type_text(&mut picker, "thes");
        assert_eq!(numbers(&picker), [1, 4]);
        press(&mut picker, KeyCode::Backspace);
        press(&mut picker, KeyCode::Backspace);
        press(&mut picker, KeyCode::Backspace);
        press(&mut picker, KeyCode::Backspace);
        assert_eq!(numbers(&picker), [1, 2, 3, 4, 5]);
    }

    #[test]
    fn typing_in_the_filter_does_not_trigger_commands() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        press(&mut picker, KeyCode::Char('/'));
        assert_eq!(press(&mut picker, KeyCode::Char('q')), Action::None);
        assert_eq!(picker.filter, "q");
        // Enter leaves the input but keeps the text.
        press(&mut picker, KeyCode::Enter);
        assert!(!picker.filtering);
        assert_eq!(picker.filter, "q");
        // Esc outside the input clears it before it quits.
        assert_eq!(press(&mut picker, KeyCode::Esc), Action::None);
        assert!(picker.filter.is_empty());
        assert_eq!(
            press(&mut picker, KeyCode::Esc),
            Action::Done(Outcome::Quit)
        );
    }

    #[test]
    fn selection_is_clamped_when_the_list_shrinks() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        for _ in 0..10 {
            press(&mut picker, KeyCode::Char('j'));
        }
        assert_eq!(picker.selected, 4);
        press(&mut picker, KeyCode::Char('/'));
        type_text(&mut picker, "paper");
        assert_eq!(picker.selected, 0);
        assert_eq!(picker.current(), Some(1));
        type_text(&mut picker, "zzz");
        assert_eq!(picker.current(), None);
        // Nothing to act on, nothing to crash on.
        press(&mut picker, KeyCode::Enter);
    }

    #[test]
    fn enter_syncs_local_and_clones_missing() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        assert_eq!(
            press(&mut picker, KeyCode::Enter),
            Action::Done(Outcome::Sync(PathBuf::from("/work/thesis")))
        );
        press(&mut picker, KeyCode::Char('j'));
        assert_eq!(
            press(&mut picker, KeyCode::Enter),
            Action::Done(Outcome::Clone("https://example.test/Paper".into()))
        );
    }

    #[test]
    fn s_and_c_only_work_on_the_matching_kind() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        assert_eq!(press(&mut picker, KeyCode::Char('c')), Action::None);
        assert!(picker.status.is_some());
        press(&mut picker, KeyCode::Char('j'));
        assert_eq!(press(&mut picker, KeyCode::Char('s')), Action::None);
        assert!(picker.status.is_some());
    }

    #[test]
    fn clone_mode_never_syncs() {
        let mut picker = Picker::new(Mode::Clone, sample(), true);
        assert_eq!(numbers(&picker), [2, 3, 4]);
        assert_eq!(press(&mut picker, KeyCode::Char('s')), Action::None);
        assert_eq!(
            press(&mut picker, KeyCode::Enter),
            Action::Done(Outcome::Clone("https://example.test/Paper".into()))
        );
        // A local project found with `m` cannot be cloned either.
        press(&mut picker, KeyCode::Char('m'));
        assert_eq!(press(&mut picker, KeyCode::Enter), Action::None);
    }

    #[test]
    fn unavailable_entries_refuse_every_action() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        press(&mut picker, KeyCode::Char('j'));
        press(&mut picker, KeyCode::Char('j'));
        assert_eq!(picker.current(), Some(2));
        for code in [
            KeyCode::Enter,
            KeyCode::Char('s'),
            KeyCode::Char('c'),
            KeyCode::Char('o'),
        ] {
            assert_eq!(press(&mut picker, code), Action::None);
            let status = picker.status.take().expect("a reason is shown");
            assert!(status.contains("removed"), "{status}");
        }
        // Local but gone on the server.
        press(&mut picker, KeyCode::Char('j'));
        press(&mut picker, KeyCode::Char('j'));
        assert_eq!(press(&mut picker, KeyCode::Enter), Action::None);
        assert!(picker.status.is_some());
    }

    #[test]
    fn open_stays_in_the_picker() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        assert_eq!(press(&mut picker, KeyCode::Char('o')), Action::Open(0));
        assert_eq!(press(&mut picker, KeyCode::Char('r')), Action::Refresh);
    }

    #[test]
    fn refresh_keeps_the_cursor_on_the_same_project() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        press(&mut picker, KeyCode::Char('j'));
        let mut fresh = sample();
        fresh.insert(0, entry("New", None, State::Listed));
        picker.replace(fresh);
        assert_eq!(picker.current(), Some(2));
        assert_eq!(picker.entries[2].title, "Paper");
    }

    fn drawn(picker: &Picker) -> String {
        super::super::drawn(80, 16, |frame| render(frame, picker))
    }

    #[test]
    fn render_shows_titles_numbers_and_places() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        picker.refreshing = true;
        let text = drawn(&picker);
        assert!(text.contains("  1. Thesis"), "{text}");
        assert!(text.contains("/work/thesis"), "{text}");
        assert!(text.contains("  2. Paper"), "{text}");
        assert!(text.contains("not on this device"), "{text}");
        assert!(text.contains("unavailable: you were removed"), "{text}");
        assert!(text.contains("refreshing..."), "{text}");
    }

    #[test]
    fn render_under_filter_keeps_full_list_numbers() {
        let mut picker = Picker::new(Mode::List, sample(), false);
        press(&mut picker, KeyCode::Char('/'));
        type_text(&mut picker, "slides");
        let text = drawn(&picker);
        assert!(text.contains("  4. Thesis slides"), "{text}");
        assert!(!text.contains("Paper"), "{text}");
    }
}
