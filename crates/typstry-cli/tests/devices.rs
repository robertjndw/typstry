//! Listing and revoking the devices of one person, with each device on a
//! config dir of its own.

mod common;

use common::{
    Server, Shower, binary_with, clone_as, config_in, failed, init_as, read, run_as, stderr,
    stdout, temp,
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
    let out = run_as(&own, &holder_cfg, &["devices", "revoke", "Tester"]).await;
    let text = stdout(&out);
    assert_eq!(text.matches("Cleaned").count(), 2, "{text}");
    assert!(!stderr(&out).contains("Not reached"), "{}", stderr(&out));
    let devices = stdout(&run_as(&own, &holder_cfg, &["devices"]).await);
    assert!(devices.contains("revoked"), "{devices}");

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
    let err = failed(&run_as(&work, &new_cfg, &["devices", "revoke", fingerprint]).await);
    assert!(err.contains("this device"), "{err}");
    let err = failed(&run_as(&work, &new_cfg, &["devices", "revoke", "nobody"]).await);
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

    let out = run_as(&own, &holder_cfg, &["devices", "revoke", "Tester"]).await;
    stdout(&out);
    let err = stderr(&out);
    assert!(err.contains("Not reached"), "{err}");
    assert!(err.contains("view-only"), "{err}");

    // Running it again says the device is revoked already.
    let again = stdout(&run_as(&own, &holder_cfg, &["devices", "revoke", "Tester"]).await);
    assert!(again.contains("already revoked"), "{again}");
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
    assert!(text.contains("typstry clone"), "{text}");
    let devices = stdout(&run_as(&work, &fresh_cfg, &["devices"]).await);
    assert_eq!(devices.matches("revoked").count(), 1, "{devices}");
    assert!(devices.contains("(this device)"), "{devices}");

    // Opening the project removes the lost device's leaf, and ownership came
    // with the person.
    let fresh = clone_as(&fresh_cfg, &link, &work, "fresh").await;
    let listing = stdout(&run_as(&fresh, &fresh_cfg, &["members"]).await);
    assert_eq!(listing.matches("    #").count(), 2, "{listing}");
    assert!(!listing.contains("revoked"), "{listing}");
    assert!(listing.contains("(owner)"), "{listing}");
    let member = common::other_leaf(&listing, "editor");
    stdout(&run_as(&fresh, &fresh_cfg, &["members", "remove", &member]).await);
    stdout(&run_as(&fresh, &fresh_cfg, &["share", "reset"]).await);
    let err = failed(&run_as(&lost, &lost_cfg, &["pull"]).await);
    assert!(err.contains("you were removed"), "{err}");
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
