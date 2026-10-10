//! The `peers` map: who is behind a peer id, so history can name authors.
//! Mirrors `ProjectDoc.setPeer` in `apps/web/src/doc/schema.ts`.

use std::collections::HashMap;

use loro::{LoroDoc, LoroResult, LoroValue};

use crate::{peer, root};

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
}
