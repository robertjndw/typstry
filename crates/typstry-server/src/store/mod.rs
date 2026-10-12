pub mod blobs;
pub mod db;
pub mod docs;
pub mod mls;
pub mod spaces;

/// SQLite integers are signed. Anything above i64::MAX cannot be an epoch
/// of ours, so it saturates to a value that matches nothing.
pub(crate) fn sql(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

pub(crate) fn unsql(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}
