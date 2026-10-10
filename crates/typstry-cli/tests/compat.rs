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
use loro::{ExportMode, Frontiers, IdSpan, LoroDoc, LoroValue};
use serde_json::{Value, json};

use typstry_cli::api::Permission;
use typstry_cli::git::GitMark;
use typstry_cli::hash::{BlobHash, Digest};
use typstry_cli::link::ShareLink;
use typstry_cli::mailbox;
use typstry_cli::state::{
    BASE_VERSION, Base, CONFIG_VERSION, Config, LOG_FORMAT, STATE_DIR, StateDir,
};
use typstry_doc::init::init_project;
use typstry_doc::materialize::{FileContent, materialize, materialize_at};
use typstry_doc::paths::build_path_index;
use typstry_doc::peers::set_peer;
use typstry_doc::versions::{named_versions, save_version};
use typstry_doc::{SCHEMA_VERSION, root, text_content};
use typstry_wire::crypto::{
    BLOB_CONTEXT, PRESENCE_CONTEXT, ProjectKey, RECORD_VERSION, SEAL_VERSION, SECRET_EDIT_V1,
    SECRET_VIEW_V1,
};
use typstry_wire::{MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};

fn compat_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/compat")
}

/// Every `v<N>` directory, oldest first.
fn compat_dirs() -> Vec<(u32, PathBuf)> {
    let mut dirs: Vec<_> = fs::read_dir(compat_root())
        .expect("fixtures/compat is missing")
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            let n = path
                .file_name()?
                .to_str()?
                .strip_prefix('v')?
                .parse()
                .ok()?;
            path.is_dir().then_some((n, path))
        })
        .collect();
    dirs.sort();
    assert!(!dirs.is_empty(), "no compat/v<N> fixtures found");
    dirs
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

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
        assert_eq!(config.version, CONFIG_VERSION, "v{n}");
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
        assert_eq!(base.version, BASE_VERSION, "v{n}");
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

        // doc.bin plus every doc.log entry has to add up to the whole doc.
        // A log mistaken for a newer format would be dropped with a warning.
        let (doc, warning) = state.load_doc_noting().unwrap();
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

fn text(content: &str) -> Option<FileContent> {
    Some(FileContent::Text(Arc::from(content)))
}

fn write_fixture(out: &Path) {
    let secret = edit_secret();
    let key = ProjectKey::from_base64url(&secret).unwrap();
    let blob = key.seal_with(BLOB_PLAINTEXT, BLOB_CONTEXT, &[5; 12], &[6; 16]);
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
    let second_log_entry = doc.export(ExportMode::updates(&logged_vv)).unwrap();
    let snapshot = doc.export(ExportMode::Snapshot).unwrap();

    fs::create_dir_all(out).unwrap();
    fs::write(out.join("doc.loro"), &snapshot).unwrap();
    write_json(out, "doc.json", &doc_json(&doc, &scrapped_key));
    write_json(
        out,
        "crypto.json",
        &crypto_json(&key, &secret, &doc, init_end, &snapshot, &blob),
    );
    write_json(
        out,
        "versions.json",
        &json!({
            "schema": SCHEMA_VERSION,
            "seal": SEAL_VERSION,
            "record": RECORD_VERSION,
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
            version: CONFIG_VERSION,
            server: SERVER.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            token: EDIT_TOKEN.to_owned(),
            key: secret.clone(),
            permission: Permission::Write,
            view_token: Some(VIEW_TOKEN.to_owned()),
            name: Some("Ada".to_owned()),
            branch: Some("main".to_owned()),
        })
        .unwrap();
    let git = GitMark {
        branch: Some("main".to_owned()),
        commit: Some("0123456789abcdef0123456789abcdef01234567".to_owned()),
        reflog: Some(3),
    };
    state
        .save_base(&Base {
            version: BASE_VERSION,
            frontiers: doc.oplog_frontiers(),
            assets: BTreeMap::from([(blob_hash.clone(), Digest::of(BLOB_PLAINTEXT))]),
            last_sync: Some(1_700_000_000_005),
            pins: BTreeMap::from([("main.typ".to_owned(), frontiers_of("First draft", &doc))]),
            git: Some(git.clone()),
        })
        .unwrap();
    state
        .save_doc(&LoroDoc::from_snapshot(&cached).unwrap())
        .unwrap();
    state.append_doc(&first_log_entry).unwrap();
    state.append_doc(&second_log_entry).unwrap();
    let cli = out.join("cli");
    fs::create_dir(&cli).unwrap();
    for name in ["config.json", "base.json", "doc.bin", "doc.log"] {
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
        }),
    );
}

fn write_json(dir: &Path, name: &str, value: &Value) {
    let text = serde_json::to_string_pretty(value).unwrap() + "\n";
    fs::write(dir.join(name), text).unwrap();
}

fn file_json(path: &str, content: &FileContent) -> Value {
    match content {
        FileContent::Text(text) => json!({ "path": path, "kind": "text", "text": &**text }),
        FileContent::Asset { hash, size, mime } => json!({
            "path": path, "kind": "asset", "hash": hash, "size": size, "mime": mime,
        }),
    }
}

fn doc_json(doc: &LoroDoc, deleted_key: &str) -> Value {
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
    })
}

fn crypto_json(
    key: &ProjectKey,
    secret: &str,
    doc: &LoroDoc,
    init_end: i32,
    snapshot: &[u8],
    blob: &[u8],
) -> Value {
    let delta_plain = doc
        .export(ExportMode::updates_in_range(vec![IdSpan::new(
            AUTHOR, 0, init_end,
        )]))
        .unwrap();
    let delta = key
        .encrypt_delta_with(AUTHOR, 0, init_end as u64, &delta_plain, &[1; 12], &[2; 16])
        .unwrap();
    let mut vv: Vec<(u64, u64)> = doc
        .oplog_vv()
        .iter()
        .map(|(peer, counter)| (*peer, *counter as u64))
        .collect();
    vv.sort();
    let snapshot_record = key
        .encrypt_snapshot_with(&vv, snapshot, &[3; 12], &[4; 16])
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
    let presence = key.seal_with(&presence_plain, PRESENCE_CONTEXT, &[7; 12], &[8; 16]);

    let view_secret = key.view_secret().to_string();
    json!({
        "editSecret": secret,
        "viewSecret": view_secret,
        "keyId": key.key_id(),
        "editLink": ShareLink::new(SERVER, EDIT_TOKEN, secret).to_string(),
        "viewLink": ShareLink::new(SERVER, VIEW_TOKEN, &view_secret).to_string(),
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
        "presence": {
            "sealed": b64(&presence),
            "plaintext": b64(&presence_plain),
            "key": presence_key,
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

- `versions.json`: the format versions in force when this was written.
- `doc.loro`, `doc.json`: a project snapshot (text files, an asset, peers,
  named versions, a deleted version) and what it has to read as.
- `crypto.json`: edit and view secrets, share links, a delta and a snapshot
  record (the snapshot's plaintext is `doc.loro`), a sealed blob (the asset
  in the doc) and a sealed presence update, with their plaintexts.
- `cli/`: the CLI's `.typstry/` files (`config.json`, `base.json`,
  `doc.bin`, `doc.log` with its header), `cli.json` what they hold.
"
    )
}
