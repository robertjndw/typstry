//! Rough timings for the sizes the server deals with. Ignored by default;
//! numbers only mean something in release:
//! `cargo test --release -p typstry-doc --test perf -- --ignored --nocapture`

use std::time::{Duration, Instant};

use loro::{ExportMode, LoroDoc, LoroText};
use typstry_doc::init::init_project;
use typstry_doc::materialize::materialize;
use typstry_doc::paths::build_path_index;
use typstry_doc::text_content;

const MIB: usize = 1024 * 1024;

fn timed<T>(label: &str, f: impl FnOnce() -> T) -> (T, Duration) {
    let start = Instant::now();
    let out = f();
    let took = start.elapsed();
    println!("{label:<44} {:>9.1} ms", took.as_secs_f64() * 1000.0);
    (out, took)
}

fn main_text(doc: &LoroDoc) -> LoroText {
    let id = build_path_index(doc).by_path["main.typ"];
    text_content(doc, id).unwrap()
}

fn seeded() -> LoroDoc {
    let doc = LoroDoc::new();
    init_project(&doc, "Perf").unwrap();
    doc
}

/// Pseudo-random words with line breaks and some non-ASCII, so the text
/// neither compresses away nor stays in the ASCII fast paths.
fn body(len: usize) -> String {
    const WORDS: [&str; 12] = [
        "lorem",
        "ipsum",
        "#emph[dolor]",
        "sit",
        "amet",
        "Größe",
        "naïve",
        "$x^2$",
        "😀",
        "consectetur",
        "= Heading",
        "adipiscing",
    ];
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut out = String::with_capacity(len + 16);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.push_str(WORDS[(state % WORDS.len() as u64) as usize]);
        out.push(if state.is_multiple_of(11) { '\n' } else { ' ' });
    }
    out
}

fn round_trip(label: &str, doc: &LoroDoc) {
    let (snapshot, _) = timed(&format!("{label}: export snapshot"), || {
        doc.export(ExportMode::Snapshot).unwrap()
    });
    println!("{label}: snapshot size {} KiB", snapshot.len() / 1024);
    // Snapshot import is lazy; materializing forces the state to decode.
    timed(&format!("{label}: import snapshot + materialize"), || {
        materialize(&LoroDoc::from_snapshot(&snapshot).unwrap())
    });
    let (updates, _) = timed(&format!("{label}: export all updates"), || {
        doc.export(ExportMode::all_updates()).unwrap()
    });
    timed(&format!("{label}: import updates + materialize"), || {
        let fresh = LoroDoc::new();
        fresh.import(&updates).unwrap();
        materialize(&fresh)
    });
}

#[test]
#[ignore = "benchmark, run explicitly in release"]
fn one_mebibyte_as_a_single_insert() {
    let doc = seeded();
    let text = body(MIB);
    timed("single insert: insert + commit", || {
        let main = main_text(&doc);
        main.insert(0, &text).unwrap();
        doc.commit();
    });
    round_trip("single insert", &doc);
}

#[test]
#[ignore = "benchmark, run explicitly in release"]
fn one_mebibyte_as_small_inserts() {
    let doc = seeded();
    let text = body(MIB);
    let chars: Vec<char> = text.chars().collect();
    timed("small inserts: 64-char inserts + commits", || {
        let main = main_text(&doc);
        for part in chars.chunks(64) {
            let part: String = part.iter().collect();
            main.insert(main.len_unicode(), &part).unwrap();
            doc.commit();
        }
    });
    round_trip("small inserts", &doc);
}

#[test]
#[ignore = "benchmark, run explicitly in release"]
fn ten_thousand_updates_compact_and_load() {
    let doc = seeded();
    let seed = doc.export(ExportMode::Snapshot).unwrap();
    let main = main_text(&doc);
    let mut log = Vec::with_capacity(10_000);
    timed("10k updates: produce", || {
        for i in 0..10_000u32 {
            let before = doc.oplog_vv();
            // Typing: mostly appends, the occasional edit further up.
            let at = if i.is_multiple_of(10) {
                main.len_unicode() / 2
            } else {
                main.len_unicode()
            };
            main.insert(at, "ab ").unwrap();
            doc.commit();
            log.push(doc.export(ExportMode::updates(&before)).unwrap());
        }
    });
    timed("10k updates: load uncompacted (import_batch)", || {
        let fresh = LoroDoc::from_snapshot(&seed).unwrap();
        fresh.import_batch(&log).unwrap();
        assert_eq!(fresh.oplog_vv(), doc.oplog_vv());
        materialize(&fresh)
    });
    let (snapshot, _) = timed("10k updates: compact (export snapshot)", || {
        doc.export(ExportMode::Snapshot).unwrap()
    });
    println!("10k updates: snapshot size {} KiB", snapshot.len() / 1024);
    let (_, load) = timed("10k updates: load compacted + materialize", || {
        materialize(&LoroDoc::from_snapshot(&snapshot).unwrap())
    });
    assert!(load < Duration::from_millis(100), "plan target is < 100 ms");
}
