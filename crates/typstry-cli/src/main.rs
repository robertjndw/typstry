use clap::Parser;
use tracing_subscriber::EnvFilter;
use typstry_cli::commands::{self, Cli};
use typstry_cli::engine::Conflicts;

#[tokio::main]
async fn main() {
    let filter = EnvFilter::try_from_env("TYPSTRY_LOG")
        .unwrap_or_else(|_| EnvFilter::new("warn"))
        // Their debug output has request URLs and raw frames, which hold
        // the share token, and logs get pasted into bug reports.
        .add_directive("reqwest=info".parse().expect("valid directive"))
        .add_directive("tungstenite=info".parse().expect("valid directive"))
        .add_directive("tokio_tungstenite=info".parse().expect("valid directive"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    if let Err(err) = commands::run(Cli::parse()).await {
        eprintln!("error: {err:#}");
        if err.downcast_ref::<Conflicts>().is_some() {
            eprintln!(
                "hint: run `typstry push` to merge both sides, or undo the local changes and pull again"
            );
        }
        std::process::exit(1);
    }
}
