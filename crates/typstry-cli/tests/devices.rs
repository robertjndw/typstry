//! Listing and revoking the devices of one person, with each device on a
//! config dir of its own.

mod common;

use common::{
    Server, Shower, binary_with, clone_as, config_in, failed, init_as, other_leaf, read, run_as,
    stderr, stdout, temp,
};

use std::fs;
use std::path::{Path, PathBuf};

/// Pairs a new device (config `new_cfg`) to the person of `holder_cfg`,
/// which shows the code from `holder_dir`.
async fn pair(server: &Server, work: &Path, holder_dir: &Path, holder_cfg: &Path, new_cfg: &Path) {
    let shower = Shower::start(holder_dir, holder_cfg, &["--yes"]).await;
    let out = run_as(
        work,
        new_cfg,
        &["pair", &shower.code, "--server", &server.origin],
    )
    .await;
    stdout(&out);
    let holder = shower.finish().await;
    assert!(
        holder.status.success(),
        "{}",
        String::from_utf8_lossy(&holder.stderr)
    );
}

async fn link_of(dir: &Path, cfg: &Path) -> String {
    stdout(&run_as(dir, cfg, &["link", "--edit"]).await)
        .trim()
        .to_owned()
}

/// A folder of `new_cfg` for the project `number` of its project list.
async fn clone_listed(work: &Path, cfg: &Path, number: &str, name: &str) -> PathBuf {
    let out = run_as(work, cfg, &["clone", number, name]).await;
    assert!(out.status.success(), "{}", failed(&out));
    work.join(name).canonicalize().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_a_device_removes_it_from_owned_and_edited_projects() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let other_cfg = config_in(&work, "other-cfg");

    // One project the person owns, one somebody else owns.
    let own = init_as(&server, &work, "own", &holder_cfg).await;
    let theirs = init_as(&server, &work, "theirs", &other_cfg).await;
    let theirs_link = link_of(&theirs, &other_cfg).await;
    let edited = clone_as(&holder_cfg, &theirs_link, &work, "edited").await;

    pair(&server, &work, &own, &holder_cfg, &new_cfg).await;
    let n_own = clone_listed(&work, &new_cfg, "1", "n-own").await;
    let n_edited = clone_listed(&work, &new_cfg, "2", "n-edited").await;
    let listing = stdout(&run_as(&own, &holder_cfg, &["members"]).await);
    assert_eq!(listing.matches("    #").count(), 2, "{listing}");

    let devices = stdout(&run_as(&own, &holder_cfg, &["devices"]).await);
    assert!(devices.contains("Tester"), "{devices}");
    let out = run_as(&own, &holder_cfg, &["devices", "revoke", "Tester", "--yes"]).await;
    let text = stdout(&out);
    // Only the owner rotates: the edited project gets the revoke in this
    // device's leaf and waits for its owner.
    assert_eq!(text.matches("Cleaned").count(), 1, "{text}");
    assert!(text.contains("Cleaned own"), "{text}");
    assert!(
        text.contains("theirs: 1 revoked device(s) left for the owner to remove"),
        "{text}"
    );
    assert!(!stderr(&out).contains("Not reached"), "{}", stderr(&out));
    let devices = stdout(&run_as(&own, &holder_cfg, &["devices"]).await);
    assert!(devices.contains("revoked"), "{devices}");
    // Until the owner opens it, the editor is told the device is still there.
    let out = run_as(&edited, &holder_cfg, &["pull"]).await;
    stdout(&out);
    assert!(
        stderr(&out).contains("1 revoked device(s) are still in the project"),
        "{}",
        stderr(&out)
    );
    let out = run_as(&theirs, &other_cfg, &["pull"]).await;
    stdout(&out);
    assert!(
        stderr(&out).contains("removed 1 revoked device(s)"),
        "{}",
        stderr(&out)
    );

    // The revoked device is out of both groups.
    let listing = stdout(&run_as(&own, &holder_cfg, &["members"]).await);
    assert_eq!(listing.matches("    #").count(), 1, "{listing}");
    assert!(!listing.contains("revoked"), "{listing}");
    let listing = stdout(&run_as(&edited, &holder_cfg, &["members"]).await);
    assert!(!listing.contains("revoked"), "{listing}");
    for dir in [&n_own, &n_edited] {
        let err = failed(&run_as(dir, &new_cfg, &["pull"]).await);
        assert!(err.contains("you were removed"), "{err}");
    }
    // Being removed is how it hears that it was revoked.
    let devices = stdout(&run_as(&work, &new_cfg, &["devices"]).await);
    let mine = devices
        .lines()
        .find(|l| l.contains("(this device)"))
        .unwrap_or_else(|| panic!("{devices}"));
    assert!(mine.contains("revoked"), "{devices}");

    // New content stays out of its reach, in both projects.
    for (dir, name) in [(&own, "own"), (&edited, "edited")] {
        fs::write(
            dir.join("later.typ"),
            format!("after the revoke in {name}\n"),
        )
        .unwrap();
        stdout(&run_as(dir, &holder_cfg, &["push"]).await);
    }
    for dir in [&n_own, &n_edited] {
        failed(&run_as(dir, &new_cfg, &["pull"]).await);
        assert!(!dir.join("later.typ").exists());
    }

    // The remaining person keeps working, and the owner of the edited
    // project still sees the revoked device gone.
    assert_eq!(read(&edited, "later.typ"), "after the revoke in edited\n");
    let listing = stdout(&run_as(&theirs, &other_cfg, &["members"]).await);
    assert!(!listing.contains("revoked"), "{listing}");
}

/// The fingerprint of the device `cfg` lists that is not itself.
async fn other_device(work: &Path, cfg: &Path) -> String {
    let devices = stdout(&run_as(work, cfg, &["devices"]).await);
    devices
        .lines()
        .find(|l| l.contains("valid") && !l.contains("(this device)"))
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or_else(|| panic!("{devices}"))
        .to_owned()
}

/// The number `typstry list` gives the project `title` when it is not on
/// this device.
async fn number_of(work: &Path, cfg: &Path, title: &str) -> String {
    let listing = stdout(&run_as(work, cfg, &["list"]).await);
    let mut lines = listing.lines();
    while let Some(line) = lines.next() {
        if line.contains(title)
            && let Some(hint) = lines.next().and_then(|l| l.split("typstry clone ").nth(1))
        {
            return hint.trim().to_owned();
        }
    }
    panic!("{title} is not listed as missing:\n{listing}")
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_resets_an_owned_project_without_a_folder_and_rotates_the_personal_space() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let a_cfg = config_in(&work, "a-cfg");
    let b_cfg = config_in(&work, "b-cfg");
    let outsider_cfg = config_in(&work, "outsider-cfg");

    let first = init_as(&server, &work, "first", &a_cfg).await;
    pair(&server, &work, &first, &a_cfg, &b_cfg).await;
    // B's project reaches A only through the personal space, and B drops
    // its folder: the revoked device knows the links, B has no leaf of A's
    // to remove there.
    let mine = init_as(&server, &work, "mine", &b_cfg).await;
    let old_link = link_of(&mine, &b_cfg).await;
    stdout(&run_as(&work, &a_cfg, &["list"]).await);
    assert!(
        number_of(&work, &a_cfg, "mine")
            .await
            .parse::<u32>()
            .is_ok()
    );
    fs::remove_dir_all(&mine).unwrap();
    let a_device = other_device(&work, &b_cfg).await;

    let out = run_as(&work, &b_cfg, &["devices", "revoke", &a_device, "--yes"]).await;
    let text = stdout(&out);
    assert!(text.contains("personal space"), "{text}");
    assert!(text.contains("Replaced the links of mine"), "{text}");
    // A's project is cleaned too: its owner key reached B in the directory.
    assert!(text.contains("Cleaned first"), "{text}");
    let err = stderr(&out);
    assert!(!err.contains("first"), "{err}");
    assert!(!err.contains("mine"), "{err}");

    // The old link is dead for anyone who held on to it.
    failed(&run_as(&work, &outsider_cfg, &["clone", &old_link, "outsider"]).await);
    // The directory carries the new one: cloning by number still works.
    let number = number_of(&work, &b_cfg, "mine").await;
    let again = clone_listed(&work, &b_cfg, &number, "again").await;
    assert_ne!(link_of(&again, &b_cfg).await, old_link);

    // A is out of the personal space: it hears so once, then gets no more
    // of the directory.
    let out = run_as(&work, &a_cfg, &["list"]).await;
    assert!(
        stderr(&out).contains("removed from your personal space"),
        "{}",
        stderr(&out)
    );
    init_as(&server, &work, "later", &b_cfg).await;
    let listing = stdout(&run_as(&work, &a_cfg, &["list"]).await);
    assert!(!listing.contains("later"), "{listing}");
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_resets_a_project_the_revoked_device_made_and_this_one_never_cloned() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let a_cfg = config_in(&work, "a-cfg");
    let b_cfg = config_in(&work, "b-cfg");
    let outsider_cfg = config_in(&work, "outsider-cfg");

    let first = init_as(&server, &work, "first", &a_cfg).await;
    pair(&server, &work, &first, &a_cfg, &b_cfg).await;
    // Made on A after pairing: B only ever sees it in the list, so the owner
    // key can only have reached B through the directory.
    let theirs = init_as(&server, &work, "theirs", &a_cfg).await;
    let old_link = link_of(&theirs, &a_cfg).await;
    stdout(&run_as(&work, &a_cfg, &["list"]).await);
    stdout(&run_as(&work, &b_cfg, &["list"]).await);
    assert!(
        number_of(&work, &b_cfg, "theirs")
            .await
            .parse::<u32>()
            .is_ok()
    );
    let a_device = other_device(&work, &b_cfg).await;

    let out = run_as(&work, &b_cfg, &["devices", "revoke", &a_device, "--yes"]).await;
    let text = stdout(&out);
    assert!(text.contains("Cleaned theirs"), "{text}");
    assert!(!stderr(&out).contains("theirs"), "{}", stderr(&out));

    failed(&run_as(&work, &outsider_cfg, &["clone", &old_link, "outsider"]).await);
    let number = number_of(&work, &b_cfg, "theirs").await;
    let again = clone_listed(&work, &b_cfg, &number, "again").await;
    assert_ne!(link_of(&again, &b_cfg).await, old_link);
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_replaces_the_links_of_an_owned_folder_the_revoked_device_never_joined() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let a_cfg = config_in(&work, "a-cfg");
    let b_cfg = config_in(&work, "b-cfg");
    let outsider_cfg = config_in(&work, "outsider-cfg");

    let first = init_as(&server, &work, "first", &a_cfg).await;
    pair(&server, &work, &first, &a_cfg, &b_cfg).await;
    // Made on B, with a folder: A has no leaf in it, but its link may have
    // reached A through the directory.
    let mine = init_as(&server, &work, "mine", &b_cfg).await;
    let old_link = link_of(&mine, &b_cfg).await;
    let a_device = other_device(&work, &b_cfg).await;

    let out = run_as(&work, &b_cfg, &["devices", "revoke", &a_device, "--yes"]).await;
    let text = stdout(&out);
    assert!(text.contains("Replaced the links of mine"), "{text}");
    assert!(!stderr(&out).contains("Not reached"), "{}", stderr(&out));
    failed(&run_as(&work, &outsider_cfg, &["clone", &old_link, "outsider"]).await);
    assert_ne!(link_of(&mine, &b_cfg).await, old_link);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_links_stay_when_the_personal_space_could_not_be_secured() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let a_cfg = config_in(&work, "a-cfg");
    let b_cfg = config_in(&work, "b-cfg");
    let outsider_cfg = config_in(&work, "outsider-cfg");

    let first = init_as(&server, &work, "first", &a_cfg).await;
    pair(&server, &work, &first, &a_cfg, &b_cfg).await;
    let mine = init_as(&server, &work, "mine", &b_cfg).await;
    let old_link = link_of(&mine, &b_cfg).await;
    // B's seat in the personal space now points at a link the server does
    // not know, so the space cannot be reached.
    for entry in fs::read_dir(b_cfg.join("spaces")).unwrap() {
        let path = entry.unwrap().path().join("config.json");
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let mut config: serde_json::Value = serde_json::from_str(&text).unwrap();
        config["token"] = "zzzzzzzzzzzzzzzzzzzzzz".into();
        fs::write(&path, config.to_string()).unwrap();
    }
    let a_device = other_device(&work, &b_cfg).await;

    let out = run_as(&work, &b_cfg, &["devices", "revoke", &a_device, "--yes"]).await;
    // Incomplete, so a script must not take it for done.
    let err = failed(&out);
    assert!(err.contains("could not be secured"), "{err}");
    assert!(err.contains("no project links"), "{err}");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(!text.contains("Cleaned"), "{text}");
    assert!(!text.contains("Replaced the links of mine"), "{text}");
    // Nothing was rotated, so the link still opens.
    assert_eq!(link_of(&mine, &b_cfg).await, old_link);
    clone_as(&outsider_cfg, &old_link, &work, "outsider").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_joined_before_the_key_was_listed_takes_it_from_the_directory() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let a_cfg = config_in(&work, "a-cfg");
    let b_cfg = config_in(&work, "b-cfg");
    let editor_cfg = config_in(&work, "editor-cfg");

    let first = init_as(&server, &work, "first", &a_cfg).await;
    pair(&server, &work, &first, &a_cfg, &b_cfg).await;
    // B as it was before A made the project: its directory has no key of it.
    let b_old = work.join("b-old-cfg");
    let copied = std::process::Command::new("cp")
        .arg("-R")
        .arg(&b_cfg)
        .arg(&b_old)
        .status()
        .unwrap();
    assert!(copied.success());
    // No personal space on that copy, so nothing reaches its directory.
    fs::remove_dir_all(b_old.join("spaces")).unwrap();

    let own = init_as(&server, &work, "own", &a_cfg).await;
    let edit = stdout(&run_as(&own, &a_cfg, &["link", "--edit"]).await);
    clone_as(&editor_cfg, edit.trim(), &work, "e").await;
    let b_own = clone_as(&b_old, edit.trim(), &work, "b-own").await;
    let listing = stdout(&run_as(&b_own, &b_old, &["members"]).await);
    assert!(listing.contains("no owner key"), "{listing}");

    // The key reaches B's directory, and A is never opened again.
    stdout(&run_as(&work, &b_cfg, &["list"]).await);
    let listing = stdout(&run_as(&b_own, &b_cfg, &["members"]).await);
    assert!(!listing.contains("no owner key"), "{listing}");
    let leaf = other_leaf(&listing, "editor");
    stdout(&run_as(&b_own, &b_cfg, &["members", "remove", &leaf, "--yes"]).await);
    stdout(&run_as(&b_own, &b_cfg, &["share", "reset", "--yes"]).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_removes_the_device_from_an_owned_project_without_a_folder() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let a_cfg = config_in(&work, "a-cfg");
    let b_cfg = config_in(&work, "b-cfg");

    let own = init_as(&server, &work, "own", &a_cfg).await;
    pair(&server, &work, &own, &a_cfg, &b_cfg).await;
    let b_own = clone_listed(&work, &b_cfg, "1", "b-own").await;
    // The owner key goes from A to B through the group, so both open it.
    stdout(&run_as(&own, &a_cfg, &["pull"]).await);
    stdout(&run_as(&b_own, &b_cfg, &["pull"]).await);
    let listing = stdout(&run_as(&b_own, &b_cfg, &["members"]).await);
    assert!(!listing.contains("no owner key"), "{listing}");
    fs::remove_dir_all(&b_own).unwrap();
    let a_device = other_device(&work, &b_cfg).await;

    let out = run_as(&work, &b_cfg, &["devices", "revoke", &a_device, "--yes"]).await;
    let text = stdout(&out);
    assert!(text.contains("Cleaned own"), "{text}");
    assert!(!stderr(&out).contains("Not reached"), "{}", stderr(&out));
    let err = failed(&run_as(&own, &a_cfg, &["pull"]).await);
    assert!(err.contains("you were removed"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_cannot_revoke_itself_or_an_unknown_one() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let own = init_as(&server, &work, "own", &holder_cfg).await;
    pair(&server, &work, &own, &holder_cfg, &new_cfg).await;

    let devices = stdout(&run_as(&work, &new_cfg, &["devices"]).await);
    let mine = devices
        .lines()
        .find(|l| l.contains("(this device)"))
        .unwrap_or_else(|| panic!("{devices}"));
    let fingerprint = mine.split_whitespace().nth(1).unwrap();
    let err = failed(
        &run_as(
            &work,
            &new_cfg,
            &["devices", "revoke", fingerprint, "--yes"],
        )
        .await,
    );
    assert!(err.contains("this device"), "{err}");
    let err = failed(&run_as(&work, &new_cfg, &["devices", "revoke", "nobody", "--yes"]).await);
    assert!(err.contains("no device matches"), "{err}");
    let devices = stdout(&run_as(&work, &new_cfg, &["devices"]).await);
    assert!(!devices.contains("revoked"), "{devices}");
}

#[tokio::test(flavor = "multi_thread")]
async fn projects_that_cannot_be_cleaned_are_reported() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let own = init_as(&server, &work, "own", &holder_cfg).await;
    let (_, view) = server.seeded_project("Viewed").await;
    clone_as(&holder_cfg, &view, &work, "viewed").await;
    pair(&server, &work, &own, &holder_cfg, &new_cfg).await;

    let out = run_as(&own, &holder_cfg, &["devices", "revoke", "Tester", "--yes"]).await;
    let err = failed(&out);
    assert!(err.contains("Not reached"), "{err}");
    assert!(err.contains("view-only"), "{err}");
    assert!(err.contains("not removed everywhere"), "{err}");

    // Running it again says the device is revoked already, and fails as
    // long as the project stays out of reach.
    let again = run_as(&own, &holder_cfg, &["devices", "revoke", "Tester", "--yes"]).await;
    failed(&again);
    let text = String::from_utf8_lossy(&again.stdout);
    assert!(text.contains("already revoked"), "{text}");
}

/// The 17 words `devices recovery` printed.
fn words_in(output: &str) -> String {
    output
        .lines()
        .map(str::trim)
        .find(|l| l.split_whitespace().count() == 17)
        .unwrap_or_else(|| panic!("no recovery words in {output}"))
        .to_owned()
}

/// `devices recover` on the machine of `cfg`, with `words` on stdin.
async fn recover(
    dir: &Path,
    cfg: &Path,
    link: &str,
    words: &str,
    extra: &[&str],
) -> std::process::Output {
    let env = [("TYPSTRY_CONFIG_DIR", cfg.to_str().unwrap())];
    let mut args = vec!["devices", "recover", link];
    args.extend(extra);
    binary_with(dir, &args, words, &env).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recovery_key_takes_the_account_back_after_every_device_is_lost() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let lost_cfg = config_in(&work, "lost-cfg");
    let fresh_cfg = config_in(&work, "fresh-cfg");
    let member_cfg = config_in(&work, "member-cfg");

    let lost = init_as(&server, &work, "lost", &lost_cfg).await;
    let link = link_of(&lost, &lost_cfg).await;
    clone_as(&member_cfg, &link, &work, "member").await;
    // A second project, reachable after the recovery only through the
    // personal space.
    let second = init_as(&server, &work, "second", &lost_cfg).await;

    let made = run_as(&lost, &lost_cfg, &["devices", "recovery"]).await;
    let text = stdout(&made);
    let words = words_in(&text);
    assert!(text.contains("offline"), "{text}");
    assert!(text.contains("take over your account"), "{text}");
    assert!(!stderr(&made).contains("Not reached"), "{}", stderr(&made));
    let devices = stdout(&run_as(&lost, &lost_cfg, &["devices"]).await);
    assert!(devices.contains("Recovery key"), "{devices}");
    assert!(devices.contains("(recovery key)"), "{devices}");

    // Wrong words fail without leaving anything behind.
    let other = typstry_wire::identity::RecoveryKey::generate().1;
    let err = failed(&recover(&work, &fresh_cfg, &link, &other, &[]).await);
    assert!(err.contains("not one of the people"), "{err}");
    let err = failed(&recover(&work, &fresh_cfg, &link, "apple banana", &[]).await);
    assert!(err.contains("17 words"), "{err}");
    assert!(!fresh_cfg.join("person.graph").exists());

    // The machine with nothing recovers; the lost device is revoked.
    let out = recover(&work, &fresh_cfg, &link, &words, &[]).await;
    let text = stdout(&out);
    assert!(text.contains("Revoked 1 device"), "{text}");
    // The lost device left shares of the owner keys for the recovery key,
    // or the recovered device could never remove it.
    assert!(text.contains("Cleaned lost: removed 1 device"), "{text}");
    assert!(text.contains("Cleaned second: removed 1 device"), "{text}");
    assert!(text.contains("Your personal space is back"), "{text}");
    let devices = stdout(&run_as(&work, &fresh_cfg, &["devices"]).await);
    assert_eq!(devices.matches("revoked").count(), 1, "{devices}");
    assert!(devices.contains("(this device)"), "{devices}");

    // One project link was enough to get the whole list back, with the
    // owner key of the project the link was not for.
    let listing = stdout(&run_as(&work, &fresh_cfg, &["list"]).await);
    assert!(listing.contains("second"), "{listing}");
    let number = number_of(&work, &fresh_cfg, "second").await;
    let reopened = clone_listed(&work, &fresh_cfg, &number, "reopened").await;
    let members = stdout(&run_as(&reopened, &fresh_cfg, &["members"]).await);
    assert!(!members.contains("revoked"), "{members}");
    assert!(members.contains("(owner)"), "{members}");
    // The lost device is gone from it too: its links were replaced.
    let err = failed(&run_as(&second, &lost_cfg, &["pull"]).await);
    assert!(err.contains("you were removed"), "{err}");

    // The recovery replaced the links, so the project is cloned by number.
    // Its lost device's leaf is gone and ownership came with the person.
    let number = number_of(&work, &fresh_cfg, "lost").await;
    let fresh = clone_listed(&work, &fresh_cfg, &number, "fresh").await;
    let listing = stdout(&run_as(&fresh, &fresh_cfg, &["members"]).await);
    // Three leaves: this folder, the member, and the seat the recovery
    // opened to clean the project before there was a folder.
    assert_eq!(listing.matches("    #").count(), 3, "{listing}");
    assert!(!listing.contains("revoked"), "{listing}");
    assert!(listing.contains("(owner)"), "{listing}");
    let member = common::other_leaf(&listing, "editor");
    stdout(&run_as(&fresh, &fresh_cfg, &["members", "remove", &member, "--yes"]).await);
    stdout(&run_as(&fresh, &fresh_cfg, &["share", "reset", "--yes"]).await);
    let err = failed(&run_as(&lost, &lost_cfg, &["pull"]).await);
    assert!(err.contains("you were removed"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn fingerprints_that_start_with_a_hyphen_are_taken_as_names() {
    let (_work, work) = temp();
    let cfg = config_in(&work, "cfg");
    // They are base64url, so one in 64 starts this way. It has to reach the
    // lookup instead of being parsed as a flag.
    for query in ["-1abc", "-ab"] {
        let err = failed(&run_as(&work, &cfg, &["devices", "revoke", query, "--yes"]).await);
        assert!(!err.contains("unexpected argument"), "{err}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn recovering_onto_a_machine_that_is_a_person_needs_replace() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let lost_cfg = config_in(&work, "lost-cfg");
    let busy_cfg = config_in(&work, "busy-cfg");
    let lost = init_as(&server, &work, "lost", &lost_cfg).await;
    let link = link_of(&lost, &lost_cfg).await;
    let words = words_in(&stdout(
        &run_as(&lost, &lost_cfg, &["devices", "recovery"]).await,
    ));
    let busy = init_as(&server, &work, "busy", &busy_cfg).await;
    let before = fs::read(busy_cfg.join("person.graph")).unwrap();

    let err = failed(&recover(&work, &busy_cfg, &link, &words, &[]).await);
    assert!(err.contains("--replace"), "{err}");
    assert_eq!(fs::read(busy_cfg.join("person.graph")).unwrap(), before);

    // busy owns its project and has no other device, so switching would
    // orphan it. A recovery key of its own is enough to keep a way back.
    let flags = ["--replace", "--keep-devices"];
    let err = failed(&recover(&work, &busy_cfg, &link, &words, &flags).await);
    assert!(err.contains("without an owner"), "{err}");
    assert_eq!(fs::read(busy_cfg.join("person.graph")).unwrap(), before);
    run_as(&busy, &busy_cfg, &["devices", "recovery"]).await;

    let out = recover(
        &work,
        &busy_cfg,
        &link,
        &words,
        &["--replace", "--keep-devices"],
    )
    .await;
    let text = stdout(&out);
    assert!(text.contains("No other device was revoked"), "{text}");
    let devices = stdout(&run_as(&work, &busy_cfg, &["devices"]).await);
    assert!(!devices.contains("revoked"), "{devices}");
}

/// Runs `typstry` as `name`, or without a name, in the machine of `cfg`.
async fn run_named(
    dir: &Path,
    cfg: &Path,
    name: Option<&str>,
    args: &[&str],
) -> std::process::Output {
    let (dir, cfg) = (dir.to_path_buf(), cfg.to_path_buf());
    let name = name.map(str::to_owned);
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_typstry"));
        command.arg("-C").arg(&dir);
        if let Some(name) = &name {
            command.args(["--name", name]);
        }
        command
            .args(&args)
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .env_remove("TYPSTRY_SERVER")
            .env("TYPSTRY_CONFIG_DIR", &cfg)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_persons_profile_reaches_other_members() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let ada_cfg = config_in(&work, "ada-cfg");
    let other_cfg = config_in(&work, "other-cfg");
    let ada = init_as(&server, &work, "ada", &ada_cfg).await;
    let link = link_of(&ada, &ada_cfg).await;
    let other = clone_as(&other_cfg, &link, &work, "other").await;

    let set = run_named(
        &ada,
        &ada_cfg,
        Some("Ada"),
        &["devices", "profile", "--color", "#112233"],
    )
    .await;
    assert!(set.status.success(), "{}", failed(&set));
    let text = stdout(&set);
    assert!(text.contains("Ada"), "{text}");
    assert!(text.contains("#112233"), "{text}");
    let shown = stdout(&run_named(&ada, &ada_cfg, None, &["devices", "profile"]).await);
    assert!(shown.contains("Ada (#112233)"), "{shown}");
    let again = stdout(
        &run_named(
            &ada,
            &ada_cfg,
            Some("Ada"),
            &["devices", "profile", "--color", "#112233"],
        )
        .await,
    );
    assert!(again.contains("already"), "{again}");

    // The other member sees the person under the new name, whatever the
    // device's own leaf is called.
    let listing = stdout(&run_named(&other, &other_cfg, Some("Bea"), &["members"]).await);
    let heading = listing
        .lines()
        .find(|l| l.contains("Person ") && l.contains("(owner)"))
        .unwrap_or_else(|| panic!("{listing}"));
    assert!(heading.contains("Ada"), "{listing}");

    // A color has to be a hex triplet.
    let err = failed(
        &run_named(
            &ada,
            &ada_cfg,
            Some("Ada"),
            &["devices", "profile", "--color", "red"],
        )
        .await,
    );
    assert!(err.contains("#rrggbb"), "{err}");
}
