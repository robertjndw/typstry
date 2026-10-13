//! A list to pick one entry from and act on it, for `members` and `devices`.
//!
//! [`Chooser`] holds the state and turns keys into [`Action`]s without
//! touching the terminal, so the rules can be tested; [`choose`] owns the
//! terminal and the event loop around it. What the chosen action does
//! happens after the view has closed, on the normal terminal, so any
//! question it asks or line it prints behaves as in plain mode.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use ratatui::widgets::{ListItem, ListState, Paragraph};

/// One row. A row without a value is a heading the cursor skips.
pub struct Item<T> {
    pub line: Line<'static>,
    /// A dim second line under the row.
    pub detail: Option<Line<'static>>,
    pub value: Option<T>,
}

/// An action offered on the selected row.
#[derive(Debug, Clone, Copy)]
pub struct Key {
    pub key: char,
    pub label: &'static str,
}

/// Keys the view keeps for itself.
const RESERVED: [char; 4] = ['j', 'k', 'q', '?'];

#[derive(Debug, PartialEq, Eq)]
enum Action<T> {
    None,
    Done(Option<(char, T)>),
}

struct Chooser<T> {
    title: String,
    items: Vec<Item<T>>,
    keys: Vec<Key>,
    note: Option<String>,
    /// Index into `items`, always at a selectable row when there is one.
    selected: Option<usize>,
    help: bool,
}

impl<T: Clone> Chooser<T> {
    fn new(title: &str, items: Vec<Item<T>>, keys: &[Key], note: Option<String>) -> Self {
        debug_assert!(keys.iter().all(|k| !RESERVED.contains(&k.key)));
        let selected = items.iter().position(|i| i.value.is_some());
        Self {
            title: title.to_owned(),
            items,
            keys: keys.to_vec(),
            note,
            selected,
            help: false,
        }
    }

    /// Moves to the next selectable row in the direction; stays put at
    /// either end instead of wrapping.
    fn step(&mut self, down: bool) {
        let Some(from) = self.selected else {
            return;
        };
        let next = if down {
            (from + 1..self.items.len()).find(|&i| self.items[i].value.is_some())
        } else {
            (0..from).rev().find(|&i| self.items[i].value.is_some())
        };
        if next.is_some() {
            self.selected = next;
        }
    }

    fn pick(&self, key: char) -> Action<T> {
        let value = self
            .selected
            .and_then(|i| self.items[i].value.clone())
            .map(|value| (key, value));
        match value {
            Some(chosen) => Action::Done(Some(chosen)),
            None => Action::None,
        }
    }

    fn on_key(&mut self, key: KeyEvent) -> Action<T> {
        // Windows also reports releases; acting on both would double every key.
        if key.kind == KeyEventKind::Release {
            return Action::None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Action::Done(None);
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.step(false),
            KeyCode::Down | KeyCode::Char('j') => self.step(true),
            KeyCode::Char('?') => self.help = !self.help,
            KeyCode::Esc | KeyCode::Char('q') => return Action::Done(None),
            KeyCode::Char(c)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && self.keys.iter().any(|k| k.key == c) =>
            {
                return self.pick(c);
            }
            _ => {}
        }
        Action::None
    }

    fn hints(&self) -> String {
        let mut hints = String::from("j/k move");
        for key in &self.keys {
            hints.push_str(&format!("  {} {}", key.key, key.label));
        }
        hints.push_str("  ? help  q quit");
        hints
    }

    // Enter does nothing on purpose: every key offered here removes or
    // revokes something, and Enter is pressed out of habit.
    fn help_text(&self) -> String {
        if self.keys.is_empty() {
            "up/down or j/k move, esc or q leaves".to_owned()
        } else {
            "up/down or j/k move, esc or q leaves without doing anything".to_owned()
        }
    }
}

fn render<T: Clone>(frame: &mut Frame, chooser: &Chooser<T>) {
    let [header, body, status, keys] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(if chooser.help { 2 } else { 1 }),
    ])
    .areas(frame.area());

    frame.render_widget(Line::from(Span::from(chooser.title.clone()).bold()), header);

    if chooser.items.is_empty() {
        frame.render_widget(Paragraph::new("Nothing to show.").dim(), body);
    } else {
        let items = chooser.items.iter().map(|item| {
            let mut lines = vec![item.line.clone()];
            if let Some(detail) = &item.detail {
                lines.push(detail.clone().dim());
            }
            ListItem::new(lines)
        });
        let list = super::highlight_list(items);
        let mut state = ListState::default().with_selected(chooser.selected);
        frame.render_stateful_widget(list, body, &mut state);
    }

    frame.render_widget(Line::from(chooser.note.clone().unwrap_or_default()), status);
    frame.render_widget(
        super::footer(chooser.hints(), chooser.help.then(|| chooser.help_text())),
        keys,
    );
}

/// Shows the rows until the person presses one of `keys` on a selectable
/// row (the key and the row's value come back) or leaves (`None`). Enter
/// is not a shortcut for any key, since they are all destructive. `note` is
/// shown on the status line, e.g. to say why there are no keys. The terminal
/// is restored before this returns.
pub async fn choose<T: Clone>(
    title: &str,
    items: Vec<Item<T>>,
    keys: &[Key],
    note: Option<String>,
) -> anyhow::Result<Option<(char, T)>> {
    let mut chooser = Chooser::new(title, items, keys, note);
    super::run_view(
        &mut chooser,
        render,
        |chooser, key| match chooser.on_key(key) {
            Action::Done(chosen) => Some(chosen),
            Action::None => None,
        },
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(text: &str, value: Option<u32>) -> Item<u32> {
        Item {
            line: Line::from(text.to_owned()),
            detail: None,
            value,
        }
    }

    fn sample() -> Vec<Item<u32>> {
        vec![
            row("Heading A", None),
            row("one", Some(1)),
            row("two", Some(2)),
            row("Heading B", None),
            row("three", Some(3)),
        ]
    }

    const D: Key = Key {
        key: 'd',
        label: "remove",
    };

    fn chooser(keys: &[Key]) -> Chooser<u32> {
        Chooser::new("things", sample(), keys, None)
    }

    fn press(chooser: &mut Chooser<u32>, code: KeyCode) -> Action<u32> {
        chooser.on_key(KeyEvent::from(code))
    }

    #[test]
    fn starts_on_the_first_selectable_row() {
        assert_eq!(chooser(&[D]).selected, Some(1));
        let only_headings = Chooser::<u32>::new("t", vec![row("H", None)], &[D], None);
        assert_eq!(only_headings.selected, None);
    }

    #[test]
    fn cursor_skips_headings_and_stops_at_the_ends() {
        let mut c = chooser(&[D]);
        press(&mut c, KeyCode::Char('j'));
        assert_eq!(c.selected, Some(2));
        press(&mut c, KeyCode::Down);
        assert_eq!(c.selected, Some(4));
        press(&mut c, KeyCode::Char('j'));
        assert_eq!(c.selected, Some(4));
        press(&mut c, KeyCode::Char('k'));
        press(&mut c, KeyCode::Up);
        assert_eq!(c.selected, Some(1));
        press(&mut c, KeyCode::Char('k'));
        assert_eq!(c.selected, Some(1));
    }

    #[test]
    fn keys_return_the_selected_value() {
        let mut c = chooser(&[D]);
        press(&mut c, KeyCode::Char('j'));
        assert_eq!(
            press(&mut c, KeyCode::Char('d')),
            Action::Done(Some(('d', 2)))
        );
        // Enter never stands in for a key, which would make removing
        // someone one habitual keystroke away.
        assert_eq!(press(&mut c, KeyCode::Enter), Action::None);
        // Keys that are not offered do nothing.
        assert_eq!(press(&mut c, KeyCode::Char('x')), Action::None);
    }

    #[test]
    fn without_keys_nothing_can_be_chosen() {
        let mut c = chooser(&[]);
        assert_eq!(press(&mut c, KeyCode::Enter), Action::None);
        assert_eq!(press(&mut c, KeyCode::Char('d')), Action::None);
    }

    #[test]
    fn nothing_selected_means_nothing_chosen() {
        let mut c = Chooser::<u32>::new("t", vec![row("H", None)], &[D], None);
        assert_eq!(press(&mut c, KeyCode::Char('d')), Action::None);
        let mut empty = Chooser::<u32>::new("t", Vec::new(), &[D], None);
        assert_eq!(press(&mut empty, KeyCode::Enter), Action::None);
        press(&mut empty, KeyCode::Char('j'));
    }

    #[test]
    fn quitting_and_releases() {
        let mut c = chooser(&[D]);
        for code in [KeyCode::Char('q'), KeyCode::Esc] {
            assert_eq!(press(&mut c, code), Action::Done(None));
        }
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(c.on_key(ctrl_c), Action::Done(None));
        let mut release = KeyEvent::from(KeyCode::Char('d'));
        release.kind = KeyEventKind::Release;
        assert_eq!(c.on_key(release), Action::None);
    }

    fn drawn(chooser: &Chooser<u32>) -> String {
        super::super::drawn(80, 12, |frame| render(frame, chooser))
    }

    #[test]
    fn render_shows_rows_hints_and_note() {
        let mut items = sample();
        items[1].detail = Some(Line::from("more about one"));
        let c = Chooser::new("things", items, &[D], Some("be careful".into()));
        let text = drawn(&c);
        assert!(text.contains("things"), "{text}");
        assert!(text.contains("Heading A"), "{text}");
        assert!(text.contains("> one"), "{text}");
        assert!(text.contains("more about one"), "{text}");
        assert!(text.contains("be careful"), "{text}");
        assert!(
            text.contains("j/k move  d remove  ? help  q quit"),
            "{text}"
        );
    }

    #[test]
    fn render_of_an_empty_list_says_so() {
        let c = Chooser::<u32>::new("things", Vec::new(), &[], None);
        let text = drawn(&c);
        assert!(text.contains("Nothing to show."), "{text}");
        assert!(text.contains("j/k move  ? help  q quit"), "{text}");
    }
}
