//! Name rules, mirroring `validateName` in `apps/web/src/doc/fs-ops.ts` and
//! `normalizeBounded` in `apps/web/src/doc/names.ts`.

use std::fmt;

/// Longest file or folder name the UI accepts, in UTF-8 bytes.
pub const MAX_NAME_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameError {
    Empty,
    /// `.` or `..`.
    Reserved,
    Slash,
    Backslash,
    ControlChar,
    TooLong,
    /// `.git` or `.typstry` in some spelling, see [`is_reserved_segment`].
    ReservedName,
    /// The rest are fine on Unix but not on Windows. A project is shared
    /// across systems, so they are refused everywhere.
    Colon,
    TrailingDotOrSpace,
    /// `CON`, `NUL`, `COM1` and the like, see [`is_device_name`].
    DeviceName,
}

impl fmt::Display for NameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Empty => "name must not be empty",
            Self::Reserved => "\".\" and \"..\" are reserved",
            Self::Slash => "name must not contain \"/\"",
            Self::Backslash => "name must not contain \"\\\"",
            Self::ControlChar => "name must not contain control characters",
            Self::TooLong => "name must be at most 255 bytes",
            Self::ReservedName => "\".git\" and \".typstry\" are reserved",
            Self::Colon => "name must not contain \":\"",
            Self::TrailingDotOrSpace => "name must not end with a dot or a space",
            Self::DeviceName => "name is reserved for a device on Windows",
        })
    }
}

impl std::error::Error for NameError {}

/// The browser's rules for a single path segment, plus a ban on backslashes.
/// The browser allows those, but [`crate::materialize::is_safe_path`] treats
/// them as separators, so a file named `a\b` would never come back out of
/// `materialize` and a push of it could not round-trip.
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
    let visible: String = segment.chars().filter(|&c| !is_hfs_ignorable(c)).collect();
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
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                let mut digits = n.chars();
                // Windows counts the superscript digits as well.
                matches!(
                    (digits.next(), digits.next()),
                    (Some('1'..='9' | '¹' | '²' | '³'), None)
                )
            })
        }),
    }
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

/// The part of [`validate_name`] that [`crate::materialize::is_safe_path`]
/// adds on top of its own checks.
pub(crate) fn is_portable_segment(segment: &str) -> bool {
    !is_reserved_segment(segment) && portability(segment).is_ok()
}

/// The first segment of a path that breaks the name rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidSegment<'a> {
    pub segment: &'a str,
    pub error: NameError,
}

impl fmt::Display for InvalidSegment<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.segment, self.error)
    }
}

impl std::error::Error for InvalidSegment<'_> {}

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
}
