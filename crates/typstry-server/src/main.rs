use std::time::Duration;

use anyhow::Context;
use tracing_subscriber::EnvFilter;
use typstry_server::config::Config;
use typstry_server::http;
use typstry_server::state::AppState;
use typstry_server::store::db;

/// How long open WebSockets get to close before the rooms stop anyway.
const CONNECTION_GRACE: Duration = Duration::from_secs(5);

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
        Some(other) => {
            anyhow::bail!("unknown command {other:?}; expected serve or backup <dest.db>")
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
