//! Telling text from assets the way the browser's upload does, and the
//! hashes and names that go with it.

use std::collections::{BTreeMap, BTreeSet};

use typstry_wire::crypto::SEAL_OVERHEAD;

use crate::api::MAX_UPLOAD_BYTES;

/// Same cutoff as `MAX_TEXT_BYTES` in `apps/web/src/assets/upload.ts`:
/// larger files go to the blob store so they do not bloat every peer's
/// history forever.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// Largest asset that still fits the server's limit once sealed, like
/// `MAX_ASSET_BYTES` in the web app.
pub const MAX_ASSET_BYTES: usize = MAX_UPLOAD_BYTES - SEAL_OVERHEAD;

/// The text of a file that can be a text node: valid UTF-8, no NUL bytes
/// (which no text format has, but many binaries that happen to decode do),
/// and at most [`MAX_TEXT_BYTES`]. Line endings are kept as they are, so a
/// file round-trips byte for byte and git sees no spurious changes.
pub fn as_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > MAX_TEXT_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Mime type by extension, the table of `apps/web/src/assets/file-types.ts`.
pub fn mime_for(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    // A leading dot does not start an extension: ".gitignore" has none.
    let ext = match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_ascii_lowercase(),
        _ => return "application/octet-stream",
    };
    match ext.as_str() {
        "typ" => "text/x-typst",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "ttc" | "otc" => "font/collection",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "bib" => "application/x-bibtex",
        "csv" => "text/csv",
        "json" => "application/json",
        "yml" | "yaml" => "application/yaml",
        "toml" => "application/toml",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "md" => "text/markdown",
        _ => "application/octet-stream",
    }
}

/// Paths that a case-insensitive file system stores as one file, because
/// they, or one of the folders on their way, differ only in case. With
/// `Fig/a.png` and `fig/b.png` both end up in one folder, so only one
/// spelling of each name is kept: the first one `prefer` accepts, else the
/// first in sorted order. Returns `(kept, dropped)` pairs, where `kept` is
/// the kept file, or the kept folder with a trailing `/` when the clash is
/// in a folder name.
pub fn case_clashes<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    prefer: impl Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut alive: BTreeSet<&str> = paths.into_iter().collect();
    let depth = alive
        .iter()
        .map(|p| p.split('/').count())
        .max()
        .unwrap_or(0);
    let mut clashes = Vec::new();
    // Shallowest first, so a path under a dropped folder spelling is
    // reported once, for the folder.
    for level in 1..=depth {
        let mut groups: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
        for path in &alive {
            if let Some(prefix) = prefix(path, level) {
                groups
                    .entry(prefix.to_lowercase())
                    .or_default()
                    .insert(prefix);
            }
        }
        let mut dropped = Vec::new();
        for group in groups.values().filter(|g| g.len() > 1) {
            let kept = *group
                .iter()
                .find(|p| prefer(p))
                .or_else(|| group.first())
                .expect("groups are not empty");
            let shown = if alive.contains(kept) {
                kept.to_owned()
            } else {
                format!("{kept}/")
            };
            for path in &alive {
                if prefix(path, level).is_some_and(|p| p != kept && group.contains(p)) {
                    clashes.push((shown.clone(), (*path).to_owned()));
                    dropped.push(*path);
                }
            }
        }
        for path in dropped {
            alive.remove(path);
        }
    }
    clashes
}

/// The first `level` segments of `path`, or None when it has fewer.
fn prefix(path: &str, level: usize) -> Option<&str> {
    let mut slashes = path.match_indices('/').map(|(i, _)| i);
    match slashes.nth(level - 1) {
        Some(end) => Some(&path[..end]),
        None => (path.split('/').count() == level).then_some(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_like_the_browser() {
        assert_eq!(as_text(b"= Hi\r\n".to_vec()).as_deref(), Some("= Hi\r\n"));
        assert_eq!(as_text(vec![0xff, 0xfe]), None);
        assert_eq!(as_text(b"a\0b".to_vec()), None);
        assert_eq!(as_text(vec![b'a'; MAX_TEXT_BYTES + 1]), None);
        assert_eq!(mime_for("fig/Logo.PNG"), "image/png");
        assert_eq!(mime_for(".png"), "application/octet-stream");
        assert_eq!(mime_for("README"), "application/octet-stream");
    }

    #[test]
    fn finds_case_clashes() {
        assert_eq!(
            case_clashes(["b.typ", "main.typ", "Main.typ"], |_| false),
            [("Main.typ".to_owned(), "main.typ".to_owned())]
        );
        assert_eq!(
            case_clashes(["b.typ", "main.typ", "Main.typ"], |p| p == "main.typ"),
            [("main.typ".to_owned(), "Main.typ".to_owned())]
        );
    }

    #[test]
    fn finds_case_clashes_in_folder_names() {
        let pairs = |kept: &str, dropped: &str| (kept.to_owned(), dropped.to_owned());
        assert_eq!(
            case_clashes(["Fig/a.png", "fig/b.png", "fig/c.png", "main.typ"], |_| {
                false
            }),
            [pairs("Fig/", "fig/b.png"), pairs("Fig/", "fig/c.png")]
        );
        // The spelling already on disk wins, also for folders.
        assert_eq!(
            case_clashes(["Fig/a.png", "fig/b.png"], |p| p == "fig"),
            [pairs("fig/", "Fig/a.png")]
        );
        assert_eq!(
            case_clashes(["a/Fig/x.png", "a/fig/x.png", "a/fig/y.png"], |_| false),
            [
                pairs("a/Fig/", "a/fig/x.png"),
                pairs("a/Fig/", "a/fig/y.png")
            ]
        );
        // A file and a folder of the same name clash too.
        assert_eq!(
            case_clashes(["fig", "Fig/a.png"], |_| false),
            [pairs("Fig/", "fig")]
        );
        assert!(case_clashes(["a/x.typ", "b/x.typ"], |_| false).is_empty());
    }
}
