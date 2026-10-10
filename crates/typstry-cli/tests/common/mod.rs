//! Project setup shared by the integration tests. Each test binary runs
//! its own server, since they need different lifetimes for it.

// Every test binary compiles this module but uses only part of it.
#![allow(dead_code)]

use std::path::Path;

use typstry_cli::api::Api;
use typstry_cli::engine::Session;
use typstry_cli::link::ShareLink;
use typstry_doc::init::init_project;
use typstry_wire::crypto::ProjectKey;

/// A new, empty project on the server at `origin`: `(edit, view)`.
pub async fn create_project(origin: &str) -> (ShareLink, ShareLink) {
    let created = Api::new(origin).unwrap().create_project().await.unwrap();
    let key = ProjectKey::generate_raw();
    (
        ShareLink::new(origin, &created.edit_token, &key),
        ShareLink::new(origin, &created.view_token, &key),
    )
}

/// A connected session standing in for a browser.
pub async fn seeder(link: &ShareLink, dir: &Path) -> Session {
    let share = Api::new(&link.origin)
        .unwrap()
        .resolve_share(&link.token)
        .await
        .unwrap();
    let mut session = Session::create(dir, link, &share, Some("Seeder")).unwrap();
    session.connect().await.unwrap();
    session
}

/// A project seeded like the browser does, with a title and the starter
/// main.typ: `(edit link, view link)`.
pub async fn seeded_project(origin: &str, title: &str) -> (String, String) {
    let (edit, view) = create_project(origin).await;
    let seed = tempfile::tempdir().unwrap();
    let mut session = seeder(&edit, seed.path()).await;
    init_project(&session.doc, title).unwrap();
    session.push_local().await.unwrap();
    session.disconnect().await;
    (edit.to_string(), view.to_string())
}
