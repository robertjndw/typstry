//! Telling unchanged files by their `stat`, the way git's index does, and
//! the caches that rely on it.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use ignore::gitignore::Gitignore;

use super::LocalFile;
use super::ignore::IgnoreBase;

/// How far apart two writes to a file must be for its timestamps to tell
/// them apart. Nanoseconds on APFS and ext4, but a second on HFS+ and two
/// on FAT, so this assumes the worst.
pub(super) const TIMESTAMP_GRANULARITY: Duration = Duration::from_secs(2);

/// What `stat` says about a file, compared instead of its bytes to tell
/// whether it changed, the way git's index does. On unix the inode and
/// ctime also catch a file replaced by a rename or written by a tool that
/// restores the old mtime afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Stamp {
    pub(super) len: u64,
    mtime: SystemTime,
    #[cfg(unix)]
    ctime: SystemTime,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl Stamp {
    /// None where the platform has no mtime, which then is never cached.
    pub(super) fn of(meta: &fs::Metadata) -> Option<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt as _;
        Some(Self {
            len: meta.len(),
            mtime: meta.modified().ok()?,
            #[cfg(unix)]
            ctime: u64::try_from(meta.ctime()).map_or(SystemTime::UNIX_EPOCH, |secs| {
                SystemTime::UNIX_EPOCH + Duration::new(secs, meta.ctime_nsec() as u32)
            }),
            #[cfg(unix)]
            dev: meta.dev(),
            #[cfg(unix)]
            ino: meta.ino(),
        })
    }

    fn last_change(&self) -> SystemTime {
        #[cfg(unix)]
        return self.mtime.max(self.ctime);
        #[cfg(not(unix))]
        self.mtime
    }
}

/// A value derived from a file's bytes, valid while the file's [`Stamp`]
/// stays the same.
#[derive(Debug)]
pub(super) struct Stamped<V> {
    pub(super) stamp: Stamp,
    /// When the file was looked at, taken before the `stat`.
    pub(super) seen: SystemTime,
    pub(super) value: V,
}

impl<V> Stamped<V> {
    /// Whether the value still describes a file that now has `stamp`. A
    /// file changed within the timestamp granularity of when it was read
    /// is "racily clean" in git's words: a second write in the same tick
    /// leaves the stamp as it was, so the value is not trusted until the
    /// file has been quiet for longer than that.
    pub(super) fn holds_for(&self, stamp: &Stamp, granularity: Duration) -> bool {
        self.stamp == *stamp
            && self
                .stamp
                .last_change()
                .checked_add(granularity)
                .is_some_and(|settled| settled < self.seen)
    }
}

/// Shared between clones, so the walker's filter in [`Worktree::scan`]
/// fills the same cache.
#[derive(Debug)]
pub(super) struct Caches {
    pub(super) ignore_base: Mutex<Option<Arc<IgnoreBase>>>,
    /// Compiled ignore files by path.
    pub(super) matchers: Mutex<HashMap<PathBuf, Stamped<Arc<Gitignore>>>>,
    /// Scanned files by project path. Holds the text of text files, which
    /// callers need anyway, and only the digest of assets.
    pub(super) files: Mutex<HashMap<String, Stamped<LocalFile>>>,
    pub(super) granularity: Duration,
    /// How often a file was actually read, for tests to see cache hits.
    #[cfg(test)]
    pub(super) reads: std::sync::atomic::AtomicUsize,
}

impl Default for Caches {
    fn default() -> Self {
        Self {
            ignore_base: Mutex::default(),
            matchers: Mutex::default(),
            files: Mutex::default(),
            granularity: TIMESTAMP_GRANULARITY,
            #[cfg(test)]
            reads: Default::default(),
        }
    }
}
