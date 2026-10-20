//! Frozen compatibility fixtures in `fixtures/compat/v<N>/` at the repo
//! root. Each directory holds data as typstry wrote it at format version
//! N, and every later build has to keep reading it. This file loads the
//! CLI's part (`cli/`) through the real loaders; the doc and the crypto
//! parts are checked by the `compat` tests of typstry-doc and
//! typstry-wire, and by `apps/web/src/compat.test.ts`.
//!
//! The generator below runs only with `TYPSTRY_WRITE_COMPAT=<N>`, writes
//! `compat/v<N>` and refuses to touch a directory that already exists.
//! Unlike the `TYPSTRY_WRITE_FIXTURES` ones, which follow the current code,
//! these never change.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use loro::awareness::EphemeralStore;
use loro::cursor::Side;
use loro::{ContainerTrait, ExportMode, Frontiers, IdSpan, LoroDoc, LoroText, LoroValue, TreeID};
use serde_json::{Value, json};

use typstry_cli::api::Permission;
use typstry_cli::git::GitMark;
use typstry_cli::hash::{BlobHash, Digest};
use typstry_cli::link::ShareLink;
use typstry_cli::mailbox;
use typstry_cli::state::{
    BASE_VERSION, Base, CONFIG_VERSION, Config, LOG_FORMAT, STATE_DIR, StateDir,
};
use typstry_doc::directory::DIRECTORY_SCHEMA_VERSION;
use typstry_doc::init::init_project;
use typstry_doc::materialize::{FileContent, materialize, materialize_at};
use typstry_doc::paths::build_path_index;
use typstry_doc::peers::set_peer;
use typstry_doc::testing::file_json;
use typstry_doc::versions::{named_versions, save_version};
use typstry_doc::{SCHEMA_VERSION, comment, root, text_content};
use typstry_wire::crypto::{
    BLOB_CONTEXT, DocKeys, KEYRING_VERSION, Keyring, LinkSecret, LocalSigner, PROFILE_CONTEXT,
    PresenceKey, RECORD_VERSION, RecordSigner, SEAL_VERSION, SECRET_EDIT_V1, SECRET_VIEW_V1,
};
use typstry_wire::ds::DS_VERSION;
use typstry_wire::identity::{DeviceKey, PersonGraph};
use typstry_wire::mls::{LocalIdentity, MLS_STATE_VERSION, Role, SpaceGroup};
use typstry_wire::{MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};

#[path = "../../../fixtures/compat/support.rs"]
mod support;

use support::{compat_dirs, compat_root, read_json};

/// Copies a fixture's `cli/` into a fresh folder's state directory, so the
/// loaders can repair or rewrite files without touching the fixture.
fn linked_copy(fixture: &Path) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let state = root.join(STATE_DIR);
    fs::create_dir(&state).unwrap();
    for entry in fs::read_dir(fixture.join("cli")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), state.join(entry.file_name())).unwrap();
    }
    (dir, root)
}

fn frontiers_of(version: &str, doc: &LoroDoc) -> Frontiers {
    named_versions(doc)
        .into_iter()
        .find(|v| v.name == version)
        .unwrap_or_else(|| panic!("no version {version:?}"))
        .frontiers
}

#[test]
fn cli_reads_every_compat_fixture() {
    for (n, dir) in compat_dirs() {
        let expected = read_json(&dir.join("cli.json"));
        let crypto = read_json(&dir.join("crypto.json"));
        let reference = LoroDoc::from_snapshot(&fs::read(dir.join("doc.loro")).unwrap()).unwrap();
        let (_guard, root) = linked_copy(&dir);

        // peek_config and discover are what every command starts with.
        let peeked = StateDir::peek_config(&root).unwrap();
        let state = StateDir::discover(&root).unwrap();
        let config = state.load_config().unwrap();
        assert_eq!(peeked.key, config.key, "v{n}");
        assert_eq!(config.server, expected["server"], "v{n}");
        assert_eq!(config.project_id, expected["projectId"], "v{n}");
        assert_eq!(config.token, expected["token"], "v{n}");
        assert_eq!(config.view_token.as_deref(), expected["viewToken"].as_str());
        assert_eq!(config.name.as_deref(), expected["name"].as_str());
        assert_eq!(config.branch.as_deref(), expected["branch"].as_str());
        assert_eq!(config.permission, Permission::Write, "v{n}");
        assert_eq!(config.key, crypto["editSecret"], "v{n}");
        assert!(config.can_sign(), "v{n}");
        assert_eq!(config.link().to_string(), crypto["editLink"], "v{n}");
        assert_eq!(
            config.view_link().unwrap().to_string(),
            crypto["viewLink"],
            "v{n}"
        );
        for link in [&crypto["editLink"], &crypto["viewLink"]] {
            ShareLink::parse(link.as_str().unwrap()).unwrap();
        }

        let base = state.load_base().unwrap();
        assert_eq!(base.frontiers, reference.oplog_frontiers(), "v{n}");
        assert_eq!(base.last_sync, expected["lastSync"].as_u64(), "v{n}");
        let pins: BTreeMap<String, Frontiers> = expected["pins"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(path, version)| {
                (
                    path.clone(),
                    frontiers_of(version.as_str().unwrap(), &reference),
                )
            })
            .collect();
        assert_eq!(base.pins, pins, "v{n}");
        let blob = &crypto["blob"];
        let plaintext = URL_SAFE_NO_PAD
            .decode(blob["plaintext"].as_str().unwrap())
            .unwrap();
        let sealed = URL_SAFE_NO_PAD
            .decode(blob["sealed"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            base.assets,
            BTreeMap::from([(BlobHash::of(&sealed), Digest::of(&plaintext))]),
            "v{n}"
        );
        let git: GitMark = serde_json::from_value(expected["git"].clone()).unwrap();
        assert_eq!(base.git, Some(git), "v{n}");

        // The saved group has to load, and still be the member it was.
        let (group, warning) = state.load_mls().unwrap();
        assert_eq!(warning, None, "v{n}");
        let group = group.unwrap_or_else(|| panic!("v{n}: mls.bin did not load"));
        let mls = &expected["mls"];
        assert_eq!(group.epoch(), mls["epoch"].as_u64().unwrap(), "v{n}");
        assert!(group.is_active(), "v{n}");
        assert_eq!(group.link().to_base64url().as_str(), crypto["editSecret"]);
        assert_eq!(group.generation().unwrap(), 1, "v{n}");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(group.device().signer_pub()),
            mls["devicePub"],
            "v{n}"
        );
        let members = group.members().unwrap();
        assert_eq!(members.len(), 1, "v{n}");
        assert_eq!(members[0].role, Role::Owner, "v{n}");
        assert_eq!(
            members[0].profile.as_deref(),
            Some(mls["profile"].as_str().unwrap().as_bytes()),
            "v{n}"
        );

        // doc.bin plus every doc.log entry has to add up to the whole doc.
        // A log mistaken for a newer format would be dropped with a warning.
        let (doc, warning) = state.load_doc().unwrap();
        assert_eq!(warning, None, "v{n}");
        assert_eq!(doc.oplog_vv(), reference.oplog_vv(), "v{n}");
        assert_eq!(doc.get_deep_value(), reference.get_deep_value(), "v{n}");
        assert_eq!(materialize(&doc), materialize(&reference), "v{n}");
    }
}

/// A format bump without a fixture of the new format would let the old
/// fixtures pass while nothing checks that the new data stays readable.
#[test]
fn cli_formats_have_a_compat_fixture() {
    let (n, newest) = compat_dirs().pop().unwrap();
    let frozen = read_json(&newest.join("versions.json"));
    for (name, current) in [
        ("config", CONFIG_VERSION),
        ("base", BASE_VERSION),
        ("docLog", LOG_FORMAT),
        ("mlsState", u32::from(MLS_STATE_VERSION)),
    ] {
        let frozen = frozen[name].as_u64().unwrap();
        assert!(
            u64::from(current) <= frozen,
            "the {name} format is {current} but fixtures/compat/v{n} froze {frozen}; add fixtures/compat/v{} with `TYPSTRY_WRITE_COMPAT={} cargo test -p typstry-cli --test compat` (see docs/compatibility.md)",
            n + 1,
            n + 1
        );
    }
}

// The generator. Everything that does not have to vary is fixed: keys,
// peer ids, times, salts and IVs. Loro still stamps changes with the
// wall clock, which is fine since the output is written only once.

const AUTHOR: u64 = 7;
const COAUTHOR: u64 = 9;
const SERVER: &str = "https://typstry.example";
const EDIT_TOKEN: &str = "compatEditToken0";
const VIEW_TOKEN: &str = "compatViewToken0";
const PROJECT_ID: &str = "compat-project-0";
const BLOB_PLAINTEXT: &[u8] = b"\x89PNG\r\n\x1a\nnot really a png, but bytes all the same";

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn edit_secret() -> String {
    let mut bytes = [0; 33];
    bytes[0] = SECRET_EDIT_V1;
    for (i, b) in bytes[1..].iter_mut().enumerate() {
        *b = 0xa0 + i as u8;
    }
    b64(&bytes)
}

/// The generation 1 doc key. Fixed so the sealed data below is stable.
fn doc_key() -> [u8; 32] {
    std::array::from_fn(|i| 0xc0 + i as u8)
}

/// The fixture editor's device key. Real devices use their MLS leaf key;
/// records only care that the key is attested and signs.
const SIGNER_SEED: [u8; 32] = [0x5a; 32];
const PRESENCE_EPOCH: u64 = 5;
const PRESENCE_LEAF: u32 = 3;
const PROFILE: &str = r##"{"name":"Ada","color":"#3366cc"}"##;

fn presence_secret() -> [u8; 32] {
    std::array::from_fn(|i| 0xd0 + i as u8)
}

fn text(content: &str) -> Option<FileContent> {
    Some(FileContent::Text(Arc::from(content)))
}

fn write_fixture(out: &Path) {
    let secret = edit_secret();
    let link = LinkSecret::from_base64url(&secret).unwrap();
    let keyring = Keyring::new_with(&link, doc_key());
    let keys = DocKeys::new(keyring.clone());
    let signer = LocalSigner::attested(SIGNER_SEED, &link, 1);
    let blob = keys.seal_with(BLOB_PLAINTEXT, BLOB_CONTEXT, &[5; 12], &[6; 16]);
    let blob_hash = BlobHash::of(&blob);

    let doc = LoroDoc::new();
    doc.set_peer_id(AUTHOR).unwrap();
    init_project(&doc, "Compat v1").unwrap();
    let init_end = *doc.oplog_vv().get(&AUTHOR).unwrap();
    set_peer(&doc, "Ada", "#3366cc").unwrap();
    let changes = BTreeMap::from([
        (
            "chapters/intro.typ".to_owned(),
            text("= Introduction\n\nWritten at format v1.\n"),
        ),
        (
            "figures/logo.png".to_owned(),
            Some(FileContent::Asset {
                hash: blob_hash.as_str().to_owned(),
                size: BLOB_PLAINTEXT.len() as u64,
                mime: "image/png".to_owned(),
            }),
        ),
    ]);
    typstry_doc::apply::apply_changes(&doc, &changes, "add files").unwrap();
    save_version(&doc, "First draft", 1_700_000_000_001).unwrap();
    // What the CLI has as doc.bin; the rest goes into doc.log.
    let cached = doc.export(ExportMode::Snapshot).unwrap();
    let cached_vv = doc.oplog_vv();

    let coauthor = doc.fork();
    coauthor.set_peer_id(COAUTHOR).unwrap();
    set_peer(&coauthor, "Grace", "#cc6633").unwrap();
    let intro = build_path_index(&coauthor).by_path["chapters/intro.typ"];
    let intro_text = text_content(&coauthor, intro).unwrap();
    intro_text
        .insert(intro_text.len_unicode(), "Edited by a second peer.\n")
        .unwrap();
    coauthor.commit();
    doc.import(
        &coauthor
            .export(ExportMode::updates(&doc.oplog_vv()))
            .unwrap(),
    )
    .unwrap();
    let main = typstry_doc::main_file(&doc).unwrap();
    let main_text = text_content(&doc, main).unwrap().to_string();
    let changes = BTreeMap::from([(
        "main.typ".to_owned(),
        text(&format!("{main_text}\n#include \"chapters/intro.typ\"\n")),
    )]);
    typstry_doc::apply::apply_changes(&doc, &changes, "include intro").unwrap();
    let scrapped = save_version(&doc, "Scrapped", 1_700_000_000_002).unwrap();
    let first_log_entry = doc.export(ExportMode::updates(&cached_vv)).unwrap();
    let logged_vv = doc.oplog_vv();

    save_version(&doc, "Final", 1_700_000_000_003).unwrap();
    // Rust has no deleteVersion; this is the entry `deleteVersion` in
    // apps/web/src/doc/versions.ts writes, a JS number keyed by the list
    // element id.
    let scrapped_id = doc
        .get_list(root::VERSIONS)
        .get_id_at(scrapped.index)
        .unwrap();
    let scrapped_key = format!("{}@{}", scrapped_id.counter, scrapped_id.peer);
    doc.get_map(root::DELETED_VERSIONS)
        .insert(&scrapped_key, 1_700_000_000_004_f64)
        .unwrap();
    doc.set_next_commit_message("delete version Scrapped");
    doc.commit();
    let comments = write_comments(&doc, &coauthor);
    let second_log_entry = doc.export(ExportMode::updates(&logged_vv)).unwrap();
    let snapshot = doc.export(ExportMode::Snapshot).unwrap();

    fs::create_dir_all(out).unwrap();
    fs::write(out.join("doc.loro"), &snapshot).unwrap();
    write_json(out, "doc.json", &doc_json(&doc, &scrapped_key, &comments));
    write_json(
        out,
        "crypto.json",
        &crypto_json(
            &Crypto {
                link: &link,
                keyring: &keyring,
                keys: &keys,
                signer: &signer,
            },
            &secret,
            &doc,
            init_end,
            &snapshot,
            &blob,
        ),
    );
    write_json(
        out,
        "versions.json",
        &json!({
            "schema": SCHEMA_VERSION,
            "directory": DIRECTORY_SCHEMA_VERSION,
            "seal": SEAL_VERSION,
            "record": RECORD_VERSION,
            "keyring": KEYRING_VERSION,
            "mlsState": MLS_STATE_VERSION,
            "ds": DS_VERSION,
            "secretEdit": SECRET_EDIT_V1,
            "secretView": SECRET_VIEW_V1,
            "protocol": PROTOCOL_VERSION,
            "minProtocol": MIN_PROTOCOL_VERSION,
            "mailbox": mailbox::PROTOCOL,
            "config": CONFIG_VERSION,
            "base": BASE_VERSION,
            "docLog": LOG_FORMAT,
        }),
    );

    // The CLI's files, written by its own writers into a real state folder.
    let work = tempfile::tempdir().unwrap();
    let state = StateDir::create(work.path()).unwrap();
    state
        .save_config(&Config {
            server: SERVER.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            token: EDIT_TOKEN.to_owned(),
            key: secret.clone(),
            permission: Permission::Write,
            view_token: Some(VIEW_TOKEN.to_owned()),
            name: Some("Ada".to_owned()),
            branch: Some("main".to_owned()),
            owner_person: None,
        })
        .unwrap();
    let git = GitMark {
        branch: Some("main".to_owned()),
        commit: Some("0123456789abcdef0123456789abcdef01234567".to_owned()),
        reflog: Some(3),
    };
    state
        .save_base(&Base {
            frontiers: doc.oplog_frontiers(),
            assets: BTreeMap::from([(blob_hash.clone(), Digest::of(BLOB_PLAINTEXT))]),
            last_sync: Some(1_700_000_000_005),
            pins: BTreeMap::from([("main.typ".to_owned(), frontiers_of("First draft", &doc))]),
            git: Some(git.clone()),
        })
        .unwrap();
    // A one-member group of this device, the way `typstry init` leaves it.
    // Its keyring is a random one: nothing here reads data through it.
    let device = DeviceKey::generate();
    let identity = LocalIdentity {
        graph: PersonGraph::genesis(&device),
        device,
    };
    let (group, _) = SpaceGroup::create(&link, PROFILE.as_bytes(), &identity).unwrap();
    state.save_mls(&group).unwrap();
    state
        .save_doc(&LoroDoc::from_snapshot(&cached).unwrap())
        .unwrap();
    state.append_doc(&first_log_entry).unwrap();
    state.append_doc(&second_log_entry).unwrap();
    let cli = out.join("cli");
    fs::create_dir(&cli).unwrap();
    for name in ["config.json", "base.json", "doc.bin", "doc.log", "mls.bin"] {
        fs::copy(state.dir().join(name), cli.join(name)).unwrap();
    }
    write_json(
        out,
        "cli.json",
        &json!({
            "server": SERVER,
            "projectId": PROJECT_ID,
            "token": EDIT_TOKEN,
            "viewToken": VIEW_TOKEN,
            "name": "Ada",
            "branch": "main",
            "lastSync": 1_700_000_000_005_u64,
            "pins": { "main.typ": "First draft" },
            "git": git,
            "mls": {
                "epoch": group.epoch(),
                "devicePub": b64(&group.device().signer_pub()),
                "profile": PROFILE,
            },
        }),
    );
}

/// Who wrote a comment and when, as far as the record says.
struct Byline {
    name: &'static str,
    color: &'static str,
    created_at: f64,
}

/// One comment record, the way `addComment` and `reply` in
/// apps/web/src/doc/comments.ts write it. Rust has no writer of its own.
fn comment_record(
    thread: Option<&str>,
    file: TreeID,
    text: &LoroText,
    quote: &str,
    body: &str,
    by: &Byline,
) -> LoroValue {
    let from = text.to_string().find(quote).unwrap();
    let to = from + quote.len();
    let cursor = |pos| text.get_cursor(pos, Side::Middle).unwrap().encode();
    let fields: HashMap<String, LoroValue> = [
        (
            comment::THREAD,
            thread.map_or(LoroValue::Null, LoroValue::from),
        ),
        (comment::FILE_ID, LoroValue::from(file.to_string())),
        (comment::TEXT_ID, LoroValue::from(text.id().to_string())),
        // On the first and the last commented character.
        (comment::ANCHOR, LoroValue::from(cursor(from))),
        (comment::HEAD, LoroValue::from(cursor(to - 1))),
        (comment::QUOTE, LoroValue::from(quote)),
        (comment::BODY, LoroValue::from(body)),
        (comment::CREATED_AT, LoroValue::from(by.created_at)),
        (comment::NAME, LoroValue::from(by.name)),
        (comment::COLOR, LoroValue::from(by.color)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    LoroValue::Map(fields.into())
}

/// What `write_comments` wrote, for doc.json.
struct Comments {
    thread: String,
    reply: String,
}

/// A thread on "Hello" in main.typ with a reply by the coauthor, resolved.
fn write_comments(doc: &LoroDoc, coauthor: &LoroDoc) -> Comments {
    let main = typstry_doc::main_file(doc).unwrap();
    let text = text_content(doc, main).unwrap();
    let list = doc.get_list(root::COMMENTS);
    let ada = Byline {
        name: "Ada",
        color: "#3366cc",
        created_at: 1_700_000_000_006.0,
    };
    list.push(comment_record(
        None,
        main,
        &text,
        "Hello",
        "Friendlier?",
        &ada,
    ))
    .unwrap();
    doc.set_next_commit_message("add comment");
    doc.commit();
    let id = list.get_id_at(list.len() - 1).unwrap();
    let thread = format!("{}@{}", id.counter, id.peer);

    coauthor
        .import(
            &doc.export(ExportMode::updates(&coauthor.oplog_vv()))
                .unwrap(),
        )
        .unwrap();
    let theirs = coauthor.get_list(root::COMMENTS);
    let their_text = text_content(coauthor, main).unwrap();
    theirs
        .push(comment_record(
            Some(&thread),
            main,
            &their_text,
            "Hello",
            "Fine as is.",
            &Byline {
                name: "Grace",
                color: "#cc6633",
                created_at: 1_700_000_000_007.0,
            },
        ))
        .unwrap();
    coauthor.set_next_commit_message("reply to comment");
    coauthor.commit();
    let id = theirs.get_id_at(theirs.len() - 1).unwrap();
    let reply = format!("{}@{}", id.counter, id.peer);
    doc.import(
        &coauthor
            .export(ExportMode::updates(&doc.oplog_vv()))
            .unwrap(),
    )
    .unwrap();

    doc.get_map(root::RESOLVED_COMMENTS)
        .insert(&thread, 1_700_000_000_008_f64)
        .unwrap();
    doc.set_next_commit_message("resolve comment");
    doc.commit();
    Comments { thread, reply }
}

fn write_json(dir: &Path, name: &str, value: &Value) {
    let text = serde_json::to_string_pretty(value).unwrap() + "\n";
    fs::write(dir.join(name), text).unwrap();
}

fn doc_json(doc: &LoroDoc, deleted_key: &str, comments: &Comments) -> Value {
    let index = build_path_index(doc);
    let main = typstry_doc::main_file(doc).unwrap();
    let mut dirs: Vec<&str> = index
        .by_id
        .values()
        .filter(|e| e.kind == typstry_doc::FileKind::Dir)
        .map(|e| e.path.as_str())
        .collect();
    dirs.sort();
    let versions: Vec<Value> = named_versions(doc)
        .iter()
        .map(|v| {
            let id = doc.get_list(root::VERSIONS).get_id_at(v.index).unwrap();
            let files: Vec<Value> = materialize_at(doc, &v.frontiers)
                .unwrap()
                .iter()
                .map(|f| file_json(&f.path, &f.content))
                .collect();
            json!({
                "index": v.index,
                "id": format!("{}@{}", id.counter, id.peer),
                "name": v.name,
                "createdAt": v.created_at,
                "author": v.author,
                "files": files,
            })
        })
        .collect();
    let peers: HashMap<String, Value> =
        [(AUTHOR, "Ada", "#3366cc"), (COAUTHOR, "Grace", "#cc6633")]
            .into_iter()
            .map(|(peer, name, color)| (peer.to_string(), json!({ "name": name, "color": color })))
            .collect();
    json!({
        "schema": SCHEMA_VERSION,
        "title": typstry_doc::title(doc),
        "mainFile": index.by_id[&main].path,
        "peers": peers,
        "dirs": dirs,
        "files": materialize(doc).iter().map(|f| file_json(&f.path, &f.content)).collect::<Vec<_>>(),
        "versions": versions,
        "deletedVersions": [{
            "index": 1,
            "id": deleted_key,
            "name": "Scrapped",
            "deletedAt": 1_700_000_000_004_i64,
        }],
        // `range` is the text the anchors cover now.
        "comments": [
            {
                "id": comments.thread,
                "thread": null,
                "peer": AUTHOR.to_string(),
                "file": "main.typ",
                "quote": "Hello",
                "range": "Hello",
                "body": "Friendlier?",
                "createdAt": 1_700_000_000_006_i64,
                "name": "Ada",
                "color": "#3366cc",
            },
            {
                "id": comments.reply,
                "thread": comments.thread,
                "peer": COAUTHOR.to_string(),
                "file": "main.typ",
                "quote": "Hello",
                "range": "Hello",
                "body": "Fine as is.",
                "createdAt": 1_700_000_000_007_i64,
                "name": "Grace",
                "color": "#cc6633",
            },
        ],
        "resolvedComments": [{
            "id": comments.thread,
            "resolvedAt": 1_700_000_000_008_i64,
        }],
    })
}

/// What the fixture's keys and device are, bundled for `crypto_json`.
struct Crypto<'a> {
    link: &'a LinkSecret,
    keyring: &'a Keyring,
    keys: &'a DocKeys,
    signer: &'a LocalSigner,
}

fn crypto_json(
    crypto: &Crypto,
    secret: &str,
    doc: &LoroDoc,
    init_end: i32,
    snapshot: &[u8],
    blob: &[u8],
) -> Value {
    let Crypto {
        link,
        keyring,
        keys,
        signer,
    } = crypto;
    let delta_plain = doc
        .export(ExportMode::updates_in_range(vec![IdSpan::new(
            AUTHOR, 0, init_end,
        )]))
        .unwrap();
    let delta = keys
        .encrypt_delta_with(
            *signer,
            AUTHOR,
            0,
            init_end as u64,
            &delta_plain,
            &[1; 12],
            &[2; 16],
        )
        .unwrap();
    let mut vv: Vec<(u64, u64)> = doc
        .oplog_vv()
        .iter()
        .map(|(peer, counter)| (*peer, *counter as u64))
        .collect();
    vv.sort();
    let snapshot_record = keys
        .encrypt_snapshot_with(*signer, &vv, snapshot, &[3; 12], &[4; 16])
        .unwrap();

    let main = typstry_doc::main_file(doc).unwrap().to_string();
    let presence_key = format!("p:{AUTHOR}");
    let state: HashMap<String, LoroValue> = [
        ("name", LoroValue::from("Ada")),
        ("color", LoroValue::from("#3366cc")),
        ("fileId", LoroValue::from(main.as_str())),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let store = EphemeralStore::new(30_000);
    store.set(&presence_key, state);
    let presence_plain = store.encode_all();
    let presence = PresenceKey::new(PRESENCE_EPOCH, presence_secret()).seal_with(
        *signer,
        PRESENCE_LEAF,
        &presence_plain,
        &[7; 12],
        &[8; 16],
    );

    let profile = keys.seal_with(PROFILE.as_bytes(), PROFILE_CONTEXT, &[9; 12], &[10; 16]);
    let signed_keyring = keyring
        .seal_signed_with(link, &[11; 12], &[12; 16])
        .unwrap();
    let signer_pub = signer.public_key();
    let attestation = signer.attestation(1).unwrap();

    let view_secret = link.view_secret().to_string();
    json!({
        "editSecret": secret,
        "viewSecret": view_secret,
        "fingerprint": link.fingerprint(),
        "editLink": ShareLink::new(SERVER, EDIT_TOKEN, secret).to_string(),
        "viewLink": ShareLink::new(SERVER, VIEW_TOKEN, &view_secret).to_string(),
        "keyring": {
            "generation": keyring.generation(),
            "signed": b64(&signed_keyring),
            "keyId": keys.key_id(),
            "docKey": b64(&doc_key()),
        },
        "signer": {
            "seed": b64(&SIGNER_SEED),
            "publicKey": b64(&signer_pub),
            "attestation": b64(&attestation),
            "generation": 1,
        },
        "delta": {
            "peer": AUTHOR.to_string(),
            "start": 0,
            "end": init_end,
            "record": b64(&delta),
            "plaintext": b64(&delta_plain),
            "title": "Compat v1",
        },
        "snapshot": {
            "vv": vv.iter().map(|(p, c)| json!([p.to_string(), c])).collect::<Vec<_>>(),
            "record": b64(&snapshot_record),
            "plaintextFile": "doc.loro",
        },
        "blob": {
            "sealed": b64(blob),
            "plaintext": b64(BLOB_PLAINTEXT),
        },
        "profile": {
            "sealed": b64(&profile),
            "plaintext": PROFILE,
        },
        "presence": {
            "sealed": b64(&presence),
            "plaintext": b64(&presence_plain),
            "epoch": PRESENCE_EPOCH,
            "leaf": PRESENCE_LEAF,
            "key": b64(&presence_secret()),
            "storeKey": presence_key,
            "state": { "name": "Ada", "color": "#3366cc", "fileId": main },
        },
    })
}

#[test]
fn write_compat_fixture() {
    let Ok(n) = std::env::var("TYPSTRY_WRITE_COMPAT") else {
        return;
    };
    let n: u32 = n
        .parse()
        .expect("TYPSTRY_WRITE_COMPAT is the format version to write, e.g. 1");
    let target = compat_root().join(format!("v{n}"));
    assert!(
        !target.exists(),
        "{} exists; compat fixtures are frozen and never regenerated",
        target.display()
    );
    // Built next to the target and renamed into place, so a failed run
    // never leaves a half-written version behind.
    fs::create_dir_all(compat_root()).unwrap();
    let staging = tempfile::tempdir_in(compat_root()).unwrap();
    let out = staging.path().join("out");
    write_fixture(&out);
    fs::write(out.join("README.md"), readme(n)).unwrap();
    fs::rename(&out, &target).unwrap();
}

fn readme(n: u32) -> String {
    format!(
        "# Compatibility fixtures, format v{n}

Generated once with `TYPSTRY_WRITE_COMPAT={n} cargo test -p typstry-cli --test compat`
when these formats were frozen. Don't regenerate or edit anything in here.
Every later typstry has to keep reading it, which the `compat` tests of
typstry-wire, typstry-doc and typstry-cli and `apps/web/src/compat.test.ts`
check against the current code.

When a format version goes up (see `versions.json` and
`docs/compatibility.md`), add a new `v<N>` directory with the generator
instead of touching this one.

The v1 set was written for the MLS format. An earlier draft of v1 (one
project key, no groups) was dropped before any release, so nothing in the
wild uses it.

- `versions.json`: the format versions in force when this was written,
  including `mlsState` (the saved group state) and `ds` (the delivery
  service messages).
- `doc.loro`, `doc.json`: a project snapshot (text files, an asset, peers,
  named versions, a deleted version) and what it has to read as.
- `directory.loro`, `directory.json`: a person's directory (links,
  retired links, titles, states, owner keys) and what it has to list.
  Written by `TYPSTRY_WRITE_COMPAT_DIRECTORY={n} cargo test -p typstry-doc
  --test compat`, since the directory is that crate's.
- `crypto.json`: the edit and view secrets and share links; the signed,
  sealed keyring with its key id and generation 1 doc key; a fixed device
  key with the editor attestation made for it; a delta and a snapshot
  record signed by that device (the snapshot's plaintext is `doc.loro`); a
  generation-tagged blob (the asset in the doc); a sealed profile; and a
  presence update, with the raw presence key, epoch and leaf it was sealed
  under (MLS derives that key per epoch, so it is stored here as is). All
  with their plaintexts.
- `cli/`: the CLI's `.typstry/` files (`config.json`, `base.json`,
  `doc.bin`, `doc.log` with its header, `mls.bin` the saved group state),
  `cli.json` what they hold. `mls.bin` comes from a real group, so its
  keys are random and only its public facts are recorded.
"
    )
}
