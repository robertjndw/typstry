//! The `peers` map: who is behind a peer id, so history can name authors.
//! Mirrors `ProjectDoc.setPeer` in `apps/web/src/doc/schema.ts`, and the
//! name rules of `apps/web/src/presence/identity.ts`.

use std::collections::HashMap;

use loro::{LoroDoc, LoroResult, LoroValue};

use crate::names::is_js_whitespace;
use crate::{peer, root};

/// The browser's avatar colors, `PALETTE` in identity.ts.
pub const PALETTE: [&str; 10] = [
    "#c2410c", "#b91c1c", "#be185d", "#7e22ce", "#4338ca", "#1d4ed8", "#0e7490", "#047857",
    "#4d7c0f", "#a16207",
];

/// Longest display name, in UTF-16 code units like `MAX_NAME_LENGTH` in
/// identity.ts.
pub const MAX_PEER_NAME_UTF16: usize = 40;

/// A display name as `normalizeName` in identity.ts leaves it: trimmed,
/// whitespace runs collapsed to one space, cut to [`MAX_PEER_NAME_UTF16`]
/// units. May be empty; the browser then treats the name as unset.
pub fn normalize_peer_name(raw: &str) -> String {
    let mut out = String::new();
    let mut units = 0;
    for word in raw.split(is_js_whitespace).filter(|w| !w.is_empty()) {
        // JS slices after collapsing, so a separator can end up as the last
        // character.
        let separator = (!out.is_empty()).then_some(' ');
        for c in separator.into_iter().chain(word.chars()) {
            let len = c.len_utf16();
            if units + len > MAX_PEER_NAME_UTF16 {
                if units < MAX_PEER_NAME_UTF16 {
                    // JS keeps the high half of a surrogate pair cut in two,
                    // which turns into U+FFFD once Loro stores it as UTF-8.
                    out.push(char::REPLACEMENT_CHARACTER);
                }
                return out;
            }
            out.push(c);
            units += len;
        }
    }
    out
}

/// Commit origin of peer info, `PEER_INFO_ORIGIN` in schema.ts. The
/// browser's undo manager skips it.
pub const PEER_INFO_ORIGIN: &str = "typstry:peer-info";

/// Writes `name` and `color` under the doc's own peer id. Commits only when
/// the entry actually changes, so repeated runs do not grow the history.
pub fn set_peer(doc: &LoroDoc, name: &str, color: &str) -> LoroResult<()> {
    let peers = doc.get_map(root::PEERS);
    let key = doc.peer_id().to_string();
    let value: LoroValue = HashMap::from([
        (peer::NAME.to_owned(), LoroValue::from(name)),
        (peer::COLOR.to_owned(), LoroValue::from(color)),
    ])
    .into();
    let current = peers.get(&key).and_then(|v| v.into_value().ok());
    if current.as_ref() == Some(&value) {
        return Ok(());
    }
    peers.insert(&key, value)?;
    doc.set_next_commit_message("set peer info");
    doc.set_next_commit_origin(PEER_INFO_ORIGIN);
    doc.commit();
    Ok(())
}

/// The display name registered for `peer` (a decimal peer id), if any.
pub fn peer_name(doc: &LoroDoc, peer: &str) -> Option<String> {
    match doc.get_map(root::PEERS).get(peer)?.into_value().ok()? {
        LoroValue::Map(map) => match map.get(peer::NAME) {
            Some(LoroValue::String(name)) => Some(name.to_string()),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_once_and_reads_back() {
        let doc = LoroDoc::new();
        doc.set_peer_id(42).unwrap();
        set_peer(&doc, "Ada", "#c2410c").unwrap();
        let version = doc.oplog_vv();
        set_peer(&doc, "Ada", "#c2410c").unwrap();
        assert_eq!(doc.oplog_vv(), version);
        assert_eq!(peer_name(&doc, "42").as_deref(), Some("Ada"));
        assert_eq!(peer_name(&doc, "7"), None);
    }

    #[test]
    fn normalizes_names_like_identity_ts() {
        assert_eq!(normalize_peer_name("  Ada \t\n Lovelace "), "Ada Lovelace");
        assert_eq!(normalize_peer_name("\u{feff}\u{3000}"), "");
        assert_eq!(normalize_peer_name("a\u{85}b"), "a\u{85}b");
        assert_eq!(normalize_peer_name(&"x".repeat(50)), "x".repeat(40));
        // A space that lands on the last unit stays, as with slice().
        let spaced = format!("{} b", "a".repeat(39));
        assert_eq!(normalize_peer_name(&spaced), format!("{} ", "a".repeat(39)));
        // Emoji take two units each: 20 fit exactly.
        assert_eq!(normalize_peer_name(&"😀".repeat(25)), "😀".repeat(20));
        // The 40th unit splits a pair.
        let odd = format!("a{}", "😀".repeat(25));
        assert_eq!(
            normalize_peer_name(&odd),
            format!("a{}\u{fffd}", "😀".repeat(19))
        );
    }
}
