//! Pairing two CLI devices through the in-process relay, each with a config
//! dir of its own.

mod common;

use common::{
    Server, Shower, binary_with, clone, clone_as, config_in, failed, init_as, other_leaf, run_as,
    stderr, stdout, temp, typstry,
};

use std::path::{Path, PathBuf};

use typstry_wire::pairing::Code;

#[tokio::test(flavor = "multi_thread")]
async fn a_new_device_joins_the_person_and_gets_the_projects() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Paired").await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let a = clone_as(&holder_cfg, &edit, &work, "a").await;

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let env = [("TYPSTRY_CONFIG_DIR", new_cfg.to_str().unwrap())];
    let entered = binary_with(
        &work,
        &["pair", &shower.code, "--server", &server.origin],
        "",
        &env,
    )
    .await;
    let output = stdout(&entered);
    let holder = shower.finish().await;
    assert!(
        holder.status.success(),
        "{}",
        String::from_utf8_lossy(&holder.stderr)
    );

    // Each device keeps its own key; they share the graph that lists both.
    assert_ne!(
        std::fs::read(new_cfg.join("device.key")).unwrap(),
        std::fs::read(holder_cfg.join("device.key")).unwrap()
    );
    assert_eq!(
        std::fs::read(new_cfg.join("person.graph")).unwrap(),
        std::fs::read(holder_cfg.join("person.graph")).unwrap()
    );
    assert!(!new_cfg.join("person.key").exists());
    let devices = stdout(&binary_with(&work, &["devices"], "", &env).await);
    assert_eq!(devices.matches("valid").count(), 2, "{devices}");
    assert_eq!(devices.matches("(this device)").count(), 1, "{devices}");
    // The holder is known by the name it gave when it approved.
    let holder_line = devices
        .lines()
        .find(|l| l.contains("valid") && !l.contains("(this device)"))
        .unwrap_or_else(|| panic!("{devices}"));
    assert!(holder_line.trim_start().starts_with("Tester"), "{devices}");
    // The first pass already brought the directory, so the list is printed.
    assert!(
        output.contains("Paired") && output.contains("typstry clone 1"),
        "{output}"
    );
    assert!(!new_cfg.join("projects.json").exists());
    assert!(!new_cfg.join("available.json").exists());
    assert!(new_cfg.join("spaces").is_dir());

    // The handed-over project is listed and cloned by its number.
    let listed = stdout(&binary_with(&work, &["list"], "", &env).await);
    assert!(listed.contains("Paired"), "{listed}");
    assert!(listed.contains("typstry clone 1"), "{listed}");
    let b = work.join("b");
    let cloned = binary_with(&work, &["clone", "1", "b"], "", &env).await;
    assert!(cloned.status.success(), "{}", failed(&cloned));
    let after = stdout(&binary_with(&work, &["list", "--missing"], "", &env).await);
    assert!(after.contains("Every project is on this device"), "{after}");
    let listing = stdout(&binary_with(&b, &["members"], "", &env).await);
    let mine = listing
        .split("Person ")
        .find(|block| block.contains("(you)"))
        .unwrap_or_else(|| panic!("{listing}"));
    assert_eq!(mine.matches("    #").count(), 2, "{listing}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_code_fails_both_sides() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Wrong").await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let a = clone_as(&holder_cfg, &edit, &work, "a").await;

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let shown: Code = shower.code.parse().unwrap();
    // The right channel with other words, as when a digit is misheard.
    let wrong = (0..=255u8)
        .map(|w| Code::new(shown.channel(), [w, w]).unwrap().to_string())
        .find(|c| *c != shower.code)
        .unwrap();
    let env = [("TYPSTRY_CONFIG_DIR", new_cfg.to_str().unwrap())];
    let entered = binary_with(
        &work,
        &["pair", &wrong, "--server", &server.origin],
        "",
        &env,
    )
    .await;
    let message = "The code did not match";
    assert!(failed(&entered).contains(message));
    let holder = shower.finish().await;
    assert!(!holder.status.success());
    assert!(String::from_utf8_lossy(&holder.stderr).contains(message));
    assert!(!new_cfg.join("person.graph").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn two_devices_that_are_people_are_a_role_conflict() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Conflict").await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let other_cfg = config_in(&work, "other-cfg");
    let a = clone_as(&holder_cfg, &edit, &work, "a").await;
    clone_as(&other_cfg, &edit, &work, "b").await;

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let env = [("TYPSTRY_CONFIG_DIR", other_cfg.to_str().unwrap())];
    let entered = binary_with(
        &work,
        &["pair", &shower.code, "--server", &server.origin],
        "",
        &env,
    )
    .await;
    assert!(failed(&entered).contains("Both devices are already a person"));
    let holder = shower.finish().await;
    assert!(String::from_utf8_lossy(&holder.stderr).contains("Both devices are already a person"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_is_an_owner_that_gets_the_key_from_the_directory() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let editor_cfg = config_in(&work, "editor-cfg");
    let a = init_as(&server, &work, "a", &holder_cfg).await;
    let edit = stdout(&run_as(&a, &holder_cfg, &["link", "--edit"]).await);
    clone_as(&editor_cfg, edit.trim(), &work, "e").await;

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let entered = run_as(
        &work,
        &new_cfg,
        &["pair", &shower.code, "--server", &server.origin],
    )
    .await;
    stdout(&entered);
    let holder = shower.finish().await;
    assert!(holder.status.success());

    let b = work.join("b");
    let cloned = run_as(&work, &new_cfg, &["clone", "1", "b"]).await;
    assert!(cloned.status.success(), "{}", failed(&cloned));
    let listing = stdout(&run_as(&b, &new_cfg, &["members"]).await);
    let owners = listing
        .lines()
        .filter(|l| l.starts_with("    #") && l.contains("owner"))
        .count();
    assert_eq!(owners, 2, "{listing}");
    assert!(listing.contains("(owner)"), "{listing}");

    // The owner key reached the new device through the personal space's
    // directory, so it can act as an owner before the first device hands it
    // over inside the group.
    assert!(!listing.contains("no owner key"), "{listing}");
    let leaf = other_leaf(&listing, "editor");
    stdout(&run_as(&b, &new_cfg, &["members", "remove", &leaf]).await);
    stdout(&run_as(&a, &holder_cfg, &["members"]).await);
    stdout(&run_as(&a, &holder_cfg, &["share", "reset"]).await);
    stdout(&run_as(&b, &new_cfg, &["pull"]).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn replace_is_refused_when_it_would_orphan_an_owned_project() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let cfg = config_in(&work, "cfg");
    let a = init_as(&server, &work, "a", &cfg).await;
    let graph = std::fs::read(cfg.join("person.graph")).unwrap();

    let out = run_as(
        &a,
        &cfg,
        &["pair", "whatever", "--replace", "--server", &server.origin],
    )
    .await;
    let err = failed(&out);
    assert!(err.contains("only one"), "{err}");
    assert_eq!(std::fs::read(cfg.join("person.graph")).unwrap(), graph);
}

#[tokio::test(flavor = "multi_thread")]
async fn replace_switches_a_device_that_owns_nothing_to_the_other_person() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Switch").await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let other_cfg = config_in(&work, "other-cfg");
    let a = clone_as(&holder_cfg, &edit, &work, "a").await;
    let b = clone_as(&other_cfg, &edit, &work, "b").await;
    let before = std::fs::read(other_cfg.join("person.graph")).unwrap();
    let persons = |listing: &str| listing.matches("  Person ").count();
    let roster = stdout(&run_as(&a, &holder_cfg, &["members"]).await);
    let strangers = persons(&roster);

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let out = run_as(
        &work,
        &other_cfg,
        &[
            "pair",
            &shower.code,
            "--replace",
            "--server",
            &server.origin,
        ],
    )
    .await;
    let output = stdout(&out);
    let holder = shower.finish().await;
    assert!(holder.status.success());
    let after = std::fs::read(other_cfg.join("person.graph")).unwrap();
    assert_ne!(before, after);
    assert_eq!(
        after,
        std::fs::read(holder_cfg.join("person.graph")).unwrap()
    );
    assert!(
        output.contains("switch to you on their next sync: Switch"),
        "{output}"
    );

    // The folder it cloned before pairing joins again as the new person,
    // replacing its leaf rather than leaving the old person behind.
    stdout(&run_as(&b, &other_cfg, &["pull"]).await);
    let listing = stdout(&run_as(&b, &other_cfg, &["members"]).await);
    let mine = listing
        .split("Person ")
        .find(|block| block.contains("(you)"))
        .unwrap_or_else(|| panic!("{listing}"));
    assert_eq!(mine.matches("    #").count(), 2, "{listing}");
    stdout(&run_as(&a, &holder_cfg, &["pull"]).await);
    let roster = stdout(&run_as(&a, &holder_cfg, &["members"]).await);
    assert_eq!(persons(&roster), strangers - 1, "{roster}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switching_device_merges_its_projects_into_the_other_persons_directory() {
    let server = Server::start().await;
    let (mine, _) = server.seeded_project("Mine").await;
    let (theirs, _) = server.seeded_project("Theirs").await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let other_cfg = config_in(&work, "other-cfg");
    let a = clone_as(&holder_cfg, &mine, &work, "a").await;
    clone_as(&other_cfg, &theirs, &work, "b").await;

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let out = run_as(
        &work,
        &other_cfg,
        &[
            "pair",
            &shower.code,
            "--replace",
            "--server",
            &server.origin,
        ],
    )
    .await;
    assert!(out.status.success(), "{}", failed(&out));
    // The switching device lists its old project next to the holder's.
    let listing = stdout(&out);
    assert!(
        listing.contains("Mine") && listing.contains("Theirs"),
        "{listing}"
    );
    let holder = shower.finish().await;
    assert!(holder.status.success(), "{}", failed(&holder));

    // Its entry was uploaded by the first pass, so the holder hears of it.
    let listed = stdout(&run_as(&work, &holder_cfg, &["list"]).await);
    assert!(
        listed.contains("Mine") && listed.contains("Theirs"),
        "{listed}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_clone_that_makes_the_person_suggests_pairing() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Hint").await;
    let (_work, work) = temp();
    let cfg = config_in(&work, "cfg");
    let env = [("TYPSTRY_CONFIG_DIR", cfg.to_str().unwrap())];
    let hint = "typstry pair";
    let first = stdout(&binary_with(&work, &["clone", &edit, "a"], "", &env).await);
    assert!(first.contains(hint), "{first}");
    let second = stdout(&binary_with(&work, &["clone", &edit, "b"], "", &env).await);
    assert!(!second.contains(hint), "{second}");
}

/// Pairs the machine of `new_cfg` to the person of `holder_cfg`, whose
/// folder `holder_dir` shows the code. Returns the new side's output.
async fn pair_into(
    server: &Server,
    work: &std::path::Path,
    holder_dir: &std::path::Path,
    holder_cfg: &std::path::Path,
    new_cfg: &std::path::Path,
) -> String {
    let shower = Shower::start(holder_dir, holder_cfg, &["--yes"]).await;
    let out = run_as(
        work,
        new_cfg,
        &["pair", &shower.code, "--server", &server.origin],
    )
    .await;
    let text = stdout(&out);
    let holder = shower.finish().await;
    assert!(
        holder.status.success(),
        "{}",
        String::from_utf8_lossy(&holder.stderr)
    );
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_device_joins_another_person_without_replace() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Moved").await;
    let (_work, work) = temp();
    let first_cfg = config_in(&work, "first-cfg");
    let second_cfg = config_in(&work, "second-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let a = clone_as(&first_cfg, &edit, &work, "a").await;
    let b = clone_as(&second_cfg, &edit, &work, "b").await;

    pair_into(&server, &work, &a, &first_cfg, &new_cfg).await;
    let out = run_as(&work, &new_cfg, &["clone", "1", "shared"]).await;
    assert!(out.status.success(), "{}", failed(&out));
    stdout(&run_as(&a, &first_cfg, &["devices", "revoke", "Tester"]).await);
    // The project's owner removes it, and it hears of the revoke from the
    // project they share.
    let owner = clone(&edit, &work, "owner").await;
    typstry(&owner, &["pull"]).await.unwrap();
    failed(&run_as(&work.join("shared"), &new_cfg, &["pull"]).await);
    let first = std::fs::read(first_cfg.join("person.graph")).unwrap();
    assert_eq!(std::fs::read(new_cfg.join("person.graph")).unwrap(), first);
    let devices = stdout(&run_as(&work, &new_cfg, &["devices"]).await);
    let mine = devices
        .lines()
        .find(|l| l.contains("(this device)"))
        .unwrap_or_else(|| panic!("{devices}"));
    assert!(mine.contains("revoked"), "{devices}");

    // The first person let it go, so it needs no --replace to leave.
    let output = pair_into(&server, &work, &b, &second_cfg, &new_cfg).await;
    assert!(output.contains("Paired"), "{output}");
    let after = std::fs::read(new_cfg.join("person.graph")).unwrap();
    assert_ne!(after, first);
    assert_eq!(
        after,
        std::fs::read(second_cfg.join("person.graph")).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_new_device_shows_the_key_the_holder_asks_about() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let a = init_as(&server, &work, "a", &holder_cfg).await;

    let shower = Shower::start(&a, &holder_cfg, &["--yes"]).await;
    let entered = run_as(
        &work,
        &new_cfg,
        &["pair", &shower.code, "--server", &server.origin],
    )
    .await;
    stdout(&entered);
    let holder = shower.finish().await;
    assert!(holder.status.success(), "{}", stderr(&holder));

    let shown = stderr(&entered);
    let key = shown
        .lines()
        .find_map(|l| l.strip_prefix("This device's key: "))
        .and_then(|rest| {
            rest.split_once(". Approve on the other device only if it shows the same.")
        })
        .map(|(key, _)| key.to_owned())
        .unwrap_or_else(|| panic!("{shown}"));
    let approved = String::from_utf8(holder.stdout).unwrap();
    assert!(approved.contains(&format!("({key})")), "{approved}");
    let devices = stdout(&run_as(&work, &new_cfg, &["devices"]).await);
    let mine = devices
        .lines()
        .find(|l| l.contains("(this device)"))
        .unwrap_or_else(|| panic!("{devices}"));
    assert!(mine.contains(&key), "{devices}");
}

#[tokio::test(flavor = "multi_thread")]
async fn list_reads_the_directory_and_keeps_projects_whose_folder_is_gone() {
    let server = Server::start().await;
    let (edit, _) = server.seeded_project("Listed").await;
    let (_work, work) = temp();
    let cfg = config_in(&work, "cfg");
    let a = clone_as(&cfg, &edit, &work, "a").await;

    // The clone put the project in the server's directory doc.
    let spaces: Vec<_> = std::fs::read_dir(cfg.join("spaces")).unwrap().collect();
    assert_eq!(spaces.len(), 1);
    assert!(!cfg.join("available.json").exists());
    let listed = stdout(&run_as(&work, &cfg, &["list"]).await);
    assert!(listed.contains("Listed"), "{listed}");
    assert!(listed.contains(a.to_str().unwrap()), "{listed}");

    // Without the folder the directory still has it.
    std::fs::remove_dir_all(&a).unwrap();
    let listed = stdout(&run_as(&work, &cfg, &["list"]).await);
    assert!(listed.contains("Listed"), "{listed}");
    assert!(listed.contains("typstry clone 1"), "{listed}");
}

/// Pairs `new_cfg` with the device of `holder_cfg` through a code.
async fn pair_devices(server: &Server, holder_dir: &Path, holder_cfg: &Path, new_cfg: &Path) {
    let shower = Shower::start(holder_dir, holder_cfg, &["--yes"]).await;
    let entered = run_as(
        holder_dir,
        new_cfg,
        &["pair", &shower.code, "--server", &server.origin],
    )
    .await;
    assert!(entered.status.success(), "{}", failed(&entered));
    let holder = shower.finish().await;
    assert!(holder.status.success(), "{}", failed(&holder));
    assert!(!stderr(&holder).contains("warning"), "{}", stderr(&holder));
    assert!(
        !stderr(&entered).contains("warning"),
        "{}",
        stderr(&entered)
    );
}

/// The one directory dir of a config dir.
fn directory_dir(config: &Path) -> PathBuf {
    let mut dirs: Vec<_> = std::fs::read_dir(config.join("spaces"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(dirs.len(), 1, "{dirs:?}");
    dirs.remove(0)
}

#[tokio::test(flavor = "multi_thread")]
async fn paired_devices_share_the_project_list_through_the_personal_space() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let holder_cfg = config_in(&work, "holder-cfg");
    let new_cfg = config_in(&work, "new-cfg");
    let third_cfg = config_in(&work, "third-cfg");
    let a = init_as(&server, &work, "alpha", &holder_cfg).await;
    // Nothing creates a personal space until a pairing needs one.
    assert!(!directory_dir(&holder_cfg).join("config.json").exists());

    pair_devices(&server, &a, &holder_cfg, &new_cfg).await;
    let bound = std::fs::read(directory_dir(&holder_cfg).join("config.json")).unwrap();
    assert!(directory_dir(&new_cfg).join("config.json").exists());

    // A project made afterwards on the holder reaches the new device.
    init_as(&server, &work, "beta", &holder_cfg).await;
    let listed = stdout(&run_as(&work, &new_cfg, &["list"]).await);
    assert!(listed.contains("alpha"), "{listed}");
    assert!(listed.contains("beta"), "{listed}");
    // And back: the new device's own project shows up on the holder.
    init_as(&server, &work, "gamma", &new_cfg).await;
    let listed = stdout(&run_as(&work, &holder_cfg, &["list"]).await);
    assert!(listed.contains("gamma"), "{listed}");

    // A second pairing reuses the space instead of making another.
    pair_devices(&server, &a, &holder_cfg, &third_cfg).await;
    assert_eq!(
        std::fs::read(directory_dir(&holder_cfg).join("config.json")).unwrap(),
        bound
    );
    let listed = stdout(&run_as(&work, &third_cfg, &["list"]).await);
    for title in ["alpha", "beta", "gamma"] {
        assert!(listed.contains(title), "{listed}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_personal_space_that_holds_a_project_is_not_written_to() {
    let server = Server::start().await;
    let (_work, work) = temp();
    let cfg = config_in(&work, "cfg");
    let a = init_as(&server, &work, "alpha", &cfg).await;
    // Bind the directory to the project's own space, as a wrong link would.
    std::fs::copy(
        a.join(".typstry/config.json"),
        directory_dir(&cfg).join("config.json"),
    )
    .unwrap();
    let out = run_as(&work, &cfg, &["list"]).await;
    assert!(
        stderr(&out).contains("does not hold a directory"),
        "{}",
        stderr(&out)
    );
    // Nothing of the directory went into the project.
    let b = clone_as(
        &config_in(&work, "other"),
        &edit_link(&a, &cfg).await,
        &work,
        "b",
    )
    .await;
    assert_eq!(
        typstry_doc::doc_kind(&common::cached_doc(&b)).as_deref(),
        Some("project")
    );
}

async fn edit_link(dir: &Path, config: &Path) -> String {
    stdout(&run_as(dir, config, &["link", "--edit"]).await)
        .trim()
        .to_owned()
}
