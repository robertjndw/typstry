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

/// Paths that only differ in case, which a case-insensitive file system
/// stores as one file. One path of each group is kept: the first one
/// `prefer` accepts, else the first in sorted order. Returns `(kept,
/// dropped)` pairs.
pub fn case_clashes<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    prefer: impl Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut groups: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for path in paths {
        groups.entry(path.to_lowercase()).or_default().insert(path);
    }
    let mut clashes = Vec::new();
    for group in groups.values().filter(|g| g.len() > 1) {
        let kept = group
            .iter()
            .find(|p| prefer(p))
            .or_else(|| group.first())
            .expect("groups are not empty");
        for path in group.iter().filter(|p| *p != kept) {
            clashes.push(((*kept).to_owned(), (*path).to_owned()));
        }
    }
    clashes
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
}
