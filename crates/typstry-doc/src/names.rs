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
    Ok(())
}

/// Trimmed `raw` when it is 1 to `max` characters long. Counts code points
/// like the TS side, so an emoji is one character.
pub fn normalize_bounded(raw: &str, max: usize) -> Option<&str> {
    // JS String.trim also strips the byte order mark, Rust's trim does not.
    let value = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let len = value.chars().count();
    (1..=max).contains(&len).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names_like_fs_ops() {
        for ok in ["main.typ", ".gitignore", "...", "a b", "😀", "x~0@1.typ"] {
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
    }

    #[test]
    fn bounds_by_code_points() {
        assert_eq!(normalize_bounded("  v1 ", 100), Some("v1"));
        assert_eq!(normalize_bounded("   ", 100), None);
        assert_eq!(normalize_bounded(&"😀".repeat(3), 3), Some("😀😀😀"));
        assert_eq!(normalize_bounded(&"😀".repeat(4), 3), None);
    }
}
