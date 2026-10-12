//! Group membership against an in-process server: joining on clone, the
//! member list, removal, and following a rotation that happened while a
//! folder was offline.

mod common;

use common::{Server, binary, clone, failed, read, stderr, stdout, temp, typstry};

use std::fs;
use std::path::Path;

use typstry_cli::engine::Session;
use typstry_cli::link::ShareLink;
use typstry_cli::mls::{Ds, Reply};
use typstry_cli::state::{Config, STATE_DIR, StateDir};
use typstry_doc::init::starter_content;
use typstry_wire::mls::{ProjectGroup, SubmitPayload};

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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(a.join(STATE_DIR).join("mls.bin"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // The browser that made the project, the seeding session, the two clones.
    let listing = stdout(&binary(&a, &["members"]).await);
    assert!(listing.contains("Browser"), "{listing}");
    assert!(listing.contains("Seeder"), "{listing}");
    assert_eq!(listing.matches("(you)").count(), 1, "{listing}");
    assert_eq!(listing.matches("editor").count(), 3, "{listing}");
    assert_eq!(listing.matches("viewer").count(), 1, "{listing}");
    assert!(listing.contains("Members (4)"), "{listing}");

    // A viewer joins too and reads the same list, but cannot remove anyone.
    let from_view = stdout(&binary(&v, &["members"]).await);
    assert!(from_view.contains("Members (4)"), "{from_view}");
    let err = failed(&binary(&v, &["members", "remove", "0"]).await);
    assert!(err.contains("only editors"), "{err}");
    let err = failed(&binary(&v, &["share", "reset"]).await);
    assert!(err.contains("only editors"), "{err}");
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
    let mut group = ProjectGroup::import_state(&fs::read(&path).unwrap()).unwrap();
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join("device.bin"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
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
    let group = ProjectGroup::import_state(&fs::read(&path).unwrap()).unwrap();
    let (_next, reset) = group.reset(b"{\"name\":\"a\",\"color\":\"#000\"}").unwrap();
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
