//! Encoding `%ELO` records and the containers that carry them.
//!
//! The Rust `loro-protocol` crate only parses records, so the encoders live
//! here and mirror the npm encoder (`encodeDeltaHeaderBytes`,
//! `encodeSnapshotHeaderBytes`, `encodeEloContainer`) byte for byte. A
//! record's header doubles as the AEAD associated data, so any difference
//! in encoding would make records from the other side fail to decrypt.

use loro_protocol::{BytesWriter, EloRecordKind};

pub const IV_LEN: usize = 12;

pub type Iv = [u8; IV_LEN];

/// Packs records into one update payload: a count, then each record
/// length-prefixed.
pub fn encode_container(records: &[&[u8]]) -> Vec<u8> {
    let mut writer = BytesWriter::new();
    writer.push_uleb128(records.len() as u64);
    for record in records {
        writer.push_var_bytes(record);
    }
    writer.finalize()
}

/// Groups records into as few containers as `limit` allows, keeping their
/// order. A record larger than `limit` gets a container of its own.
pub fn pack(records: &[&[u8]], limit: usize) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut batch: Vec<&[u8]> = Vec::new();
    let mut size = 0;
    for record in records {
        let cost = record.len() + uleb_len(record.len());
        if !batch.is_empty() && size + cost > limit {
            out.push(encode_container(&batch));
            batch.clear();
            size = 0;
        }
        batch.push(record);
        size += cost;
    }
    if !batch.is_empty() {
        out.push(encode_container(&batch));
    }
    out
}

fn uleb_len(n: usize) -> usize {
    (usize::BITS - n.leading_zeros()).max(1).div_ceil(7) as usize
}

/// Peer ids travel as the decimal form of the u64, which is how the JS
/// client spells Loro's `PeerID` and the only spelling the server accepts.
fn peer_bytes(peer: u64) -> Vec<u8> {
    peer.to_string().into_bytes()
}

/// Parses a peer id as [`peer_bytes`] writes it. Only the canonical
/// spelling is accepted, so one peer can never show up under two ids and
/// get coverage tracked twice.
pub fn parse_peer_id(bytes: &[u8]) -> Option<u64> {
    let canonical = !bytes.is_empty()
        && bytes.iter().all(u8::is_ascii_digit)
        && (bytes.len() == 1 || bytes[0] != b'0');
    if !canonical {
        return None;
    }
    // Digits only, so this is valid UTF-8 and has no sign for parse to allow.
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

/// The plaintext header of a record carrying ops `[start, end)` of `peer`.
///
/// # Panics
///
/// When the span is empty, which every parser rejects.
pub fn encode_delta_header(peer: u64, start: u64, end: u64, key_id: &str, iv: &Iv) -> Vec<u8> {
    assert!(end > start, "delta span {start}..{end} is empty");
    let mut writer = BytesWriter::new();
    writer.push_byte(EloRecordKind::DeltaSpan as u8);
    writer.push_var_bytes(&peer_bytes(peer));
    writer.push_uleb128(start);
    writer.push_uleb128(end);
    writer.push_var_string(key_id);
    writer.push_var_bytes(iv);
    writer.finalize()
}

/// The plaintext header of a snapshot covering `vv`, given as
/// `(peer, exclusive counter)` pairs in any order.
pub fn encode_snapshot_header(vv: &[(u64, u64)], key_id: &str, iv: &Iv) -> Vec<u8> {
    // Parsers reject entries not sorted by the peer id's bytes. That is not
    // numeric order: "10" sorts before "9".
    let mut entries: Vec<(Vec<u8>, u64)> = vv
        .iter()
        .map(|&(peer, counter)| (peer_bytes(peer), counter))
        .collect();
    entries.sort();
    let mut writer = BytesWriter::new();
    writer.push_byte(EloRecordKind::Snapshot as u8);
    writer.push_uleb128(entries.len() as u64);
    for (peer, counter) in &entries {
        writer.push_var_bytes(peer);
        writer.push_uleb128(*counter);
    }
    writer.push_var_string(key_id);
    writer.push_var_bytes(iv);
    writer.finalize()
}

/// A full record: the header followed by the length-prefixed ciphertext
/// (GCM tag included).
pub fn encode_record(header: &[u8], ct: &[u8]) -> Vec<u8> {
    let mut writer = BytesWriter::new();
    writer.push_bytes(header);
    writer.push_var_bytes(ct);
    writer.finalize()
}

#[cfg(test)]
mod tests {
    use loro_protocol::{
        EloDeltaHeader, EloHeader, EloSnapshotHeader, decode_elo_container, parse_elo_record_header,
    };

    use super::*;

    #[test]
    fn delta_header_round_trips() {
        let iv = [3; IV_LEN];
        let header = encode_delta_header(u64::MAX, 5, 9, "abcdefghijkl", &iv);
        let record = encode_record(&header, b"ciphertext");
        let parsed = parse_elo_record_header(&record).unwrap();
        assert_eq!(parsed.aad, header.as_slice());
        assert_eq!(parsed.ct, b"ciphertext");
        assert_eq!(
            parsed.header,
            EloHeader::Delta(EloDeltaHeader {
                peer_id: b"18446744073709551615".to_vec(),
                start: 5,
                end: 9,
                key_id: "abcdefghijkl".into(),
                iv,
            })
        );
    }

    #[test]
    fn snapshot_header_sorts_by_peer_bytes() {
        let iv = [4; IV_LEN];
        let header = encode_snapshot_header(&[(9, 1), (100, 2), (10, 3)], "k", &iv);
        let record = encode_record(&header, b"");
        let parsed = parse_elo_record_header(&record).unwrap();
        assert_eq!(parsed.aad, header.as_slice());
        assert_eq!(
            parsed.header,
            EloHeader::Snapshot(EloSnapshotHeader {
                vv: vec![
                    (b"10".to_vec(), 3),
                    (b"100".to_vec(), 2),
                    (b"9".to_vec(), 1)
                ],
                key_id: "k".into(),
                iv,
            })
        );
    }

    #[test]
    fn matches_the_js_encoder() {
        // Built by hand from the npm encoder: kind, varBytes peer, uleb
        // start and end, varString key id, varBytes iv, varBytes ct.
        let mut expected = vec![0x00, 2, b'4', b'2', 0x80, 0x01, 0x81, 0x01, 1, b'k', 12];
        expected.extend([0; 12]);
        expected.extend([2, 0xaa, 0xbb]);
        let header = encode_delta_header(42, 128, 129, "k", &[0; 12]);
        assert_eq!(encode_record(&header, &[0xaa, 0xbb]), expected);
    }

    #[test]
    #[should_panic(expected = "is empty")]
    fn rejects_empty_spans() {
        encode_delta_header(1, 3, 3, "k", &[0; IV_LEN]);
    }

    #[test]
    fn peer_ids_must_be_canonical_decimal_u64() {
        assert_eq!(parse_peer_id(b"0"), Some(0));
        assert_eq!(parse_peer_id(b"18446744073709551615"), Some(u64::MAX));
        for bad in [
            &b""[..],
            b"18446744073709551616",
            b"+1",
            b"-1",
            b"01",
            b"1a",
            b" 1",
        ] {
            assert_eq!(parse_peer_id(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn packs_records_under_the_limit() {
        let limit = 3000;
        let small = vec![1u8; limit / 3];
        let huge = vec![2u8; limit * 2];
        let containers = pack(&[&small, &small, &huge, &small], limit);
        let sizes: Vec<usize> = containers
            .iter()
            .map(|c| decode_elo_container(c).unwrap().len())
            .collect();
        assert_eq!(sizes, [2, 1, 1]);
        assert!(pack(&[], limit).is_empty());
    }

    #[test]
    fn containers_round_trip() {
        let records: [&[u8]; 3] = [b"one", b"", &[7; 200]];
        let container = encode_container(&records);
        assert_eq!(decode_elo_container(&container).unwrap(), records);
        assert_eq!(encode_container(&[]), [0]);
    }
}
