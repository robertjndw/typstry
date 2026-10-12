//! Group membership against an in-process server: joining on clone, the
//! member list, removal, and following a rotation that happened while a
//! folder was offline.

mod common;

use common::{
    Server, assert_private, binary, binary_with, clone, config_in, failed, read, run_as, stderr,
    stdout, temp, typstry,
};

use std::fs;
use std::path::Path;

use base64::Engine;

use typstry_cli::engine::Session;
use typstry_cli::link::ShareLink;
use typstry_cli::mls::{Ds, Reply};
use typstry_cli::state::{Config, STATE_DIR, StateDir};
use typstry_doc::init::starter_content;
use typstry_wire::mls::{SpaceGroup, SubmitPayload};

fn config(dir: &Path) -> Config {
    StateDir::peek_config(dir).unwrap()
}

/// This folder's leaf in the project's group.
fn own_leaf(dir: &Path) -> u32 {
    let session = Session::open(dir, None).unwrap();
    session
        .members()
        .unwrap()
        .into_iter()
        .find(|m| m.is_self)
        .expect("the folder is a member")
        .leaf
}

#[tokio::test(flavor = "multi_thread")]
async fn clone_joins_the_group_and_members_lists_everyone() {
    let server = Server::start().await;
    let (edit, view) = server.seeded_project("Group").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let v = clone(&view, &work, "v").await;

    let state = fs::read(a.join(STATE_DIR).join("mls.bin")).unwrap();
    assert_eq!(state[0], typstry_wire::mls::MLS_STATE_VERSION);
    assert_private(&a.join(STATE_DIR).join("mls.bin"));

    // The browser that made the project, the seeding session, the two clones.
    let listing = stdout(&binary(&a, &["members"]).await);
    assert!(listing.contains("Browser"), "{listing}");
    assert!(listing.contains("Seeder"), "{listing}");
    assert_eq!(listing.matches("(you)").count(), 1, "{listing}");
    // Everyone in these tests shares one config dir, so one owner person.
    let owners = listing
        .lines()
        .filter(|l| l.starts_with("    #") && l.contains("owner"))
        .count();
    assert_eq!(owners, 3, "{listing}");
    assert!(listing.contains("(owner)"), "{listing}");
    assert_eq!(listing.matches("editor").count(), 0, "{listing}");
    assert_eq!(listing.matches("viewer").count(), 1, "{listing}");
    assert!(listing.contains("Members (4)"), "{listing}");

    // A viewer joins too and reads the same list, but cannot remove anyone.
    let from_view = stdout(&binary(&v, &["members"]).await);
    assert!(from_view.contains("Members (4)"), "{from_view}");
    let err = failed(&binary(&v, &["members", "remove", "0"]).await);
    assert!(err.contains("only the project owner"), "{err}");
    let err = failed(&binary(&v, &["share", "reset"]).await);
    assert!(err.contains("only the project owner"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_folder_is_told_so_and_the_others_follow() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Remove").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let b = clone(&edit, &work, "b").await;
    let c = clone(&edit, &work, "c").await;
    let old = config(&b);

    let leaf = own_leaf(&c);
    typstry(&a, &["members", "remove", &leaf.to_string()])
        .await
        .unwrap();

    // The remover now holds new links and the old edit link is gone.
    let new = config(&a);
    assert_ne!(new.token, old.token);
    assert_ne!(new.key, old.key);
    let err = typstry(&work, &["clone", &old.link().to_string(), "again"])
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("replaced"), "{err:#}");

    // The removed folder is told, every time, and its files stay.
    for command in ["pull", "status", "members"] {
        let err = typstry(&c, &[command]).await.unwrap_err();
        assert!(format!("{err:#}").contains("you were removed"), "{err:#}");
    }
    assert_eq!(read(&c, "main.typ"), starter_content("Remove"));
    let config_c = config(&c);
    assert_eq!(
        config_c.token, old.token,
        "a removed folder gets no new link"
    );

    // The other member follows without being told anything.
    fs::write(a.join("notes.typ"), "after the removal\n").unwrap();
    typstry(&a, &["push"]).await.unwrap();
    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "notes.typ"), "after the removal\n");
    let followed = config(&b);
    assert_eq!(followed.token, new.token);
    assert_eq!(followed.key, new.key);
    assert_eq!(followed.view_token, new.view_token);

    // And the group is smaller by one.
    let listing = stdout(&binary(&b, &["members"]).await);
    assert!(listing.contains("Members (4)"), "{listing}");
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_by_name_and_self_removal() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Names").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;

    let own = own_leaf(&a);
    let err = typstry(&a, &["members", "remove", &own.to_string()])
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("cannot remove itself"),
        "{err:#}"
    );
    let err = typstry(&a, &["members", "remove", "nobody"])
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("no member named"), "{err:#}");
    let err = typstry(&a, &["members", "remove", "99"]).await.unwrap_err();
    assert!(format!("{err:#}").contains("no member #99"), "{err:#}");

    let before = config(&a);
    typstry(&a, &["members", "remove", "browser"])
        .await
        .unwrap();
    assert_ne!(config(&a).token, before.token);
    let listing = stdout(&binary(&a, &["members"]).await);
    assert!(!listing.contains("Browser"), "{listing}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_offline_during_a_rotation_follows_it_on_the_next_sync() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Offline").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let b = clone(&edit, &work, "b").await;
    let c = clone(&edit, &work, "c").await;
    let before = config(&b);

    // Two rotations while b does not run.
    typstry(&a, &["members", "remove", &own_leaf(&c).to_string()])
        .await
        .unwrap();
    typstry(&a, &["share", "reset"]).await.unwrap();
    fs::write(a.join("late.typ"), "written under the newest keys\n").unwrap();
    typstry(&a, &["push"]).await.unwrap();
    let latest = config(&a);

    typstry(&b, &["pull"]).await.unwrap();
    assert_eq!(read(&b, "late.typ"), "written under the newest keys\n");
    let after = config(&b);
    assert_ne!(after.token, before.token);
    assert_eq!(after.token, latest.token);
    assert_eq!(after.key, latest.key);
    assert_eq!(after.view_token, latest.view_token);

    // b is a working editor under the new links.
    fs::write(b.join("from-b.typ"), "b again\n").unwrap();
    typstry(&b, &["push"]).await.unwrap();
    typstry(&a, &["pull"]).await.unwrap();
    assert_eq!(read(&a, "from-b.typ"), "b again\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn resetting_the_links_invalidates_the_old_ones() {
    let server = Server::start().await;
    let (edit, view) = server.seeded_project("Reset").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let v = clone(&view, &work, "v").await;
    let old_edit = ShareLink::parse(&edit).unwrap();

    let out = stdout(&binary(&a, &["share", "reset"]).await);
    assert!(out.contains("Edit: "), "{out}");
    assert!(out.contains("View: "), "{out}");
    let new_edit = stdout(&binary(&a, &["link", "--edit"]).await);
    let new_view = stdout(&binary(&a, &["link", "--view"]).await);
    assert_ne!(new_edit.trim(), edit);
    assert_ne!(new_view.trim(), view);
    assert!(out.contains(new_edit.trim()), "{out}");

    // The old links no longer open the project.
    for old in [&edit, &view] {
        let err = typstry(&work, &["clone", old, "stale"]).await.unwrap_err();
        assert!(format!("{err:#}").contains("replaced"), "{err:#}");
    }
    assert!(!work.join("stale").exists());
    let share = typstry_cli::api::Api::new(&old_edit.origin)
        .unwrap()
        .resolve_share(&old_edit.token)
        .await
        .unwrap();
    assert!(share.retired);

    // The new ones do.
    let fresh = clone(new_edit.trim(), &work, "fresh").await;
    assert_eq!(read(&fresh, "main.typ"), starter_content("Reset"));

    // A viewer on the old link is moved to the new view link.
    typstry(&v, &["pull"]).await.unwrap();
    let moved = config(&v);
    assert_eq!(moved.link().to_string(), new_view.trim());
    assert!(!moved.can_sign());
}

/// Makes a rotation the way an interrupted run would leave it: the commit
/// built and saved with the folder's group state as pending, and, if
/// `send`, delivered to the server with the reply never seen.
async fn interrupted_rotation(dir: &Path, send: bool) -> SubmitPayload {
    let path = dir.join(STATE_DIR).join("mls.bin");
    let mut group = SpaceGroup::import_state(&fs::read(&path).unwrap()).unwrap();
    let payload = group.reset_links().unwrap();
    fs::write(&path, group.export_state().as_slice()).unwrap();
    if send {
        let config = config(dir);
        let mut ds = Ds::connect(
            &config.server,
            &config.token,
            u64::from(group.incarnation()),
            payload.epoch,
        )
        .await
        .unwrap();
        let reply = ds.request(1, &payload.clone().into_message(1)).await;
        ds.close().await;
        assert!(matches!(reply.unwrap(), Reply::Accepted));
    }
    payload
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rotation_whose_reply_was_lost_is_confirmed_by_the_log() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Lost").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    typstry(&a, &["pull"]).await.unwrap();
    let old = config(&a);

    let payload = interrupted_rotation(&a, true).await;
    let rotate = payload.rotate.unwrap();

    // The folder still holds the retired token; the next run reads the log
    // up to the rotation and adopts what its own commit carried.
    typstry(&a, &["pull"]).await.unwrap();
    let now = config(&a);
    assert_eq!(now.token, rotate.edit_token);
    assert_ne!(now.key, old.key);
    fs::write(a.join("after.typ"), "still an editor\n").unwrap();
    typstry(&a, &["push"]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rotation_that_never_left_is_sent_again_not_rebuilt() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Unsent").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    typstry(&a, &["pull"]).await.unwrap();

    let payload = interrupted_rotation(&a, false).await;
    let rotate = payload.rotate.unwrap();
    typstry(&a, &["share", "reset"]).await.unwrap();
    assert_eq!(config(&a).token, rotate.edit_token);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reset_does_not_rotate_twice_when_the_earlier_one_landed() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Once").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    typstry(&a, &["pull"]).await.unwrap();

    let payload = interrupted_rotation(&a, true).await;
    let rotate = payload.rotate.unwrap();
    typstry(&a, &["share", "reset"]).await.unwrap();
    assert_eq!(config(&a).token, rotate.edit_token);
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_member_names_it_by_key_not_by_a_leaf_that_was_reused() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Reuse").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let b = clone(&edit, &work, "b").await;
    let c = clone(&edit, &work, "c").await;

    let mut stale = Session::open(&a, None).unwrap();
    stale.follow_group().await.unwrap();
    let c_key = stale
        .members()
        .unwrap()
        .into_iter()
        .find(|m| m.leaf == own_leaf(&c))
        .unwrap()
        .sig_pub;

    // c goes, and d takes the freed leaf.
    typstry(&b, &["members", "remove", &own_leaf(&c).to_string()])
        .await
        .unwrap();
    let d = clone(&config(&b).link().to_string(), &work, "d").await;

    let err = stale.remove_members(&[c_key]).await.unwrap_err();
    assert!(format!("{err:#}").contains("already gone"), "{err:#}");
    drop(stale);
    let listing = stdout(&binary(&d, &["members"]).await);
    assert!(listing.contains("(you)"), "{listing}");
    typstry(&d, &["pull"]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_group_state_rejoins_as_the_same_device() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Device").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let dir = a.join(STATE_DIR);
    let device = fs::read(dir.join("device.bin")).unwrap();
    assert_private(&dir.join("device.bin"));
    let before = stdout(&binary(&a, &["members"]).await);

    let damaged = fs::read(dir.join("mls.bin")).unwrap();
    fs::write(dir.join("mls.bin"), &damaged[..damaged.len() / 2]).unwrap();
    typstry(&a, &["pull"]).await.unwrap();

    assert_eq!(fs::read(dir.join("device.bin")).unwrap(), device);
    // The old leaf was replaced, not left behind.
    let after = stdout(&binary(&a, &["members"]).await);
    assert_eq!(before.lines().next(), after.lines().next(), "{after}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_group_that_cannot_be_followed_does_not_stop_doc_sync() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Warn").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    let b = clone(&edit, &work, "b").await;

    // a starts the group over, so b has to join again; with a wrong key in
    // its config that join fails.
    let path = a.join(STATE_DIR).join("mls.bin");
    let group = SpaceGroup::import_state(&fs::read(&path).unwrap()).unwrap();
    let (_next, reset) = group
        .reset(b"{\"name\":\"a\",\"color\":\"#000\"}", None)
        .unwrap();
    let cfg = config(&a);
    let mut ds = Ds::connect(&cfg.server, &cfg.token, 0, group.epoch())
        .await
        .unwrap();
    let reply = ds.request(1, &reset.into_message(1)).await.unwrap();
    ds.close().await;
    assert!(matches!(reply, Reply::Accepted));

    let config_path = b.join(STATE_DIR).join("config.json");
    let mut json: serde_json::Value =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    json["key"] = typstry_wire::crypto::LinkSecret::generate_edit()
        .to_base64url()
        .to_string()
        .into();
    fs::write(&config_path, serde_json::to_vec(&json).unwrap()).unwrap();

    fs::write(b.join("note.typ"), "synced anyway\n").unwrap();
    let out = binary(&b, &["push"]).await;
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(stderr(&out).contains("member group"), "{}", stderr(&out));
}

/// Runs the binary as the person whose keys live in `config`.
async fn as_person(dir: &Path, config: &Path, args: &[&str]) -> std::process::Output {
    let config = config.to_str().unwrap();
    binary_with(dir, args, "", &[("TYPSTRY_CONFIG_DIR", config)]).await
}

/// Creates a project from a new folder as the person whose keys live in
/// `config`, which makes that person its owner.
async fn init_as(server: &Server, parent: &Path, name: &str, config: &Path) -> std::path::PathBuf {
    let out = as_person(
        parent,
        config,
        &["init", name, "--server", &server.origin, "--yes"],
    )
    .await;
    stdout(&out);
    parent.join(name).canonicalize().unwrap()
}

async fn clone_as(link: &str, parent: &Path, name: &str, config: &Path) -> std::path::PathBuf {
    let out = as_person(parent, config, &["clone", link, name]).await;
    stdout(&out);
    parent.join(name).canonicalize().unwrap()
}

/// The fingerprint on the first `Person` line that is marked `(you)`.
fn own_fingerprint(listing: &str) -> String {
    listing
        .lines()
        .find(|l| l.contains("Person ") && l.contains("(you)"))
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or_else(|| panic!("no own person in {listing}"))
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn devices_of_one_person_are_listed_together_and_removed_together() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let (_other_cfg, other_cfg) = temp();
    let c = init_as(&server, &work, "c", &other_cfg).await;
    let edit = stdout(&as_person(&c, &other_cfg, &["link", "--edit"]).await);
    let a = clone_as(edit.trim(), &work, "a", &cfg).await;
    let b = clone_as(edit.trim(), &work, "b", &cfg).await;

    let listing = stdout(&as_person(&a, &cfg, &["members"]).await);
    let fingerprint = own_fingerprint(&listing);
    println!("{listing}");
    let own: Vec<_> = listing
        .lines()
        .skip_while(|l| !l.contains(&fingerprint))
        .skip(1)
        .take_while(|l| l.starts_with("    #"))
        .collect();
    assert_eq!(own.len(), 2, "{listing}");
    assert_eq!(listing.matches("(this device)").count(), 1, "{listing}");

    // A prefix is enough, and the owner removes both.
    let out = as_person(&c, &other_cfg, &["members", "remove", &fingerprint[..6]]).await;
    let text = stdout(&out);
    assert!(text.contains("Removed person"), "{text}");
    for dir in [&a, &b] {
        let err = failed(&as_person(dir, &cfg, &["members"]).await);
        assert!(err.contains("you were removed"), "{err}");
    }
    let listing = stdout(&as_person(&c, &other_cfg, &["members"]).await);
    assert!(!listing.contains(&fingerprint), "{listing}");
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_person_needs_a_unique_fingerprint_and_another_device() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let a = init_as(&server, &work, "a", &cfg).await;

    let listing = stdout(&as_person(&a, &cfg, &["members"]).await);
    let fingerprint = own_fingerprint(&listing);
    let err = failed(&as_person(&a, &cfg, &["members", "remove", &fingerprint]).await);
    assert!(err.contains("cannot remove itself"), "{err}");
    let err = failed(&as_person(&a, &cfg, &["members", "remove", "zzzzzzzz"]).await);
    assert!(err.contains("no member named"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn clones_are_recorded_in_the_project_list() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Listed").await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let a = clone_as(&edit, &work, "a", &cfg).await;

    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(cfg.join("projects.json")).unwrap()).unwrap();
    assert_eq!(file["version"], 1);
    let projects = file["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1, "{file}");
    assert_eq!(projects[0]["dir"], a.to_str().unwrap());
    assert_eq!(projects[0]["link"], edit);
    assert_eq!(projects[0]["title"], "Listed");
    assert_private(&cfg.join("device.key"));

    // A rotation moves the stored link along. It takes the owner to make one.
    let owner = clone(&edit, &work, "owner").await;
    stdout(&binary(&owner, &["share", "reset"]).await);
    stdout(&as_person(&a, &cfg, &["pull"]).await);
    let file: serde_json::Value =
        serde_json::from_slice(&fs::read(cfg.join("projects.json")).unwrap()).unwrap();
    assert_eq!(file["projects"].as_array().unwrap().len(), 1, "{file}");
    assert_ne!(file["projects"][0]["link"], edit);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_device_key_is_an_error_and_stays() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Damaged").await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    fs::write(cfg.join("device.key"), b"not a key").unwrap();

    let out = as_person(&work, &cfg, &["clone", &edit, "a"]).await;
    let err = failed(&out);
    assert!(err.contains("device.key"), "{err}");
    assert_eq!(fs::read(cfg.join("device.key")).unwrap(), b"not a key");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_person_graph_is_an_error_and_stays() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Damaged graph").await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    fs::write(cfg.join("person.graph"), b"not a graph").unwrap();

    let out = as_person(&work, &cfg, &["clone", &edit, "a"]).await;
    let err = failed(&out);
    assert!(err.contains("person.graph"), "{err}");
    assert_eq!(fs::read(cfg.join("person.graph")).unwrap(), b"not a graph");
}

/// The number of the first member listed as `role` that is not this device.
fn other_leaf(listing: &str, role: &str) -> String {
    listing
        .lines()
        .filter(|l| l.trim_start().starts_with('#') && !l.contains("(this device)"))
        .find(|l| l.contains(role))
        .and_then(|l| l.trim_start().strip_prefix('#'))
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or_else(|| panic!("no {role} in {listing}"))
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_creator_is_the_owner_and_the_person_is_pinned() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let a = init_as(&server, &work, "a", &cfg).await;

    // Ownership is the person. The project's owner key, which the server
    // wants rotations signed with, is as private as the device key.
    let owner_keys: Vec<_> = fs::read_dir(cfg.join("owner-keys"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(owner_keys.len(), 1, "{owner_keys:?}");
    for path in [
        cfg.join("device.key"),
        cfg.join("person.graph"),
        owner_keys[0].clone(),
    ] {
        assert_private(&path);
    }
    // The owner person is pinned for later rejoins.
    assert!(config(&a).owner_person.is_some());
    let listing = stdout(&as_person(&a, &cfg, &["members"]).await);
    assert!(listing.contains("(owner)"), "{listing}");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_owner_removes_members_or_resets_links() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_owner_cfg, owner_cfg) = temp();
    let (_editor_cfg, editor_cfg) = temp();
    let (_other_cfg, other_cfg) = temp();
    let o = init_as(&server, &work, "o", &owner_cfg).await;
    let edit = stdout(&as_person(&o, &owner_cfg, &["link", "--edit"]).await);
    let e = clone_as(edit.trim(), &work, "e", &editor_cfg).await;
    let x = clone_as(edit.trim(), &work, "x", &other_cfg).await;

    let listing = stdout(&as_person(&e, &editor_cfg, &["members"]).await);
    assert!(listing.contains("editor"), "{listing}");
    let leaf = other_leaf(&listing, "owner");
    let err = failed(&as_person(&e, &editor_cfg, &["members", "remove", &leaf]).await);
    assert!(
        err.contains("Only the project owner can remove members or reset links."),
        "{err}"
    );
    let err = failed(&as_person(&e, &editor_cfg, &["share", "reset"]).await);
    assert!(err.contains("Only the project owner"), "{err}");

    // Nothing moved, and the owner can.
    let before = config(&e).token;
    let listing = stdout(&as_person(&o, &owner_cfg, &["members"]).await);
    let leaf = other_leaf(&listing, "editor");
    stdout(&as_person(&o, &owner_cfg, &["members", "remove", &leaf]).await);
    assert_ne!(config(&o).token, before);
    stdout(&as_person(&o, &owner_cfg, &["share", "reset"]).await);
    drop(x);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejoin_refuses_a_group_whose_owner_is_not_the_pinned_one() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Pinned").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;
    assert!(config(&a).owner_person.is_some());

    let path = a.join(STATE_DIR).join("config.json");
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    json["ownerPerson"] =
        serde_json::json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]));
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    fs::remove_file(a.join(STATE_DIR).join("mls.bin")).unwrap();

    let err = typstry(&a, &["pull"]).await.unwrap_err();
    assert!(
        format!("{err:#}").contains(
            "The project's member group now claims a different owner. Refusing to rejoin."
        ),
        "{err:#}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_owner_pin_stops_the_join_and_leaves_the_config() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Damaged pin").await;
    let (_work, work) = temp();
    let a = clone(&edit, &work, "a").await;

    let path = a.join(STATE_DIR).join("config.json");
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    json["ownerPerson"] = serde_json::json!("not a person id");
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    let damaged = fs::read(&path).unwrap();
    fs::remove_file(a.join(STATE_DIR).join("mls.bin")).unwrap();

    let err = typstry(&a, &["pull"]).await.unwrap_err();
    assert!(format!("{err:#}").contains("is damaged"), "{err:#}");
    assert_eq!(fs::read(&path).unwrap(), damaged);
}

#[tokio::test(flavor = "multi_thread")]
async fn another_folder_of_the_same_machine_rotates_without_waiting_for_the_key() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let o = init_as(&server, &work, "o", &cfg).await;
    let edit = stdout(&as_person(&o, &cfg, &["link", "--edit"]).await);

    // A second leaf of the same device: no other owner device has to hand
    // it the key first, the machine has it.
    let again = clone_as(edit.trim(), &work, "again", &cfg).await;
    let listing = stdout(&as_person(&again, &cfg, &["members"]).await);
    assert!(!listing.contains("no owner key"), "{listing}");
    stdout(&as_person(&again, &cfg, &["share", "reset"]).await);
    stdout(&as_person(&o, &cfg, &["share", "reset"]).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_group_state_keeps_the_owner_key() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let o = init_as(&server, &work, "o", &cfg).await;
    let dir = o.join(STATE_DIR);
    assert_private(&dir.join("owner.bin"));

    // Only the folder's own copy is left to carry the key over.
    fs::remove_dir_all(cfg.join("owner-keys")).unwrap();
    let damaged = fs::read(dir.join("mls.bin")).unwrap();
    fs::write(dir.join("mls.bin"), &damaged[..damaged.len() / 2]).unwrap();
    stdout(&as_person(&o, &cfg, &["pull"]).await);

    let listing = stdout(&as_person(&o, &cfg, &["members"]).await);
    assert!(listing.contains("Members (1)"), "{listing}");
    assert!(!listing.contains("no owner key"), "{listing}");
    stdout(&as_person(&o, &cfg, &["share", "reset"]).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_owner_key_survives_a_rejoin_after_the_log_was_pruned() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let (_cfg, cfg) = temp();
    let o = init_as(&server, &work, "o", &cfg).await;
    let edit = stdout(&as_person(&o, &cfg, &["link", "--edit"]).await);
    clone(edit.trim(), &work, "e").await;
    let f = clone(edit.trim(), &work, "f").await;

    // Two joins later, the server keeps only the newest commit, so o can no
    // longer follow and has to join again.
    let state = |dir: &Path| {
        SpaceGroup::import_state(&fs::read(dir.join(STATE_DIR).join("mls.bin")).unwrap()).unwrap()
    };
    let head = state(&f);
    assert_eq!(state(&o).epoch() + 2, head.epoch());
    let limits = typstry_server::store::mls::PruneLimits {
        older_than: 0,
        keep_last: 1,
        max_bytes: u64::MAX,
    };
    let gone = typstry_server::store::mls::prune_commits(
        &server.state.db,
        &config(&o).project_id,
        u64::from(head.incarnation()),
        head.epoch(),
        limits,
    )
    .await
    .unwrap();
    assert!(gone > 0);

    // Nothing but the old group state holds the key now.
    fs::remove_dir_all(cfg.join("owner-keys")).unwrap();
    fs::remove_file(o.join(STATE_DIR).join("owner.bin")).unwrap();
    stdout(&as_person(&o, &cfg, &["pull"]).await);
    // The rejoin is the one commit since.
    assert_eq!(state(&o).epoch(), head.epoch() + 1);
    assert!(o.join(STATE_DIR).join("owner.bin").exists());

    stdout(&as_person(&o, &cfg, &["share", "reset"]).await);
    typstry(&f, &["pull"]).await.unwrap();
    assert_eq!(config(&f).token, config(&o).token);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_the_person_was_removed_from_is_unavailable_in_the_list() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let owner_cfg = config_in(&work, "owner-cfg");
    let member_cfg = config_in(&work, "member-cfg");
    let a = init_as(&server, &work, "shared", &owner_cfg).await;
    let edit = stdout(&run_as(&a, &owner_cfg, &["link", "--edit"]).await);
    let b = clone_as(edit.trim(), &work, "b", &member_cfg).await;
    let listed = stdout(&run_as(&work, &member_cfg, &["list"]).await);
    assert!(!listed.contains("unavailable"), "{listed}");

    let leaf = other_leaf(
        &stdout(&run_as(&a, &owner_cfg, &["members"]).await),
        "editor",
    );
    stdout(&run_as(&a, &owner_cfg, &["members", "remove", &leaf]).await);

    // The removed folder finds out on its next sync, and the directory with it.
    let pulled = run_as(&b, &member_cfg, &["pull"]).await;
    assert!(
        failed(&pulled).contains("you were removed"),
        "{}",
        failed(&pulled)
    );
    let listed = stdout(&run_as(&work, &member_cfg, &["list"]).await);
    assert!(
        listed.contains("unavailable: you were removed from this project"),
        "{listed}"
    );
    // The owner is not affected.
    let listed = stdout(&run_as(&work, &owner_cfg, &["list"]).await);
    assert!(!listed.contains("unavailable"), "{listed}");
}
