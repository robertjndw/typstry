//! The named versions of `typstry version list`, to export or add to.
//!
//! [`Versions`] holds the state and turns keys into [`Action`]s without
//! touching the terminal; [`choose`] owns the terminal and the event loop.

use std::path::{Path, PathBuf};

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use ratatui::widgets::{ListItem, ListState, Paragraph};
use typstry_doc::versions::named_versions;

use crate::commands::version::{author_name, format_ms, valid_version_name};

/// One listed version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub index: usize,
    pub date: String,
    pub name: String,
    pub author: String,
}

/// The versions of the doc, newest first like the plain listing.
pub fn rows(doc: &loro::LoroDoc) -> Vec<Row> {
    let mut versions = named_versions(doc);
    versions.sort_by_key(|v| std::cmp::Reverse((v.created_at, v.index)));
    versions
        .into_iter()
        .map(|v| Row {
            index: v.index,
            date: format_ms(v.created_at),
            author: author_name(doc, &v.author),
            name: v.name,
        })
        .collect()
}

/// What the person chose. The view has left the terminal by then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Export the version with this index to this folder, relative to the
    /// project folder.
    Export {
        index: usize,
        dir: String,
    },
    /// Save the current state under this (validated) name.
    Save(String),
    Quit,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    None,
    Done(Outcome),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Input {
    None,
    /// Version index being exported.
    Export(usize),
    Save,
}

/// A folder name for exporting `version` next to the project: safe on every
/// file system whatever the version is called.
pub fn export_name(project: &str, version: &str) -> String {
    let mut slug = String::new();
    for c in version.chars() {
        if c.is_alphanumeric() {
            slug.extend(c.to_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "version" } else { slug };
    format!("../{project}-{slug}")
}

struct Versions {
    rows: Vec<Row>,
    can_write: bool,
    /// The project folder, for finding a default export folder that is free.
    root: PathBuf,
    project: String,
    selected: usize,
    input: Input,
    text: String,
    help: bool,
    status: Option<String>,
}

impl Versions {
    fn new(rows: Vec<Row>, can_write: bool, root: PathBuf, project: String) -> Self {
        Self {
            rows,
            can_write,
            root,
            project,
            selected: 0,
            input: Input::None,
            text: String::new(),
            help: false,
            status: None,
        }
    }

    fn step(&mut self, down: bool) {
        self.selected = super::step(self.selected, self.rows.len(), down);
    }

    /// Why the typed text cannot be used yet. Only saving restricts it.
    fn input_error(&self) -> Option<String> {
        match self.input {
            Input::Save if !self.text.is_empty() => {
                valid_version_name(&self.text).err().map(|e| e.to_string())
            }
            _ => None,
        }
    }

    fn on_key(&mut self, key: KeyEvent) -> Action {
        // Windows also reports releases; acting on both would double every key.
        if key.kind == KeyEventKind::Release {
            return Action::None;
        }
        self.status = None;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('c') {
            return Action::Done(Outcome::Quit);
        }
        if self.input != Input::None {
            return self.on_input_key(key);
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.step(false),
            KeyCode::Down | KeyCode::Char('j') => self.step(true),
            KeyCode::Char('?') => self.help = !self.help,
            KeyCode::Char('e') | KeyCode::Enter => self.start_export(),
            KeyCode::Char('n') => self.start_save(),
            KeyCode::Esc | KeyCode::Char('q') => return Action::Done(Outcome::Quit),
            _ => {}
        }
        Action::None
    }

    fn start_export(&mut self) {
        let Some(row) = self.rows.get(self.selected) else {
            return;
        };
        let mut candidate = export_name(&self.project, &row.name);
        let base = candidate.clone();
        let mut n = 2;
        // A taken default would only fail after the view has closed.
        while self.root.join(&candidate).exists() {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        self.input = Input::Export(row.index);
        self.text = candidate;
    }

    fn start_save(&mut self) {
        if !self.can_write {
            self.status = Some("saving a version needs the edit link".into());
            return;
        }
        self.input = Input::Save;
        self.text.clear();
    }

    fn on_input_key(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Esc => {
                self.input = Input::None;
                self.text.clear();
            }
            KeyCode::Enter => return self.accept(),
            KeyCode::Backspace => {
                self.text.pop();
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.text.clear();
            }
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.text.push(c);
            }
            _ => {}
        }
        Action::None
    }

    fn accept(&mut self) -> Action {
        match self.input {
            Input::Export(index) => {
                let dir = self.text.trim();
                if dir.is_empty() {
                    self.status = Some("a folder is needed".into());
                    return Action::None;
                }
                Action::Done(Outcome::Export {
                    index,
                    dir: dir.to_owned(),
                })
            }
            Input::Save => match valid_version_name(&self.text) {
                Ok(name) => Action::Done(Outcome::Save(name)),
                Err(err) => {
                    self.status = Some(err.to_string());
                    Action::None
                }
            },
            Input::None => Action::None,
        }
    }
}

fn hints(versions: &Versions) -> &'static str {
    match versions.input {
        Input::None => "j/k move  e/enter export  n new version  ? help  q quit",
        Input::Export(_) | Input::Save => "enter accept  esc cancel  ctrl+u clear",
    }
}

const HELP: &str = "up/down or j/k move, e or enter export the selected version to a new folder, \
n name the current state as a new version";

fn render(frame: &mut Frame, versions: &Versions) {
    let [header, body, status, prompt, keys] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(if versions.help { 2 } else { 1 }),
    ])
    .areas(frame.area());

    frame.render_widget(Line::from(Span::from("typstry versions").bold()), header);

    if versions.rows.is_empty() {
        let text = if versions.can_write {
            "No named versions yet. Press n to save the current state as one."
        } else {
            "No named versions yet."
        };
        frame.render_widget(Paragraph::new(text).dim(), body);
    } else {
        let items = versions.rows.iter().map(|row| {
            ListItem::new(Line::from(vec![
                Span::from(format!("#{:<3} {}  {}  ", row.index, row.date, row.name)),
                Span::from(format!("({})", row.author)).dim(),
            ]))
        });
        let list = super::highlight_list(items);
        let mut state = ListState::default().with_selected(Some(versions.selected));
        frame.render_stateful_widget(list, body, &mut state);
    }

    let note = versions
        .input_error()
        .or_else(|| versions.status.clone())
        .unwrap_or_default();
    frame.render_widget(Line::from(note), status);

    let label = match versions.input {
        Input::None => None,
        Input::Export(_) => Some("Export to folder: "),
        Input::Save => Some("New version name: "),
    };
    if let Some(label) = label {
        frame.render_widget(
            Line::from(vec![
                Span::from(label).bold(),
                Span::from(versions.text.as_str()),
                Span::from("_"),
            ]),
            prompt,
        );
    }

    frame.render_widget(
        super::footer(hints(versions), versions.help.then_some(HELP)),
        keys,
    );
}

/// Shows the versions until the person picks an action or quits. The
/// terminal is restored before this returns.
pub async fn choose(
    rows: Vec<Row>,
    can_write: bool,
    root: &Path,
    project: String,
) -> anyhow::Result<Outcome> {
    let mut versions = Versions::new(rows, can_write, root.to_owned(), project);
    super::run_view(
        &mut versions,
        render,
        |versions, key| match versions.on_key(key) {
            Action::Done(outcome) => Some(outcome),
            Action::None => None,
        },
        Outcome::Quit,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(index: usize, name: &str) -> Row {
        Row {
            index,
            date: "2024-01-02 03:04 UTC".into(),
            name: name.into(),
            author: "Ada".into(),
        }
    }

    fn sample(can_write: bool) -> Versions {
        Versions::new(
            vec![row(2, "Final draft"), row(1, "First")],
            can_write,
            PathBuf::from("/nonexistent/typstry-test"),
            "thesis".into(),
        )
    }

    fn press(v: &mut Versions, code: KeyCode) -> Action {
        v.on_key(KeyEvent::from(code))
    }

    fn type_text(v: &mut Versions, text: &str) {
        for c in text.chars() {
            press(v, KeyCode::Char(c));
        }
    }

    #[test]
    fn selection_moves_and_clamps() {
        let mut v = sample(true);
        press(&mut v, KeyCode::Up);
        assert_eq!(v.selected, 0);
        for _ in 0..5 {
            press(&mut v, KeyCode::Char('j'));
        }
        assert_eq!(v.selected, 1);
        press(&mut v, KeyCode::Char('k'));
        assert_eq!(v.selected, 0);
    }

    #[test]
    fn export_names_are_safe() {
        assert_eq!(
            export_name("thesis", "Final draft"),
            "../thesis-final-draft"
        );
        assert_eq!(export_name("p", "a/b\\c: d"), "../p-a-b-c-d");
        assert_eq!(export_name("p", "  v1.0!! "), "../p-v1-0");
        assert_eq!(export_name("p", "Überarbeitung ✓"), "../p-überarbeitung");
        assert_eq!(export_name("p", "///"), "../p-version");
        assert_eq!(export_name("p", "..\\.."), "../p-version");
    }

    #[test]
    fn export_prompt_starts_with_the_default_and_edits() {
        let mut v = sample(true);
        press(&mut v, KeyCode::Char('e'));
        assert_eq!(v.input, Input::Export(2));
        assert_eq!(v.text, "../thesis-final-draft");
        // Letters are text now, not commands.
        press(&mut v, KeyCode::Backspace);
        type_text(&mut v, "q");
        assert_eq!(v.text, "../thesis-final-drafq");
        v.on_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        assert!(v.text.is_empty());
        assert_eq!(press(&mut v, KeyCode::Enter), Action::None);
        assert!(v.status.is_some());
        type_text(&mut v, "out");
        assert_eq!(
            press(&mut v, KeyCode::Enter),
            Action::Done(Outcome::Export {
                index: 2,
                dir: "out".into()
            })
        );
    }

    #[test]
    fn enter_exports_the_selected_row() {
        let mut v = sample(true);
        press(&mut v, KeyCode::Down);
        press(&mut v, KeyCode::Enter);
        assert_eq!(v.input, Input::Export(1));
        assert_eq!(
            press(&mut v, KeyCode::Enter),
            Action::Done(Outcome::Export {
                index: 1,
                dir: "../thesis-first".into()
            })
        );
    }

    #[test]
    fn escape_cancels_the_prompt_then_quits() {
        let mut v = sample(true);
        press(&mut v, KeyCode::Char('n'));
        assert_eq!(press(&mut v, KeyCode::Esc), Action::None);
        assert_eq!(v.input, Input::None);
        assert_eq!(press(&mut v, KeyCode::Esc), Action::Done(Outcome::Quit));
    }

    #[test]
    fn invalid_names_block_enter() {
        let mut v = sample(true);
        press(&mut v, KeyCode::Char('n'));
        assert_eq!(press(&mut v, KeyCode::Enter), Action::None);
        assert!(v.status.is_some());
        type_text(&mut v, "   ");
        assert!(v.input_error().is_some());
        assert_eq!(press(&mut v, KeyCode::Enter), Action::None);
        type_text(&mut v, " Release 1 ");
        assert_eq!(
            press(&mut v, KeyCode::Enter),
            Action::Done(Outcome::Save("Release 1".into()))
        );
        let mut v = sample(true);
        press(&mut v, KeyCode::Char('n'));
        type_text(&mut v, &"x".repeat(500));
        assert!(v.input_error().is_some());
        assert_eq!(press(&mut v, KeyCode::Enter), Action::None);
    }

    #[test]
    fn view_only_folders_cannot_save() {
        let mut v = sample(false);
        press(&mut v, KeyCode::Char('n'));
        assert_eq!(v.input, Input::None);
        assert_eq!(
            v.status.as_deref(),
            Some("saving a version needs the edit link")
        );
    }

    #[test]
    fn empty_list_still_saves_and_never_exports() {
        let mut v = Versions::new(vec![], true, PathBuf::from("/x"), "p".into());
        press(&mut v, KeyCode::Down);
        press(&mut v, KeyCode::Enter);
        assert_eq!(v.input, Input::None);
        press(&mut v, KeyCode::Char('n'));
        type_text(&mut v, "first");
        assert_eq!(
            press(&mut v, KeyCode::Enter),
            Action::Done(Outcome::Save("first".into()))
        );
    }

    #[test]
    fn ctrl_c_and_q_quit() {
        let mut v = sample(true);
        assert_eq!(
            press(&mut v, KeyCode::Char('q')),
            Action::Done(Outcome::Quit)
        );
        press(&mut v, KeyCode::Char('n'));
        assert_eq!(
            v.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Action::Done(Outcome::Quit)
        );
    }

    fn drawn(v: &Versions) -> String {
        super::super::drawn(80, 12, |frame| render(frame, v))
    }

    #[test]
    fn render_shows_rows_prompt_and_error() {
        let mut v = sample(true);
        let text = drawn(&v);
        assert!(
            text.contains("#2   2024-01-02 03:04 UTC  Final draft  (Ada)"),
            "{text}"
        );
        assert!(text.contains("e/enter export"), "{text}");
        press(&mut v, KeyCode::Char('e'));
        let text = drawn(&v);
        assert!(
            text.contains("Export to folder: ../thesis-final-draft_"),
            "{text}"
        );
        press(&mut v, KeyCode::Esc);
        press(&mut v, KeyCode::Char('n'));
        type_text(&mut v, &" ".repeat(2));
        let text = drawn(&v);
        assert!(text.contains("New version name:"), "{text}");
        assert!(text.contains("a version name must be 1 to"), "{text}");
    }

    #[test]
    fn render_empty_list() {
        let v = Versions::new(vec![], true, PathBuf::from("/x"), "p".into());
        assert!(drawn(&v).contains("No named versions yet"));
    }
}
