//! Shared by the `compat` tests of typstry-cli, typstry-doc and
//! typstry-wire through `#[path]`, so all three find the same fixtures.
//! typstry-doc and typstry-wire don't depend on each other, so this can't
//! live in either.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn compat_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/compat")
}

/// Every `v<N>` directory, oldest first.
pub fn compat_dirs() -> Vec<(u32, PathBuf)> {
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

pub fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

pub fn str_of(value: &Value) -> &str {
    value.as_str().unwrap()
}
