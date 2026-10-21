//! Project packages and font bundles, mirroring
//! `apps/web/src/packages/records.ts`. A package is a plain map under the
//! root `packages` map, keyed [`package_key`]; see [`crate::package`] for its
//! fields. The archive itself is an asset blob addressed by `hash`.

use loro::{LoroDoc, LoroMapValue, LoroValue};

use crate::{meta, package, package_source, root};

/// A package record that passed the same checks `parsePackageRecord` does.
#[derive(Debug, Clone, PartialEq)]
pub struct Package {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub hash: String,
    pub size: i64,
    pub mime: String,
    pub entrypoint: String,
    pub description: Option<String>,
    pub authors: Option<Vec<String>>,
    pub license: Option<String>,
    pub compiler: Option<String>,
    pub file_count: i64,
    pub unpacked_size: i64,
    /// One of the [`package_source`] values.
    pub source: String,
    /// Unix milliseconds.
    pub added_at: i64,
}

/// The key a package is stored under: `namespace/name/version`.
pub fn package_key(namespace: &str, name: &str, version: &str) -> String {
    format!("{namespace}/{name}/{version}")
}

/// Every well-formed package, sorted by key. Entries from a broken or
/// hostile peer are skipped, since their fields end up in paths and package
/// specs.
pub fn packages(doc: &LoroDoc) -> Vec<Package> {
    let LoroValue::Map(map) = doc.get_map(root::PACKAGES).get_value() else {
        return Vec::new();
    };
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    keys.into_iter()
        .filter_map(|key| match map.get(key)? {
            LoroValue::Map(entry) => parse(key, entry),
            _ => None,
        })
        .collect()
}

/// Whether the CJK and emoji font bundles are enabled, in that order.
pub fn font_bundles(doc: &LoroDoc) -> (bool, bool) {
    let meta_map = doc.get_map(root::META);
    let flag = |key: &str| {
        matches!(
            meta_map.get(key).and_then(|v| v.into_value().ok()),
            Some(LoroValue::Bool(true))
        )
    };
    (flag(meta::CJK_FONTS), flag(meta::EMOJI_FONTS))
}

fn parse(key: &str, entry: &LoroMapValue) -> Option<Package> {
    let namespace = segment(entry, package::NAMESPACE)?;
    let name = segment(entry, package::NAME)?;
    let version = segment(entry, package::VERSION)?;
    if key != package_key(&namespace, &name, &version) {
        return None;
    }
    let entrypoint = string(entry, package::ENTRYPOINT)?;
    if !is_relative_path(&entrypoint) {
        return None;
    }
    let source = string(entry, package::SOURCE)?;
    if source != package_source::UPLOAD && source != package_source::UNIVERSE {
        return None;
    }
    Some(Package {
        namespace,
        name,
        version,
        hash: string(entry, package::HASH)?,
        size: number(entry, package::SIZE)?,
        mime: string(entry, package::MIME)?,
        entrypoint,
        description: optional(entry, package::DESCRIPTION, string)?,
        authors: optional(entry, package::AUTHORS, string_list)?,
        license: optional(entry, package::LICENSE, string)?,
        compiler: optional(entry, package::COMPILER, string)?,
        file_count: number(entry, package::FILE_COUNT)?,
        unpacked_size: number(entry, package::UNPACKED_SIZE)?,
        source,
        added_at: number(entry, package::ADDED_AT)?,
    })
}

fn string(entry: &LoroMapValue, field: &str) -> Option<String> {
    match entry.get(field)? {
        LoroValue::String(s) => Some(s.to_string()),
        _ => None,
    }
}

/// Browsers store JS numbers, so counts usually arrive as doubles.
fn number(entry: &LoroMapValue, field: &str) -> Option<i64> {
    match entry.get(field)? {
        LoroValue::I64(v) => Some(*v),
        LoroValue::Double(v) if v.is_finite() => Some(*v as i64),
        _ => None,
    }
}

fn string_list(entry: &LoroMapValue, field: &str) -> Option<Vec<String>> {
    let LoroValue::List(list) = entry.get(field)? else {
        return None;
    };
    list.iter()
        .map(|v| match v {
            LoroValue::String(s) => Some(s.to_string()),
            _ => None,
        })
        .collect()
}

/// Absent is fine (`Some(None)`); present but the wrong type rejects the
/// whole record (`None`), like the TS parser.
fn optional<T>(
    entry: &LoroMapValue,
    field: &str,
    read: impl Fn(&LoroMapValue, &str) -> Option<T>,
) -> Option<Option<T>> {
    if entry.get(field).is_none() {
        return Some(None);
    }
    read(entry, field).map(Some)
}

fn segment(entry: &LoroMapValue, field: &str) -> Option<String> {
    let value = string(entry, field)?;
    (!value.is_empty() && !value.contains('/') && !value.contains("..")).then_some(value)
}

fn is_relative_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    !path.is_empty()
        && !path.starts_with(['/', '\\'])
        && !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        && !path.split(['/', '\\']).any(|part| part == "..")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn entry(overrides: &[(&str, LoroValue)]) -> LoroValue {
        let mut map: HashMap<String, LoroValue> = [
            (package::NAMESPACE, LoroValue::from("local")),
            (package::NAME, LoroValue::from("thesis")),
            (package::VERSION, LoroValue::from("1.0.0")),
            (package::HASH, LoroValue::from("abc")),
            (package::SIZE, LoroValue::from(10.0)),
            (package::MIME, LoroValue::from("application/gzip")),
            (package::ENTRYPOINT, LoroValue::from("lib.typ")),
            (package::FILE_COUNT, LoroValue::from(2.0)),
            (package::UNPACKED_SIZE, LoroValue::from(40_i64)),
            (package::SOURCE, LoroValue::from(package_source::UPLOAD)),
            (package::ADDED_AT, LoroValue::from(1.7e12)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        for (k, v) in overrides {
            map.insert((*k).to_owned(), v.clone());
        }
        LoroValue::Map(LoroMapValue::from(map))
    }

    fn put(doc: &LoroDoc, key: &str, value: LoroValue) {
        doc.get_map(root::PACKAGES).insert(key, value).unwrap();
    }

    #[test]
    fn reads_sorted_valid_packages() {
        let doc = LoroDoc::new();
        let authors = LoroValue::List(vec![LoroValue::from("Ada")].into());
        put(
            &doc,
            "local/thesis/1.0.0",
            entry(&[(package::AUTHORS, authors)]),
        );
        put(
            &doc,
            "local/alpha/1.0.0",
            entry(&[(package::NAME, LoroValue::from("alpha"))]),
        );
        let found = packages(&doc);
        let names: Vec<_> = found.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["alpha", "thesis"]);
        let thesis = &found[1];
        assert_eq!(thesis.size, 10);
        assert_eq!(thesis.added_at, 1_700_000_000_000);
        assert_eq!(thesis.unpacked_size, 40);
        assert_eq!(thesis.authors.as_deref(), Some(&["Ada".to_owned()][..]));
        assert_eq!(thesis.description, None);
    }

    #[test]
    fn skips_malformed_entries() {
        let doc = LoroDoc::new();
        put(&doc, "local/thesis/2.0.0", entry(&[])); // key mismatch
        put(&doc, "local/thesis/1.0.0", LoroValue::from("junk"));
        let bad = |field: &str, value: LoroValue, key: &str| {
            put(&doc, key, entry(&[(field, value)]));
        };
        bad(
            package::SOURCE,
            LoroValue::from("elsewhere"),
            "local/thesis/1.0.0",
        );
        assert!(packages(&doc).is_empty());
        bad(
            package::SIZE,
            LoroValue::from(f64::NAN),
            "local/thesis/1.0.0",
        );
        bad(package::HASH, LoroValue::from(1_i64), "local/thesis/1.0.0");
        bad(package::AUTHORS, LoroValue::from("x"), "local/thesis/1.0.0");
        bad(package::NAME, LoroValue::from("a/b"), "local/a/b/1.0.0");
        bad(package::VERSION, LoroValue::from(".."), "local/thesis/..");
        for entrypoint in ["/etc/passwd", "../x.typ", "a/../../x.typ", "C:x.typ"] {
            bad(
                package::ENTRYPOINT,
                LoroValue::from(entrypoint),
                "local/thesis/1.0.0",
            );
            assert!(packages(&doc).is_empty(), "{entrypoint}");
        }
        assert!(packages(&doc).is_empty());
    }

    #[test]
    fn reads_font_bundles() {
        let doc = LoroDoc::new();
        assert_eq!(font_bundles(&doc), (false, false));
        let meta_map = doc.get_map(root::META);
        meta_map.insert(meta::EMOJI_FONTS, true).unwrap();
        meta_map.insert(meta::CJK_FONTS, "yes").unwrap();
        assert_eq!(font_bundles(&doc), (false, true));
    }
}
