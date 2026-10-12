use std::env;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use crate::relay::RelayConfig;
use crate::room::RoomConfig;
use crate::store::blobs::DEFAULT_MAX_SIZE;
use crate::ws::ConnLimits;

#[derive(Debug, Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    pub web_dist: PathBuf,
    /// Largest asset upload, in bytes.
    pub max_upload_bytes: u64,
    pub rooms: RoomConfig,
    pub limits: ConnLimits,
    pub relay: RelayConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            addr: SocketAddr::from(([127, 0, 0, 1], 8787)),
            data_dir: "data".into(),
            web_dist: "apps/web/dist".into(),
            max_upload_bytes: DEFAULT_MAX_SIZE,
            rooms: RoomConfig::default(),
            limits: ConnLimits::default(),
            relay: RelayConfig::default(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("TYPSTRY_ADDR is not a valid socket address: {0:?}")]
    InvalidAddr(String),
    #[error("{var} must be {expected}, got {value:?}")]
    Invalid {
        var: &'static str,
        expected: &'static str,
        value: String,
    },
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|var| env::var_os(var))
    }

    /// [`Self::from_env`] over any variable source, so tests need not touch
    /// the process environment.
    fn from_lookup(lookup: impl Fn(&str) -> Option<OsString>) -> Result<Self, ConfigError> {
        let mut config = Self::default();
        // Variables that are not valid UTF-8 count as unset, as they always
        // have for TYPSTRY_ADDR.
        let text = |var: &str| lookup(var).and_then(|value| value.into_string().ok());

        if let Some(raw) = text("TYPSTRY_ADDR") {
            config.addr = raw.parse().map_err(|_| ConfigError::InvalidAddr(raw))?;
        }
        if let Some(dir) = lookup("TYPSTRY_DATA_DIR") {
            config.data_dir = dir.into();
        }
        if let Some(dir) = lookup("TYPSTRY_WEB_DIST") {
            config.web_dist = dir.into();
        }

        let parse = |var, expected| Var {
            text: &text,
            var,
            expected,
        };

        if let Some(bytes) =
            parse("TYPSTRY_MAX_UPLOAD_BYTES", "a positive byte count").get_where(|&n| n >= 1)?
        {
            config.max_upload_bytes = bytes;
        }
        if let Some(secs) = parse("TYPSTRY_ROOM_UNLOAD_SECS", "whole seconds").get()? {
            config.rooms.unload_after = Duration::from_secs(secs);
        }
        // Zero would expire every cursor on the next tick.
        if let Some(secs) = parse("TYPSTRY_PRESENCE_TIMEOUT_SECS", "positive whole seconds")
            .get_where(|&n| n >= 1)?
        {
            config.rooms.ephemeral_timeout = Duration::from_secs(secs);
        }
        // A bucket that never holds a whole token refuses every update.
        if let Some(burst) =
            parse("TYPSTRY_UPDATE_BURST", "a positive whole number").get_where(|&n| n >= 1)?
        {
            config.limits.update_burst = burst;
        }
        // Zero would never refill the bucket, and NaN poisons it.
        if let Some(rate) = parse("TYPSTRY_UPDATES_PER_SEC", "a positive number")
            .get_where(|&r: &f64| r.is_finite() && r > 0.0)?
        {
            config.limits.updates_per_sec = rate;
        }
        // The app joins two rooms per space: the doc and presence.
        if let Some(rooms) = parse("TYPSTRY_MAX_ROOMS_PER_CONN", "a whole number of at least 2")
            .get_where(|&n| n >= 2)?
        {
            config.limits.max_rooms = rooms;
        }
        if let Some(bytes) =
            parse("TYPSTRY_OUTBOX_BYTES", "a positive byte count").get_where(|&n| n >= 1)?
        {
            config.limits.outbox_bytes = bytes;
        }
        // Zero is fine: the newest commits are kept regardless.
        if let Some(secs) = parse("TYPSTRY_COMMIT_RETENTION_SECS", "whole seconds").get()? {
            config.rooms.ds.commit_retention = Duration::from_secs(secs);
        }
        // The head commit must survive, or a member one epoch behind is lost.
        if let Some(n) =
            parse("TYPSTRY_KEEP_LAST_COMMITS", "a positive whole number").get_where(|&n| n >= 1)?
        {
            config.rooms.ds.keep_last_commits = n;
        }
        if let Some(bytes) =
            parse("TYPSTRY_MAX_LOG_BYTES", "a positive byte count").get_where(|&n| n >= 1)?
        {
            config.rooms.ds.max_log_bytes = bytes;
        }
        if let Some(bytes) =
            parse("TYPSTRY_MAX_COMMIT_BYTES", "a positive byte count").get_where(|&n| n >= 1)?
        {
            config.rooms.ds.max_commit_bytes = bytes;
        }
        if let Some(bytes) =
            parse("TYPSTRY_MAX_GROUP_INFO_BYTES", "a positive byte count").get_where(|&n| n >= 1)?
        {
            config.rooms.ds.max_group_info_bytes = bytes;
        }
        // Zero would expire every channel before anyone can join it.
        if let Some(secs) =
            parse("TYPSTRY_RELAY_TTL_SECS", "positive whole seconds").get_where(|&n| n >= 1)?
        {
            config.relay.ttl = Duration::from_secs(secs);
        }
        if let Some(n) =
            parse("TYPSTRY_RELAY_MAX_CHANNELS", "a positive whole number").get_where(|&n| n >= 1)?
        {
            config.relay.max_channels = n;
        }
        Ok(config)
    }
}

/// One numeric variable and how to say what it should hold.
struct Var<'a, F> {
    text: &'a F,
    var: &'static str,
    expected: &'static str,
}

impl<F: Fn(&str) -> Option<String>> Var<'_, F> {
    fn get<T: FromStr>(&self) -> Result<Option<T>, ConfigError> {
        self.get_where(|_| true)
    }

    /// The parsed value, if set, refusing one that is not `valid`.
    fn get_where<T: FromStr>(&self, valid: impl Fn(&T) -> bool) -> Result<Option<T>, ConfigError> {
        let Some(value) = (self.text)(self.var) else {
            return Ok(None);
        };
        match value.trim().parse() {
            Ok(parsed) if valid(&parsed) => Ok(Some(parsed)),
            _ => Err(ConfigError::Invalid {
                var: self.var,
                expected: self.expected,
                value,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let vars: HashMap<String, OsString> = vars
            .iter()
            .map(|&(k, v)| (k.to_owned(), v.into()))
            .collect();
        Config::from_lookup(|var| vars.get(var).cloned())
    }

    #[test]
    fn defaults_without_variables() {
        let config = config(&[]).unwrap();
        assert_eq!(config.addr.to_string(), "127.0.0.1:8787");
        assert_eq!(config.data_dir, PathBuf::from("data"));
        assert_eq!(config.max_upload_bytes, 25 * 1024 * 1024);
        assert_eq!(config.rooms.unload_after, Duration::from_secs(60));
        assert_eq!(config.limits.update_burst, 200);
        assert_eq!(config.rooms.ds.keep_last_commits, 1000);
        assert_eq!(
            config.rooms.ds.commit_retention,
            Duration::from_secs(90 * 86_400)
        );
        assert_eq!(config.rooms.ds.max_group_info_bytes, 256 * 1024);
        assert_eq!(config.rooms.ds.max_commit_bytes, 64 * 1024);
        assert_eq!(config.rooms.ds.max_log_bytes, 16 * 1024 * 1024);
        assert_eq!(config.relay.ttl, Duration::from_secs(300));
        assert_eq!(config.relay.max_channels, 1000);
    }

    #[test]
    fn variables_override_defaults() {
        let config = config(&[
            ("TYPSTRY_ADDR", "0.0.0.0:9000"),
            ("TYPSTRY_MAX_UPLOAD_BYTES", "1048576"),
            ("TYPSTRY_ROOM_UNLOAD_SECS", "5"),
            ("TYPSTRY_PRESENCE_TIMEOUT_SECS", "10"),
            ("TYPSTRY_UPDATE_BURST", "10"),
            ("TYPSTRY_UPDATES_PER_SEC", "2.5"),
            ("TYPSTRY_MAX_ROOMS_PER_CONN", "3"),
            ("TYPSTRY_OUTBOX_BYTES", "1000"),
            ("TYPSTRY_COMMIT_RETENTION_SECS", "60"),
            ("TYPSTRY_KEEP_LAST_COMMITS", "7"),
            ("TYPSTRY_MAX_GROUP_INFO_BYTES", "4096"),
            ("TYPSTRY_MAX_COMMIT_BYTES", "2048"),
            ("TYPSTRY_MAX_LOG_BYTES", "99999"),
            ("TYPSTRY_RELAY_TTL_SECS", "30"),
            ("TYPSTRY_RELAY_MAX_CHANNELS", "5"),
        ])
        .unwrap();
        assert_eq!(config.addr.port(), 9000);
        assert_eq!(config.max_upload_bytes, 1 << 20);
        assert_eq!(config.rooms.unload_after, Duration::from_secs(5));
        assert_eq!(config.rooms.ephemeral_timeout, Duration::from_secs(10));
        assert_eq!(config.limits.update_burst, 10);
        assert_eq!(config.limits.updates_per_sec, 2.5);
        assert_eq!(config.limits.max_rooms, 3);
        assert_eq!(config.limits.outbox_bytes, 1000);
        assert_eq!(config.rooms.ds.commit_retention, Duration::from_secs(60));
        assert_eq!(config.rooms.ds.keep_last_commits, 7);
        assert_eq!(config.rooms.ds.max_group_info_bytes, 4096);
        assert_eq!(config.rooms.ds.max_commit_bytes, 2048);
        assert_eq!(config.rooms.ds.max_log_bytes, 99_999);
        assert_eq!(config.relay.ttl, Duration::from_secs(30));
        assert_eq!(config.relay.max_channels, 5);
    }

    #[test]
    fn rejects_bad_values() {
        for (var, value) in [
            ("TYPSTRY_ADDR", "nowhere"),
            ("TYPSTRY_MAX_UPLOAD_BYTES", "-1"),
            ("TYPSTRY_ROOM_UNLOAD_SECS", "1.5"),
            ("TYPSTRY_UPDATES_PER_SEC", "0"),
            ("TYPSTRY_UPDATES_PER_SEC", "NaN"),
            ("TYPSTRY_UPDATE_BURST", "0"),
            ("TYPSTRY_MAX_ROOMS_PER_CONN", "1"),
            ("TYPSTRY_MAX_ROOMS_PER_CONN", "0"),
            ("TYPSTRY_OUTBOX_BYTES", "0"),
            ("TYPSTRY_MAX_UPLOAD_BYTES", "0"),
            ("TYPSTRY_PRESENCE_TIMEOUT_SECS", "0"),
            ("TYPSTRY_KEEP_LAST_COMMITS", "0"),
            ("TYPSTRY_MAX_GROUP_INFO_BYTES", "0"),
            ("TYPSTRY_MAX_COMMIT_BYTES", "0"),
            ("TYPSTRY_MAX_LOG_BYTES", "0"),
            ("TYPSTRY_COMMIT_RETENTION_SECS", "-1"),
            ("TYPSTRY_RELAY_TTL_SECS", "0"),
            ("TYPSTRY_RELAY_MAX_CHANNELS", "0"),
        ] {
            assert!(config(&[(var, value)]).is_err(), "{var}={value}");
        }
        let err = config(&[("TYPSTRY_MAX_ROOMS_PER_CONN", " 1")]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "TYPSTRY_MAX_ROOMS_PER_CONN must be a whole number of at least 2, got \" 1\""
        );
    }
}
