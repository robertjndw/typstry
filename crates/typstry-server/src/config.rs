use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    pub web_dist: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("TYPSTRY_ADDR is not a valid socket address: {0:?}")]
    InvalidAddr(String),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let addr_raw = env::var("TYPSTRY_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
        let addr = addr_raw
            .parse()
            .map_err(|_| ConfigError::InvalidAddr(addr_raw))?;
        let data_dir = env::var_os("TYPSTRY_DATA_DIR").map_or_else(|| "data".into(), PathBuf::from);
        let web_dist =
            env::var_os("TYPSTRY_WEB_DIST").map_or_else(|| "apps/web/dist".into(), PathBuf::from);
        Ok(Self {
            addr,
            data_dir,
            web_dist,
        })
    }
}
