use std::env;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

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

        if let Some(bytes) =
            parse_min(text, "TYPSTRY_MAX_UPLOAD_BYTES", 1, "a positive byte count")?
        {
            config.max_upload_bytes = bytes;
        }
        if let Some(secs) = parse(text, "TYPSTRY_ROOM_UNLOAD_SECS", "whole seconds")? {
            config.rooms.unload_after = Duration::from_secs(secs);
        }
        // Zero would expire every cursor on the next tick.
        if let Some(secs) = parse_min(
            text,
            "TYPSTRY_PRESENCE_TIMEOUT_SECS",
            1,
            "positive whole seconds",
        )? {
            config.rooms.ephemeral_timeout = Duration::from_secs(secs);
        }
        // A bucket that never holds a whole token refuses every update.
        if let Some(burst) = parse_min(text, "TYPSTRY_UPDATE_BURST", 1, "a positive whole number")?
        {
            config.limits.update_burst = burst;
        }
        if let Some(rate) = parse::<f64>(text, "TYPSTRY_UPDATES_PER_SEC", "a positive number")? {
            // Zero would never refill the bucket, and NaN poisons it.
            if !(rate.is_finite() && rate > 0.0) {
                return Err(ConfigError::Invalid {
                    var: "TYPSTRY_UPDATES_PER_SEC",
                    expected: "a positive number",
                    value: rate.to_string(),
                });
            }
            config.limits.updates_per_sec = rate;
        }
        // The app joins two rooms per project: the doc and presence.
        if let Some(rooms) = parse_min(
            text,
            "TYPSTRY_MAX_ROOMS_PER_CONN",
            2,
            "a whole number of at least 2",
        )? {
            config.limits.max_rooms = rooms;
        }
        if let Some(bytes) = parse_min(text, "TYPSTRY_OUTBOX_BYTES", 1, "a positive byte count")? {
            config.limits.outbox_bytes = bytes;
        }
        Ok(config)
    }
}

/// [`parse`] for counts that are only meaningful from `min` up.
fn parse_min<T: FromStr + PartialOrd>(
    text: impl Fn(&str) -> Option<String>,
    var: &'static str,
    min: T,
    expected: &'static str,
) -> Result<Option<T>, ConfigError> {
    let Some(value) = parse(&text, var, expected)? else {
        return Ok(None);
    };
    if value < min {
        return Err(ConfigError::Invalid {
            var,
            expected,
            value: text(var).unwrap_or_default(),
        });
    }
    Ok(Some(value))
}

fn parse<T: FromStr>(
    text: impl Fn(&str) -> Option<String>,
    var: &'static str,
    expected: &'static str,
) -> Result<Option<T>, ConfigError> {
    let Some(value) = text(var) else {
        return Ok(None);
    };
    match value.trim().parse() {
        Ok(parsed) => Ok(Some(parsed)),
        Err(_) => Err(ConfigError::Invalid {
            var,
            expected,
            value,
        }),
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
