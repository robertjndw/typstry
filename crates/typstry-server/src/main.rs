use anyhow::Context;
use tracing_subscriber::EnvFilter;
use typstry_server::config::Config;
use typstry_server::http::{self, AppState};
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::db;

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
    let state = AppState::new(db.clone(), BlobStore::new(&config.data_dir));
    let app = http::router(state.clone(), &config.web_dist);

    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .with_context(|| format!("binding {}", config.addr))?;
    tracing::info!(addr = %config.addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // Every record is written before it is acked, so stopping the rooms only
    // lets them finish what is already queued.
    state.rooms.shutdown().await;
    db.close().await;
    tracing::info!("shut down");
    Ok(())
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        tracing::error!(%err, "failed to listen for ctrl-c");
        std::future::pending::<()>().await;
    }
}
