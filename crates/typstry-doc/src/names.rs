//! Name rules, mirroring `validateName` in `apps/web/src/doc/fs-ops.ts` and
//! `normalizeBounded` in `apps/web/src/doc/names.ts`.

/// Longest file or folder name the UI accepts, in UTF-8 bytes.
pub const MAX_NAME_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("name must not be empty")]
    Empty,
    /// `.` or `..`.
    #[error("\".\" and \"..\" are reserved")]
    Reserved,
    #[error("name must not contain \"/\"")]
    Slash,
    #[error("name must not contain \"\\\"")]
    Backslash,
    #[error("name must not contain control characters")]
    ControlChar,
    #[error("name must be at most {MAX_NAME_BYTES} bytes")]
    TooLong,
    /// `.git` or `.typstry` in some spelling, see [`is_reserved_segment`].
    #[error("\".git\" and \".typstry\" are reserved")]
    ReservedName,
    /// The rest are fine on Unix but not on Windows. A project is shared
    /// across systems, so they are refused everywhere.
    #[error("name must not contain \":\"")]
    Colon,
    #[error("name must not end with a dot or a space")]
    TrailingDotOrSpace,
    /// `CON`, `NUL`, `COM1` and the like, see [`is_device_name`].
    #[error("name is reserved for a device on Windows")]
    DeviceName,
}

/// The rules for a single path segment, the same as the browser's. Windows
/// reads a backslash as a separator, so `a\b` is refused here and hidden by
/// [`crate::materialize::is_safe_path`] rather than written as a folder.
pub fn validate_name(name: &str) -> Result<(), NameError> {
    if name.is_empty() {
        return Err(NameError::Empty);
    }
    if name == "." || name == ".." {
        return Err(NameError::Reserved);
    }
    if name.contains('/') {
        return Err(NameError::Slash);
    }
    if name.contains('\\') {
        return Err(NameError::Backslash);
    }
    // char::is_control is exactly the C0, DEL and C1 range of the TS regex.
    if name.chars().any(char::is_control) {
        return Err(NameError::ControlChar);
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(NameError::TooLong);
    }
    if is_reserved_segment(name) {
        return Err(NameError::ReservedName);
    }
    portability(name)
}

/// Folders that belong to the local checkout rather than to the project:
/// git's and the CLI's (`STATE_DIR` in typstry-cli).
const RESERVED_DIRS: &[&str] = &[".git", ".typstry"];

/// Code points HFS+ drops when it compares names, so `.g\u{200c}it` is
/// `.git` there. Same list as git's `is_hfs_dotgit`.
fn is_hfs_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}'
    )
}

/// Whether a path segment names one of [`RESERVED_DIRS`] on some file
/// system.
///
/// An exact comparison is not enough: macOS and Windows ignore case by
/// default, Windows drops trailing dots and spaces and also knows `.git` by
/// its short name `GIT~1`, and HFS+ skips some invisible code points. A
/// shared file at `.GIT/config` would otherwise land in a real `.git` and
/// plant a git config, whose `core.fsmonitor` is a command git runs.
pub fn is_reserved_segment(segment: &str) -> bool {
    // Nearly every name is free of ignorable code points, and this runs for
    // every segment of every path, so only those that have one get copied.
    if segment.contains(is_hfs_ignorable) {
        let visible: String = segment.chars().filter(|&c| !is_hfs_ignorable(c)).collect();
        is_reserved_visible(&visible)
    } else {
        is_reserved_visible(segment)
    }
}

fn is_reserved_visible(visible: &str) -> bool {
    let name = visible.trim_end_matches(['.', ' ']);
    name.eq_ignore_ascii_case("git~1")
        || RESERVED_DIRS
            .iter()
            .any(|dir| name.eq_ignore_ascii_case(dir))
}

/// Whether Windows maps `segment` to a device instead of a file. It does
/// so with any extension too, so `nul.txt` is the null device, and it
/// ignores spaces before the extension.
pub fn is_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
        || ["COM", "LPT"].iter().any(|prefix| {
            // A prefix that does not end on a char boundary cannot be ASCII.
            stem.get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
                && {
                    let mut digits = stem[prefix.len()..].chars();
                    // Windows counts the superscript digits as well.
                    matches!(
                        (digits.next(), digits.next()),
                        (Some('1'..='9' | '¹' | '²' | '³'), None)
                    )
                }
        })
}

/// The rules only Windows needs. The colon matters most: `C:x` is a drive
/// relative path there and would leave the project folder.
fn portability(name: &str) -> Result<(), NameError> {
    if name.contains(':') {
        return Err(NameError::Colon);
    }
    if name.ends_with(['.', ' ']) {
        return Err(NameError::TrailingDotOrSpace);
    }
    if is_device_name(name) {
        return Err(NameError::DeviceName);
    }
    Ok(())
}

/// The first segment of a path that breaks the name rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{segment:?}: {error}")]
pub struct InvalidSegment<'a> {
    pub segment: &'a str,
    pub error: NameError,
}

/// A `/`-separated relative path is valid when every segment is, so empty
/// segments (leading, trailing or doubled slashes) are rejected too.
pub fn validate_path(path: &str) -> Result<(), InvalidSegment<'_>> {
    path.split('/').try_for_each(|segment| {
        validate_name(segment).map_err(|error| InvalidSegment { segment, error })
    })
}

/// What JS counts as whitespace in `String.trim` and `/\s/`: Unicode
/// White_Space plus the byte order mark, minus U+0085, which Rust counts and
/// JS does not.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// Trimmed `raw` when it is 1 to `max` characters long. Counts code points
/// like the TS side, so an emoji is one character.
pub fn normalize_bounded(raw: &str, max: usize) -> Option<&str> {
    let value = raw.trim_matches(is_js_whitespace);
    let len = value.chars().count();
    (1..=max).contains(&len).then_some(value)
}

/// Longest project title, in characters. Must match `MAX_TITLE_CHARS` in
/// `apps/web/src/doc/schema.ts`.
pub const MAX_TITLE_CHARS: usize = 200;

/// Trimmed project title, or None when it is not 1 to [`MAX_TITLE_CHARS`]
/// characters long. Same as `normalizeTitle` in `fs-ops.ts`, so a title
/// with a byte order mark or a NEL at either end reads the same on both
/// sides.
pub fn normalize_title(raw: &str) -> Option<&str> {
    normalize_bounded(raw, MAX_TITLE_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names_like_fs_ops() {
        for ok in [
            "main.typ",
            ".gitignore",
            ".github",
            "a b",
            "😀",
            "x~0@1.typ",
        ] {
            assert_eq!(validate_name(ok), Ok(()), "{ok}");
        }
        assert_eq!(validate_name(""), Err(NameError::Empty));
        assert_eq!(validate_name("."), Err(NameError::Reserved));
        assert_eq!(validate_name(".."), Err(NameError::Reserved));
        assert_eq!(validate_name("a/b"), Err(NameError::Slash));
        assert_eq!(validate_name("a\\b"), Err(NameError::Backslash));
        assert_eq!(validate_name("a\nb"), Err(NameError::ControlChar));
        assert_eq!(validate_name("a\u{7f}"), Err(NameError::ControlChar));
        assert_eq!(validate_name("a\u{85}"), Err(NameError::ControlChar));
        assert_eq!(validate_name(&"a".repeat(255)), Ok(()));
        assert_eq!(validate_name(&"a".repeat(256)), Err(NameError::TooLong));
        // 128 two-byte characters are 256 bytes.
        assert_eq!(validate_name(&"é".repeat(128)), Err(NameError::TooLong));
        assert_eq!(validate_name(".GIT"), Err(NameError::ReservedName));
        assert_eq!(validate_name("c:x"), Err(NameError::Colon));
        assert_eq!(validate_name("..."), Err(NameError::TrailingDotOrSpace));
        assert_eq!(validate_name("a "), Err(NameError::TrailingDotOrSpace));
        assert_eq!(validate_name("nul.txt"), Err(NameError::DeviceName));
    }

    #[test]
    fn reserves_git_and_state_dirs_in_any_spelling() {
        for name in [
            ".git",
            ".GIT",
            ".Git",
            ".git.",
            ".git ",
            ".git. .",
            "GIT~1",
            "git~1",
            ".g\u{200c}it",
            "\u{feff}.git",
            ".typstry",
            ".TypStry.",
        ] {
            assert!(is_reserved_segment(name), "{name:?}");
        }
        for name in [".gitignore", "git", ".git-x", ".github", "git~2", "a.git"] {
            assert!(!is_reserved_segment(name), "{name:?}");
        }
    }

    #[test]
    fn knows_windows_device_names() {
        for name in [
            "con",
            "CON",
            "Nul.txt",
            "nul .txt",
            "aux.tar.gz",
            "COM1",
            "lpt9.md",
            "com¹",
            "CONIN$",
        ] {
            assert!(is_device_name(name), "{name:?}");
        }
        for name in [
            "console",
            "com0",
            "com10",
            "lpt",
            "nul_",
            "x.nul",
            "connect.typ",
        ] {
            assert!(!is_device_name(name), "{name:?}");
        }
    }

    fn reserved_reference(segment: &str) -> bool {
        let visible: String = segment.chars().filter(|&c| !is_hfs_ignorable(c)).collect();
        let name = visible.trim_end_matches(['.', ' ']);
        name.eq_ignore_ascii_case("git~1")
            || RESERVED_DIRS
                .iter()
                .any(|dir| name.eq_ignore_ascii_case(dir))
    }

    fn device_reference(segment: &str) -> bool {
        let stem = segment
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        match stem.as_str() {
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
            _ => ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|n| {
                    let mut digits = n.chars();
                    matches!(
                        (digits.next(), digits.next()),
                        (Some('1'..='9' | '¹' | '²' | '³'), None)
                    )
                })
            }),
        }
    }

    proptest::proptest! {
        /// The allocation-free checks against the plain spelling of the rules.
        #[test]
        fn fast_paths_match_the_plain_rules(
            segment in "[.gGiItT~1yYsSrRpPcCoOnNuUlLmMaAxX$ \u{200c}\u{feff}\u{b9}\u{e9}0-9]{0,10}"
        ) {
            proptest::prop_assert_eq!(is_reserved_segment(&segment), reserved_reference(&segment));
            proptest::prop_assert_eq!(is_device_name(&segment), device_reference(&segment));
        }
    }

    #[test]
    fn validates_paths_segment_by_segment() {
        assert_eq!(validate_path("chapters/intro.typ"), Ok(()));
        let invalid = |segment, error| Err(InvalidSegment { segment, error });
        assert_eq!(validate_path(""), invalid("", NameError::Empty));
        assert_eq!(validate_path("/abs.typ"), invalid("", NameError::Empty));
        assert_eq!(validate_path("a//b"), invalid("", NameError::Empty));
        assert_eq!(validate_path("dir/"), invalid("", NameError::Empty));
        assert_eq!(validate_path("../x"), invalid("..", NameError::Reserved));
        assert_eq!(
            validate_path("ok/a\\b/c"),
            invalid("a\\b", NameError::Backslash)
        );
    }

    #[test]
    fn bounds_by_code_points() {
        assert_eq!(normalize_bounded("  v1 ", 100), Some("v1"));
        assert_eq!(normalize_bounded("   ", 100), None);
        assert_eq!(normalize_bounded(&"😀".repeat(3), 3), Some("😀😀😀"));
        assert_eq!(normalize_bounded(&"😀".repeat(4), 3), None);
        assert_eq!(normalize_bounded("\u{feff} v1\u{3000}", 100), Some("v1"));
        // NEL is not whitespace to JS, so it is part of the name there.
        assert_eq!(normalize_bounded("\u{85}v1", 100), Some("\u{85}v1"));
    }

    #[test]
    fn normalizes_titles_like_the_browser() {
        assert_eq!(normalize_title(" Thesis \u{feff}"), Some("Thesis"));
        assert_eq!(normalize_title("\u{feff}"), None);
        assert_eq!(normalize_title("\u{85}"), Some("\u{85}"));
        assert_eq!(
            normalize_title(&"t".repeat(MAX_TITLE_CHARS)).map(str::len),
            Some(200)
        );
        assert_eq!(normalize_title(&"t".repeat(MAX_TITLE_CHARS + 1)), None);
    }
}
