//! Encoding and parsing `%ELO` records and the containers that carry them.
//!
//! The Rust `loro-protocol` crate only parses records, so the encoders live
//! here and mirror the npm encoder (`encodeDeltaHeaderBytes`,
//! `encodeSnapshotHeaderBytes`, `encodeEloContainer`) byte for byte. A
//! record's header doubles as the AEAD associated data, so any difference
//! in encoding would make records from the other side fail to decrypt.
//!
//! The parsers are stricter than `loro-protocol`: they are what the server
//! validates untrusted updates with, and clients run the same checks so
//! they never act on a record the server would have refused.

use std::collections::HashMap;
use std::ops::Range;

use loro_protocol::{
    BytesReader, BytesWriter, EloHeader, EloRecordKind, decode_elo_container,
    parse_elo_record_header,
};

pub const IV_LEN: usize = 12;

pub type Iv = [u8; IV_LEN];

pub type PeerId = u64;

/// Per peer, an exclusive op counter: `{p: c}` means ops `[0, c)` of `p`.
pub type Version = HashMap<PeerId, u64>;

/// Loro op counters are i32, so a larger one cannot come from a real doc
/// and would not survive encoding the coverage as a Loro version vector.
pub const MAX_COUNTER: u64 = i32::MAX as u64;

/// What a record's plaintext header says it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    /// Ops `[start, end)` of `peer`.
    Delta { peer: PeerId, start: u64, end: u64 },
    /// A full copy of the doc at `vv`.
    Snapshot { vv: Version },
}

/// A record parsed down to what decrypting it takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedRecord<'a> {
    pub record: Record,
    pub key_id: String,
    pub iv: Iv,
    /// The exact header bytes, bound to the ciphertext as associated data.
    pub aad: &'a [u8],
    /// The record body: salt, ciphertext with the GCM tag, and signature
    /// (see the `crypto` module).
    pub ct: &'a [u8],
}

fn counter(value: u64) -> Result<u64, String> {
    if value > MAX_COUNTER {
        return Err(format!("counter {value} does not fit a Loro counter"));
    }
    Ok(value)
}

/// Reads the leading uleb128 count and checks it against the bytes left.
/// The library pre-allocates from that count, so a hostile one like 2^60
/// would abort the process before any bounds check runs.
fn plausible_count(reader: &mut BytesReader<'_>, min_entry_bytes: usize) -> Result<u64, String> {
    let count = reader.read_uleb128()?;
    let room = (reader.remaining() / min_entry_bytes) as u64;
    if count > room {
        return Err(format!("count {count} exceeds the remaining bytes"));
    }
    Ok(count)
}

impl<'a> SealedRecord<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.first() == Some(&(EloRecordKind::Snapshot as u8)) {
            // Each vv entry is at least a one-byte length and a one-byte counter.
            plausible_count(&mut BytesReader::new(&bytes[1..]), 2)?;
        }
        let parsed = parse_elo_record_header(bytes)?;
        let (record, key_id, iv) = match parsed.header {
            EloHeader::Delta(delta) => {
                let record = Record::Delta {
                    peer: parse_peer_id(&delta.peer_id).ok_or("invalid delta peer id")?,
                    start: counter(delta.start)?,
                    end: counter(delta.end)?,
                };
                (record, delta.key_id, delta.iv)
            }
            EloHeader::Snapshot(snapshot) => {
                let mut vv = Version::with_capacity(snapshot.vv.len());
                for (peer, count) in snapshot.vv {
                    let peer = parse_peer_id(&peer).ok_or("invalid snapshot peer id")?;
                    if vv.insert(peer, counter(count)?).is_some() {
                        return Err("snapshot lists a peer twice".into());
                    }
                }
                (Record::Snapshot { vv }, snapshot.key_id, snapshot.iv)
            }
        };
        Ok(Self {
            record,
            key_id,
            iv,
            aad: parsed.aad,
            ct: parsed.ct,
        })
    }
}

pub fn parse_record(bytes: &[u8]) -> Result<Record, String> {
    SealedRecord::parse(bytes).map(|sealed| sealed.record)
}

/// Splits an update payload into its records without looking at them.
pub fn decode_container(payload: &[u8]) -> Result<Vec<&[u8]>, String> {
    // Every record is at least its one-byte length prefix.
    plausible_count(&mut BytesReader::new(payload), 1)?;
    decode_elo_container(payload)
}

/// How many records a container says it holds, from its header alone, for
/// callers that only need the count.
pub fn container_len(payload: &[u8]) -> Result<u64, String> {
    plausible_count(&mut BytesReader::new(payload), 1)
}

/// Parses every record of one update payload. All or nothing: a single bad
/// record rejects the whole payload, so the server never stores half of it.
pub fn parse_container(payload: &[u8]) -> Result<Vec<(Record, &[u8])>, String> {
    let records = decode_container(payload)?;
    if records.is_empty() {
        return Err("empty container".into());
    }
    records
        .into_iter()
        .map(|bytes| Ok((parse_record(bytes)?, bytes)))
        .collect()
}

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
    pack_ranges(records, limit)
        .into_iter()
        .map(|range| encode_container(&records[range]))
        .collect()
}

/// [`pack`] as the index range of each container's records, for callers
/// that track something per record.
pub fn pack_ranges(records: &[&[u8]], limit: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut first = 0;
    let mut size = 0;
    for (i, record) in records.iter().enumerate() {
        let cost = record.len() + uleb_len(record.len());
        if i > first && size + cost > limit {
            out.push(first..i);
            first = i;
            size = 0;
        }
        size += cost;
    }
    if first < records.len() {
        out.push(first..records.len());
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

/// A full record: the header followed by the length-prefixed body (see the
/// `crypto` module for what the body holds).
pub fn encode_record(header: &[u8], ct: &[u8]) -> Vec<u8> {
    let mut writer = BytesWriter::new();
    writer.push_bytes(header);
    writer.push_var_bytes(ct);
    writer.finalize()
}

#[cfg(test)]
mod tests {
    use loro_protocol::{EloDeltaHeader, EloSnapshotHeader};

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
        assert_eq!(
            pack_ranges(&[&small, &small, &huge, &small], limit),
            [0..2, 2..3, 3..4]
        );
        assert!(pack(&[], limit).is_empty());
    }

    fn delta(peer: &[u8], start: u64, end: u64, ct: &[u8]) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(0x00);
        w.push_var_bytes(peer);
        w.push_uleb128(start);
        w.push_uleb128(end);
        w.push_var_string("k1");
        w.push_var_bytes(&[0; 12]);
        w.push_var_bytes(ct);
        w.finalize()
    }

    fn snapshot(vv: &[(&[u8], u64)]) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(0x01);
        w.push_uleb128(vv.len() as u64);
        for (peer, count) in vv {
            w.push_var_bytes(peer);
            w.push_uleb128(*count);
        }
        w.push_var_string("k1");
        w.push_var_bytes(&[0; 12]);
        w.push_var_bytes(b"ct");
        w.finalize()
    }

    #[test]
    fn parses_and_rejects_containers() {
        let d = delta(b"7", 0, 3, b"x");
        let s = snapshot(&[(b"7", 3)]);
        let container = encode_container(&[&d, &s]);
        let parsed = parse_container(&container).unwrap();
        assert_eq!(
            parsed[0],
            (
                Record::Delta {
                    peer: 7,
                    start: 0,
                    end: 3
                },
                d.as_slice()
            )
        );
        assert_eq!(
            parsed[1].0,
            Record::Snapshot {
                vv: Version::from([(7, 3)])
            }
        );

        let too_big = MAX_COUNTER + 1;
        for bad in [
            encode_container(&[]),
            encode_container(&[&delta(b"07", 0, 1, b"x")]),
            encode_container(&[&delta(b"7", 0, too_big, b"x")]),
            encode_container(&[&snapshot(&[(b"7", too_big)])]),
            encode_container(&[&snapshot(&[(b"7", 1), (b"7", 2)])]),
            encode_container(&[&d, b"\x05garbage"]),
            b"\xff\xff\xff\xff\xff\xff\xff\xff\x0f".to_vec(),
            // A snapshot claiming 2^35 vv entries in zero bytes.
            b"\x01\x07\x01\x80\x80\x80\x80\x80\x01".to_vec(),
        ] {
            assert!(parse_container(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn sealed_records_keep_what_decryption_needs() {
        let iv = [5; IV_LEN];
        let header = encode_delta_header(3, 1, 2, "key", &iv);
        let record = encode_record(&header, b"ct");
        let sealed = SealedRecord::parse(&record).unwrap();
        assert_eq!(sealed.key_id, "key");
        assert_eq!(sealed.iv, iv);
        assert_eq!(sealed.aad, header.as_slice());
        assert_eq!(sealed.ct, b"ct");
    }

    #[test]
    fn containers_round_trip() {
        let records: [&[u8]; 3] = [b"one", b"", &[7; 200]];
        let container = encode_container(&records);
        assert_eq!(decode_elo_container(&container).unwrap(), records);
        assert_eq!(encode_container(&[]), [0]);
    }
}
