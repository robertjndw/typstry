use loro::{ExportMode, LoroDoc, LoroValue};
use typstry_wire::crypto::LinkSecret;

use super::*;

const P1: &str = "project-one";
const P2: &str = "project-two";
/// Far past every `addedAt` the tests use.
const NOW: i64 = 1_000_000;

fn token(n: u32) -> String {
    format!("{n:0>22}")
}

fn edit_secret() -> String {
    LinkSecret::generate_edit().to_base64url().to_string()
}

fn view_secret() -> String {
    LinkSecret::generate_edit().view_secret().to_string()
}

fn dir() -> LoroDoc {
    let doc = LoroDoc::new();
    init(&doc).unwrap();
    doc
}

#[allow(clippy::too_many_arguments)]
fn add(
    doc: &LoroDoc,
    n: u32,
    project: &str,
    secret: &str,
    edit: bool,
    added_at: i64,
    generation: Option<u32>,
) -> bool {
    add_link(
        doc,
        &NewLink {
            token: &token(n),
            project_id: project,
            secret,
            edit,
            added_at,
            generation,
        },
    )
    .unwrap()
}

fn best(doc: &LoroDoc, project: &str) -> String {
    best_link(doc, project, NOW).unwrap().token
}

#[test]
fn init_marks_the_doc_and_is_idempotent() {
    let doc = LoroDoc::new();
    assert_eq!(ensure_supported(&doc), Ok(()));
    init(&doc).unwrap();
    assert_eq!(crate::doc_kind(&doc).as_deref(), Some("directory"));
    assert_eq!(schema_version(&doc), Some(DIRECTORY_SCHEMA_VERSION));
    let before = doc.oplog_vv();
    init(&doc).unwrap();
    assert_eq!(doc.oplog_vv(), before);
    assert_eq!(ensure_supported(&doc), Ok(()));
}

#[test]
fn two_devices_initializing_merge_cleanly() {
    let (a, b) = (LoroDoc::new(), LoroDoc::new());
    a.set_peer_id(1).unwrap();
    b.set_peer_id(2).unwrap();
    init(&a).unwrap();
    init(&b).unwrap();
    sync(&a, &b);
    assert_eq!(crate::doc_kind(&a).as_deref(), Some("directory"));
    assert_eq!(schema_version(&b), Some(DIRECTORY_SCHEMA_VERSION));
}

#[test]
fn refuses_a_project_and_a_newer_layout() {
    let project = LoroDoc::new();
    crate::init::init_project(&project, "T").unwrap();
    assert_eq!(
        ensure_supported(&project),
        Err(Unsupported::NotDirectory {
            found: "project".to_owned()
        })
    );

    let doc = dir();
    doc.get_map(doc_root::META)
        .insert(meta::SCHEMA, 2.0)
        .unwrap();
    let err = ensure_supported(&doc).unwrap_err();
    assert!(err.to_string().contains("upgrade typstry"), "{err}");
}

#[test]
fn a_project_with_a_link_is_listed() {
    let doc = dir();
    let secret = edit_secret();
    assert!(add(&doc, 1, P1, &secret, true, 100, None));
    let entries = list(&doc, NOW);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.project_id, P1);
    assert_eq!(e.title, None);
    assert_eq!(e.state, State::Listed);
    assert_eq!(e.opened_at, None);
    assert_eq!(e.added_at, 100);
    assert_eq!(
        e.link,
        LinkRef {
            token: token(1),
            secret,
            edit: true,
            retired: false
        }
    );
    assert_eq!(project_of_token(&doc, &token(1), NOW).as_deref(), Some(P1));
    assert_eq!(project_of_token(&doc, &token(2), NOW), None);
}

#[test]
fn rejects_invalid_links() {
    let doc = dir();
    let ok = edit_secret();
    let view = view_secret();
    let t = token(1);
    let bad = [
        ("short", P1, ok.as_str(), true),
        (t.as_str(), "", ok.as_str(), true),
        (t.as_str(), P1, "not a secret", true),
        (t.as_str(), P1, view.as_str(), true),
    ];
    for (t, p, s, edit) in bad {
        let err = add_link(
            &doc,
            &NewLink {
                token: t,
                project_id: p,
                secret: s,
                edit,
                added_at: 1,
                generation: None,
            },
        );
        assert!(
            matches!(err, Err(DirectoryError::InvalidLink(_))),
            "{t} {p}"
        );
    }
    assert!(list(&doc, NOW).is_empty());
}

#[test]
fn an_edit_secret_may_be_recorded_as_view_only() {
    let doc = dir();
    assert!(add(&doc, 1, P1, &edit_secret(), false, 1, None));
    assert!(!list(&doc, NOW)[0].link.edit);
}

#[test]
fn best_link_prefers_edit_then_newest_then_token() {
    let doc = dir();
    add(&doc, 1, P1, &view_secret(), false, 500, None);
    add(&doc, 2, P1, &edit_secret(), true, 100, None);
    assert_eq!(best(&doc, P1), token(2), "edit beats a newer view link");

    add(&doc, 3, P1, &edit_secret(), true, 50, Some(1));
    assert_eq!(best(&doc, P1), token(2), "then the newest");

    add(&doc, 4, P1, &edit_secret(), true, 200, Some(1));
    assert_eq!(best(&doc, P1), token(4));

    add(&doc, 5, P1, &edit_secret(), true, 200, Some(1));
    assert_eq!(best(&doc, P1), token(4), "then the smaller token");

    // Another project's links never leak in.
    add(&doc, 6, P2, &view_secret(), false, 1, None);
    assert_eq!(best(&doc, P2), token(6));
    assert_eq!(best_link(&doc, "nope", NOW), None);
}

#[test]
fn generation_is_stored_but_never_ranked() {
    let doc = dir();
    add(&doc, 1, P1, &edit_secret(), true, 100, Some(999));
    add(&doc, 2, P1, &edit_secret(), true, 200, Some(1));
    assert_eq!(best(&doc, P1), token(2));
    retire(&doc, &token(1), 1).unwrap();
    retire(&doc, &token(2), 1).unwrap();
    assert_eq!(best(&doc, P1), token(2), "the fallback is the newest too");
}

#[test]
fn future_dated_entries_are_ignored() {
    let doc = dir();
    add(&doc, 1, P1, &edit_secret(), true, 100, None);
    add(
        &doc,
        2,
        P1,
        &edit_secret(),
        true,
        NOW + FUTURE_SLACK_MS + 1,
        None,
    );
    add(
        &doc,
        3,
        P2,
        &edit_secret(),
        true,
        NOW + FUTURE_SLACK_MS + 1,
        None,
    );
    assert_eq!(best(&doc, P1), token(1));
    assert_eq!(best_link(&doc, P2, NOW), None);
    assert_eq!(project_of_token(&doc, &token(2), NOW), None);
    let ids: Vec<_> = list(&doc, NOW).into_iter().map(|e| e.project_id).collect();
    assert_eq!(ids, [P1]);
    // Within the slack is honest clock skew.
    add(
        &doc,
        4,
        P1,
        &edit_secret(),
        true,
        NOW + FUTURE_SLACK_MS,
        None,
    );
    assert_eq!(best(&doc, P1), token(4));
    // Once time catches up the entry counts.
    assert_eq!(
        best_link(&doc, P2, NOW + FUTURE_SLACK_MS + 1)
            .unwrap()
            .token,
        token(3)
    );
}

#[test]
fn retired_links_lose_but_remain_a_fallback() {
    let doc = dir();
    add(&doc, 1, P1, &edit_secret(), true, 100, Some(1));
    add(&doc, 2, P1, &view_secret(), false, 50, None);
    assert!(retire(&doc, &token(1), 1000).unwrap());
    let best_now = best_link(&doc, P1, NOW).unwrap();
    assert_eq!(
        best_now.token,
        token(2),
        "a live view link beats a retired edit one"
    );
    assert!(!best_now.retired);

    assert!(retire(&doc, &token(2), 1001).unwrap());
    let fallback = best_link(&doc, P1, NOW).unwrap();
    assert_eq!(fallback.token, token(1), "newest retired");
    assert!(fallback.retired);
    assert_eq!(list(&doc, NOW)[0].link, fallback);
}

#[test]
fn status_rules() {
    let doc = dir();
    add(&doc, 1, P1, &edit_secret(), true, 100, None);
    let state = |doc: &LoroDoc| list(doc, NOW)[0].state;
    assert_eq!(state(&doc), State::Listed);

    set_status(&doc, P1, State::Removed, 5, Some(&token(1))).unwrap();
    assert_eq!(state(&doc), State::Removed);
    set_status(&doc, P1, State::Gone, 6, Some(&token(1))).unwrap();
    assert_eq!(state(&doc), State::Gone);

    // A newer link learned later supersedes what the old one saw.
    add(&doc, 2, P1, &edit_secret(), true, 200, Some(2));
    assert_eq!(state(&doc), State::Listed);
    set_status(&doc, P1, State::Gone, 7, Some(&token(2))).unwrap();
    assert_eq!(state(&doc), State::Gone);

    // Forgotten applies whatever link is best.
    set_status(&doc, P1, State::Forgotten, 8, None).unwrap();
    assert_eq!(state(&doc), State::Forgotten);
    add(&doc, 3, P1, &edit_secret(), true, 300, Some(3));
    assert_eq!(state(&doc), State::Forgotten);

    // Removed without a token never applies.
    set_status(&doc, P1, State::Removed, 9, None).unwrap();
    assert_eq!(state(&doc), State::Listed);
    set_status(&doc, P1, State::Listed, 10, None).unwrap();
    assert_eq!(state(&doc), State::Listed);
}

#[test]
fn list_order() {
    let doc = dir();
    for (n, p, at) in [(1, "a", 10), (2, "b", 20), (3, "c", 20), (4, "d", 5)] {
        add(&doc, n, p, &view_secret(), false, at, None);
    }
    touch_opened(&doc, "d", 1000).unwrap();
    touch_opened(&doc, "a", 2000).unwrap();
    let order: Vec<_> = list(&doc, NOW).into_iter().map(|e| e.project_id).collect();
    // Opened first (newest open first), then unopened by newest link, then id.
    assert_eq!(order, ["a", "d", "b", "c"]);
    assert_eq!(list(&doc, NOW)[1].opened_at, Some(1000));
}

#[test]
fn added_at_is_the_earliest_link() {
    let doc = dir();
    add(&doc, 1, P1, &view_secret(), false, 300, None);
    add(&doc, 2, P1, &view_secret(), false, 100, None);
    assert_eq!(list(&doc, NOW)[0].added_at, 100);
}

#[test]
fn titles_are_trimmed_and_empty_ones_ignored() {
    let doc = dir();
    add(&doc, 1, P1, &view_secret(), false, 1, None);
    assert!(!set_title(&doc, P1, "   ").unwrap());
    assert!(set_title(&doc, P1, "  Thesis ").unwrap());
    assert_eq!(list(&doc, NOW)[0].title.as_deref(), Some("Thesis"));
    assert!(set_title(&doc, P1, "Paper").unwrap());
    assert_eq!(list(&doc, NOW)[0].title.as_deref(), Some("Paper"));
}

#[test]
fn writes_that_change_nothing_add_no_ops() {
    let doc = dir();
    let secret = edit_secret();
    assert!(add(&doc, 1, P1, &secret, true, 100, Some(2)));
    assert!(retire(&doc, &token(1), 5).unwrap());
    assert!(set_title(&doc, P1, "T").unwrap());
    assert!(touch_opened(&doc, P1, 1_000).unwrap());
    assert!(set_status(&doc, P1, State::Gone, 9, Some(&token(1))).unwrap());

    let before = doc.oplog_vv();
    // Facts per token never change, even with different ones offered.
    assert!(!add(&doc, 1, P1, &secret, true, 999, Some(2)));
    assert!(!add(&doc, 1, P1, &view_secret(), false, 999, Some(7)));
    assert!(!retire(&doc, &token(1), 99).unwrap());
    assert!(!set_title(&doc, P1, " T ").unwrap());
    assert!(!set_title(&doc, P1, "").unwrap());
    assert!(!touch_opened(&doc, P1, 1_000 + OPENED_REFRESH_MS - 1).unwrap());
    assert!(!set_status(&doc, P1, State::Gone, 99, Some(&token(1))).unwrap());
    assert!(!prune_retired(&doc, 6).is_ok_and(|n| n > 0));
    assert_eq!(doc.oplog_vv(), before);

    // And they do write once something differs.
    assert!(touch_opened(&doc, P1, 1_000 + OPENED_REFRESH_MS).unwrap());
    assert!(set_status(&doc, P1, State::Gone, 99, Some(&token(2))).unwrap());
    assert!(set_status(&doc, P1, State::Gone, 99, None).unwrap());
    assert_ne!(doc.oplog_vv(), before);
}

#[test]
fn a_missing_generation_is_filled_in_once() {
    let doc = dir();
    let secret = edit_secret();
    add(&doc, 1, P1, &secret, true, 100, None);
    let stored = || {
        plain(&doc.get_map(root::LINKS), &token(1)).and_then(|v| match v {
            LoroValue::Map(m) => m.get(link::GENERATION).and_then(number),
            _ => None,
        })
    };
    assert_eq!(stored(), None);
    assert!(add(&doc, 1, P1, &secret, true, 100, Some(4)));
    assert_eq!(stored(), Some(4));
    assert!(!add(&doc, 1, P1, &secret, true, 100, Some(5)));
    assert_eq!(stored(), Some(4));
}

#[test]
fn malformed_entries_are_skipped() {
    let doc = dir();
    add(&doc, 1, P1, &view_secret(), false, 1, None);
    let links = doc.get_map(root::LINKS);
    let good = edit_secret();
    let map = |fields: &[(&str, LoroValue)]| {
        LoroValue::from(
            fields
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect::<HashMap<_, _>>(),
        )
    };
    let entry = |p: &str, s: &str, e: bool| {
        vec![
            ("projectId", LoroValue::from(p)),
            ("secret", LoroValue::from(s)),
            ("edit", LoroValue::from(e)),
            ("addedAt", LoroValue::from(5.0)),
        ]
    };
    links
        .insert("short", map(&entry("x", &good, true)))
        .unwrap();
    links
        .insert(&token(2), map(&entry("x", "junk", true)))
        .unwrap();
    links
        .insert(&token(3), map(&entry("x", &view_secret(), true)))
        .unwrap();
    links.insert(&token(4), "not a map").unwrap();
    let mut no_added = entry("x", &good, true);
    no_added.pop();
    links.insert(&token(5), map(&no_added)).unwrap();
    let mut no_project = entry("x", &good, true);
    no_project.remove(0);
    links.insert(&token(6), map(&no_project)).unwrap();
    let mut wrong_type = entry("x", &good, true);
    wrong_type[2] = ("edit", LoroValue::from("yes"));
    links.insert(&token(7), map(&wrong_type)).unwrap();
    doc.get_map(root::RETIRED)
        .insert(&token(1), "soon")
        .unwrap();
    doc.get_map(root::STATUS).insert(P1, "gone").unwrap();
    doc.get_map(root::OPENED).insert(P1, "yesterday").unwrap();
    doc.get_map(root::TITLES).insert(P1, 5.0).unwrap();
    doc.commit();

    let entries = list(&doc, NOW);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.project_id, P1);
    assert_eq!(e.link.token, token(1));
    assert!(!e.link.retired);
    assert_eq!(e.state, State::Listed);
    assert_eq!(e.opened_at, None);
    assert_eq!(e.title, None);
    assert_eq!(project_of_token(&doc, &token(4), NOW), None);
    assert_eq!(best_link(&doc, "x", NOW), None);
}

#[test]
fn integers_and_doubles_both_read() {
    let doc = dir();
    add(&doc, 1, P1, &view_secret(), false, 1, None);
    doc.get_map(root::OPENED).insert(P1, 77_i64).unwrap();
    doc.get_map(root::RETIRED).insert(&token(1), 5_i64).unwrap();
    doc.commit();
    let e = &list(&doc, NOW)[0];
    assert_eq!(e.opened_at, Some(77));
    assert!(e.link.retired);
}

#[test]
fn unknown_keys_and_maps_survive_rewrites() {
    let doc = dir();
    let secret = edit_secret();
    add(&doc, 1, P1, &secret, true, 1, None);
    let links = doc.get_map(root::LINKS);
    let LoroValue::Map(m) = plain(&links, &token(1)).unwrap() else {
        panic!()
    };
    let mut m: HashMap<String, LoroValue> = m.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    m.insert("future".to_owned(), LoroValue::from("kept"));
    links.insert(&token(1), LoroValue::from(m)).unwrap();
    doc.get_map("somethingNew").insert("k", "v").unwrap();
    doc.commit();

    assert!(add(&doc, 1, P1, &secret, true, 1, Some(3)));
    let LoroValue::Map(m) = plain(&links, &token(1)).unwrap() else {
        panic!()
    };
    assert_eq!(m.get("future"), Some(&LoroValue::from("kept")));
    assert_eq!(m.get("generation").and_then(number), Some(3));
    assert_eq!(
        plain(&doc.get_map("somethingNew"), "k"),
        Some(LoroValue::from("v"))
    );
}

fn sync(a: &LoroDoc, b: &LoroDoc) {
    let from_a = a.export(ExportMode::updates(&b.oplog_vv())).unwrap();
    let from_b = b.export(ExportMode::updates(&a.oplog_vv())).unwrap();
    b.import(&from_a).unwrap();
    a.import(&from_b).unwrap();
}

#[test]
fn concurrent_edits_from_two_devices_merge() {
    let (a, b) = (LoroDoc::new(), LoroDoc::new());
    a.set_peer_id(1).unwrap();
    b.set_peer_id(2).unwrap();
    init(&a).unwrap();
    sync(&a, &b);

    let shared = edit_secret();
    add(&a, 1, P1, &shared, true, 100, None);
    add(&b, 1, P1, &shared, true, 100, None);
    add(&a, 2, P2, &view_secret(), false, 200, None);
    add(&b, 3, P1, &edit_secret(), true, 300, Some(1));
    retire(&a, &token(1), 500).unwrap();
    retire(&b, &token(1), 600).unwrap();
    set_title(&a, P1, "From A").unwrap();
    set_title(&b, P2, "From B").unwrap();
    touch_opened(&a, P2, 10).unwrap();
    set_status(&b, P2, State::Forgotten, 5, None).unwrap();

    sync(&a, &b);
    assert_eq!(list(&a, NOW), list(&b, NOW));
    let entries = list(&a, NOW);
    let p1 = entries.iter().find(|e| e.project_id == P1).unwrap();
    assert_eq!(p1.link.token, token(3));
    assert_eq!(p1.title.as_deref(), Some("From A"));
    let p2 = entries.iter().find(|e| e.project_id == P2).unwrap();
    assert_eq!(p2.state, State::Forgotten);
    assert_eq!(p2.title.as_deref(), Some("From B"));
}

#[test]
fn pruning_drops_old_retired_links_but_keeps_one() {
    let doc = dir();
    add(&doc, 1, P1, &edit_secret(), true, 1, Some(1));
    add(&doc, 2, P1, &edit_secret(), true, 2, Some(2));
    add(&doc, 3, P2, &edit_secret(), true, 3, Some(1));
    add(&doc, 4, P2, &edit_secret(), true, 4, Some(2));
    let now = 10 * RETIRED_KEEP_MS;
    retire(&doc, &token(1), 0).unwrap();
    retire(&doc, &token(3), 0).unwrap();
    retire(&doc, &token(4), 0).unwrap();
    // Not old enough yet.
    retire(&doc, &token(2), now - 1).unwrap();

    assert_eq!(prune_retired(&doc, now).unwrap(), 2);
    assert_eq!(project_of_token(&doc, &token(1), NOW), None);
    assert_eq!(best(&doc, P1), token(2));
    // P2 had only old retired links: the best one stays.
    assert_eq!(project_of_token(&doc, &token(3), NOW), None);
    let kept = best_link(&doc, P2, NOW).unwrap();
    assert_eq!(kept.token, token(4));
    assert!(kept.retired);
    assert_eq!(prune_retired(&doc, now).unwrap(), 0);
}

fn owner(fill: u8) -> OwnerSecret {
    OwnerSecret::from_raw(&[fill; 32]).unwrap()
}

fn owner_hex(secret: &OwnerSecret) -> String {
    hex(&secret.public())
}

#[test]
fn owner_keys_are_added_once_and_listed_newest_first() {
    let doc = dir();
    let (old, new) = (owner(1), owner(2));
    assert!(add_owner_key(&doc, P1, &old, 100).unwrap());
    assert!(add_owner_key(&doc, P1, &new, 200).unwrap());
    let before = doc.oplog_vv();
    // Never overwritten, so a later add keeps the first addedAt.
    assert!(!add_owner_key(&doc, P1, &old, 900).unwrap());
    assert_eq!(doc.oplog_vv(), before);
    add_owner_key(&doc, P2, &owner(3), 300).unwrap();

    let keys = owner_keys(&doc, P1, NOW);
    assert_eq!(
        keys.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>(),
        [owner_hex(&new), owner_hex(&old)]
    );
    assert_eq!(keys[0].1.to_raw().as_ref(), &[2; 32]);
    assert_eq!(owner_keys(&doc, P2, NOW).len(), 1);
    assert!(owner_keys(&doc, "other", NOW).is_empty());
}

#[test]
fn owner_keys_that_do_not_validate_are_skipped() {
    let doc = dir();
    let good = owner(1);
    add_owner_key(&doc, P1, &good, 100).unwrap();
    let map = doc.get_map(root::OWNER_KEYS);
    let entry = |secret: &str, added_at: LoroValue| {
        LoroValue::from(HashMap::from([
            ("secret".to_owned(), LoroValue::from(secret)),
            ("addedAt".to_owned(), added_at),
        ]))
    };
    let secret = owner(2).to_base64url().to_string();
    // A secret parked under another key, a non-hex key, a missing project,
    // junk secrets and a missing time.
    map.insert(
        &owner_key_id(P1, &owner_hex(&good)).replace('1', "2"),
        entry(&secret, 5.0.into()),
    )
    .unwrap();
    map.insert(
        &format!("{P1}/{}", owner_hex(&owner(2))),
        entry(&owner(3).to_base64url(), 5.0.into()),
    )
    .unwrap();
    map.insert(
        &format!("{P1}/{}", owner_hex(&owner(2)).to_uppercase()),
        entry(&secret, 5.0.into()),
    )
    .unwrap();
    map.insert(
        &format!("/{}", owner_hex(&owner(2))),
        entry(&secret, 5.0.into()),
    )
    .unwrap();
    map.insert(
        &format!("{P1}/{}", owner_hex(&owner(4))),
        entry("not a secret", 5.0.into()),
    )
    .unwrap();
    map.insert(
        &format!("{P1}/{}", owner_hex(&owner(2))),
        LoroValue::from(HashMap::from([(
            "secret".to_owned(),
            LoroValue::from(secret.as_str()),
        )])),
    )
    .unwrap();
    map.insert("no-slash", entry(&secret, 5.0.into())).unwrap();
    map.insert("bad", LoroValue::from("text")).unwrap();
    doc.commit();

    let keys = owner_keys(&doc, P1, NOW);
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].0, owner_hex(&good));
    // A junk entry is replaced by a valid add, unknown keys kept.
    let id = format!("{P1}/{}", owner_hex(&owner(2)));
    let LoroValue::Map(junk) = plain(&map, &id).unwrap() else {
        panic!("map");
    };
    let mut junk: HashMap<String, LoroValue> =
        junk.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    junk.insert("note".to_owned(), "kept".into());
    map.insert(&id, LoroValue::from(junk)).unwrap();
    assert!(add_owner_key(&doc, P1, &owner(2), 50).unwrap());
    assert_eq!(owner_keys(&doc, P1, NOW).len(), 2);
    let LoroValue::Map(fixed) = plain(&map, &id).unwrap() else {
        panic!("map");
    };
    assert_eq!(fixed.get("note"), Some(&LoroValue::from("kept")));
}

#[test]
fn owner_keys_accept_integer_and_double_times() {
    let doc = dir();
    let secret = owner(1);
    doc.get_map(root::OWNER_KEYS)
        .insert(
            &owner_key_id(P1, &owner_hex(&secret)),
            LoroValue::from(HashMap::from([
                (
                    "secret".to_owned(),
                    LoroValue::from(secret.to_base64url().as_str()),
                ),
                ("addedAt".to_owned(), LoroValue::I64(7)),
            ])),
        )
        .unwrap();
    assert_eq!(owner_keys(&doc, P1, NOW).len(), 1);
}

#[test]
fn pruning_owner_keys_keeps_the_newest() {
    let doc = dir();
    for (i, fill) in (1..=5u8).enumerate() {
        add_owner_key(&doc, P1, &owner(fill), 100 * (i as i64 + 1)).unwrap();
    }
    add_owner_key(&doc, P2, &owner(9), 1).unwrap();
    assert_eq!(prune_owner_keys(&doc, P1, 8, NOW).unwrap(), 0);
    assert_eq!(prune_owner_keys(&doc, P1, 2, NOW).unwrap(), 3);
    let kept: Vec<String> = owner_keys(&doc, P1, NOW)
        .into_iter()
        .map(|(h, _)| h)
        .collect();
    assert_eq!(kept, [owner_hex(&owner(5)), owner_hex(&owner(4))]);
    assert_eq!(owner_keys(&doc, P2, NOW).len(), 1);
    assert_eq!(prune_owner_keys(&doc, P1, 2, NOW).unwrap(), 0);
}

#[test]
fn concurrent_owner_key_adds_union() {
    let (a, b) = (LoroDoc::new(), LoroDoc::new());
    a.set_peer_id(1).unwrap();
    b.set_peer_id(2).unwrap();
    init(&a).unwrap();
    sync(&a, &b);
    add_owner_key(&a, P1, &owner(1), 10).unwrap();
    add_owner_key(&b, P1, &owner(2), 20).unwrap();
    add_owner_key(&b, P1, &owner(1), 30).unwrap();
    sync(&a, &b);
    assert_eq!(owner_keys(&a, P1, NOW).len(), 2);
    assert_eq!(
        owner_keys(&a, P1, NOW)
            .into_iter()
            .map(|(h, _)| h)
            .collect::<Vec<_>>(),
        owner_keys(&b, P1, NOW)
            .into_iter()
            .map(|(h, _)| h)
            .collect::<Vec<_>>()
    );
}

#[test]
fn owner_secrets_stay_out_of_debug() {
    let doc = dir();
    add_owner_key(&doc, P1, &owner(0xAB), 1).unwrap();
    let shown = format!("{:?}", owner_keys(&doc, P1, NOW));
    assert!(!shown.contains(&*owner(0xAB).to_base64url()));
}

#[test]
fn future_dated_owner_keys_are_ignored_and_pruned_first() {
    let doc = dir();
    add_owner_key(&doc, P1, &owner(1), 100).unwrap();
    add_owner_key(&doc, P1, &owner(2), 200).unwrap();
    add_owner_key(&doc, P1, &owner(3), NOW + FUTURE_SLACK_MS + 1).unwrap();
    let kept: Vec<String> = owner_keys(&doc, P1, NOW)
        .into_iter()
        .map(|(h, _)| h)
        .collect();
    assert_eq!(kept, [owner_hex(&owner(2)), owner_hex(&owner(1))]);
    assert_eq!(prune_owner_keys(&doc, P1, 2, NOW).unwrap(), 1);
    assert_eq!(owner_keys(&doc, P1, NOW + 2 * FUTURE_SLACK_MS).len(), 2);
}

#[test]
fn refiling_moves_a_link_and_keeps_its_facts() {
    let doc = dir();
    let secret = edit_secret();
    assert!(add(&doc, 1, P1, &secret, true, 100, Some(2)));
    assert!(refile_link(&doc, &token(1), P2).unwrap());
    let entries = list(&doc, NOW);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.project_id, P2);
    assert_eq!(e.link.token, token(1));
    assert_eq!(e.link.secret, secret);
    assert!(e.link.edit);
    assert_eq!(e.added_at, 100);

    let before = doc.oplog_vv();
    assert!(!refile_link(&doc, &token(1), P2).unwrap());
    assert!(!refile_link(&doc, &token(9), P2).unwrap());
    assert!(!refile_link(&doc, &token(1), "").unwrap());
    assert_eq!(doc.oplog_vv(), before);
}
