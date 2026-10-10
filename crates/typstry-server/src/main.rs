use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use anyhow::Context;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing_subscriber::EnvFilter;
use typstry_server::config::Config;
use typstry_server::http;
use typstry_server::state::AppState;
use typstry_server::store::db;

/// How long open WebSockets get to close before the rooms stop anyway.
const CONNECTION_GRACE: Duration = Duration::from_secs(5);

/// Below the image's HEALTHCHECK timeout so a hung server gets a proper error
/// instead of Docker killing the probe.
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(2);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug")),
        )
        .init();

    let config = Config::from_env()?;
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None | Some("serve") => serve(config).await,
        Some("backup") => {
            let Some(dest) = args.next() else {
                anyhow::bail!("usage: typstry-server backup <dest.db>");
            };
            let path = config.data_dir.join("typstry.db");
            if !path.is_file() {
                anyhow::bail!("no database at {}", path.display());
            }
            let db = db::open(&path).await?;
            db::backup(&db, dest.as_ref()).await?;
            db.close().await;
            tracing::info!(%dest, "database backed up; copy {} separately", config.data_dir.join("blobs").display());
            Ok(())
        }
        Some("healthcheck") => healthcheck(config.addr).await,
        Some(other) => {
            anyhow::bail!(
                "unknown command {other:?}; expected serve, backup <dest.db> or healthcheck"
            )
        }
    }
}

async fn serve(config: Config) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&config.data_dir)
        .await
        .with_context(|| format!("creating data dir {}", config.data_dir.display()))?;

    let db = db::open(&config.data_dir.join("typstry.db")).await?;
    let state = AppState::from_config(db.clone(), &config);
    let app = http::router(state.clone(), &config.web_dist);

    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .with_context(|| format!("binding {}", config.addr))?;
    tracing::info!(addr = %config.addr, "listening");

    // WebSockets are told to close as soon as the signal arrives, not after
    // HTTP drained: axum no longer waits for upgraded connections.
    let shutdown = state.shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutting down");
            shutdown.cancel();
        })
        .await?;

    // Every record is written before it is acked, so stopping the rooms only
    // lets them finish what is already queued.
    state.stop(CONNECTION_GRACE).await;
    db.close().await;
    tracing::info!("shut down");
    Ok(())
}

/// The container image has no curl, so its HEALTHCHECK uses this.
async fn healthcheck(addr: SocketAddr) -> anyhow::Result<()> {
    let addr = probe_addr(addr);
    let response = tokio::time::timeout(HEALTHCHECK_TIMEOUT, async {
        let mut stream = tokio::net::TcpStream::connect(addr).await?;
        // HTTP/1.0 so the server closes the connection and read_to_end
        // returns.
        stream
            .write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        anyhow::Ok(response)
    })
    .await
    .with_context(|| format!("no response from {addr} within {HEALTHCHECK_TIMEOUT:?}"))?
    .with_context(|| format!("requesting /healthz from {addr}"))?;

    let status_line = response.split(|&b| b == b'\r').next().unwrap_or_default();
    let status_line = String::from_utf8_lossy(status_line);
    if status_line.split(' ').nth(1) != Some("200") {
        anyhow::bail!("unhealthy: {status_line:?}");
    }
    Ok(())
}

/// 0.0.0.0 and :: can't be connected to, so probe loopback instead.
fn probe_addr(addr: SocketAddr) -> SocketAddr {
    match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => (Ipv4Addr::LOCALHOST, addr.port()).into(),
        IpAddr::V6(ip) if ip.is_unspecified() => (Ipv6Addr::LOCALHOST, addr.port()).into(),
        _ => addr,
    }
}

/// Ctrl-C, or SIGTERM from `docker stop` and service managers.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::error!(%err, "failed to listen for ctrl-c");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut sigterm) => {
                sigterm.recv().await;
            }
            Err(err) => {
                tracing::error!(%err, "failed to listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_addr_maps_unspecified_to_loopback() {
        let cases = [
            ("0.0.0.0:8787", "127.0.0.1:8787"),
            ("[::]:8787", "[::1]:8787"),
            ("10.0.0.5:9000", "10.0.0.5:9000"),
        ];
        for (bound, probed) in cases {
            assert_eq!(probe_addr(bound.parse().unwrap()), probed.parse().unwrap());
        }
    }
}
