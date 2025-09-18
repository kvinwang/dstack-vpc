use anyhow::{Context, Result};
use clap::Parser;
use config::{load_config_figment, Config};
use tracing::info;

mod client;
mod config;
mod server;

fn app_version() -> String {
    const CARGO_PKG_VERSION: &str = env!("CARGO_PKG_VERSION");
    const VERSION: &str = git_version::git_version!(
        args = ["--abbrev=20", "--always", "--dirty=-modified"],
        prefix = "git:",
        fallback = "unknown"
    );
    format!("v{CARGO_PKG_VERSION} ({VERSION})")
}

#[derive(Parser)]
#[command(name = "dstack-mesh")]
#[command(about = "dstack service mesh proxy")]
#[command(version)]
struct Args {
    /// Path to the configuration file
    #[arg(short, long)]
    config: Option<String>,
}

#[rocket::main]
async fn main() -> Result<()> {
    // Initialize tracing with config
    tracing_subscriber::fmt().init();

    let args = Args::parse();

    // Load configuration
    let figment = load_config_figment(args.config.as_deref());
    let config: Config = figment.extract().context("Failed to load configuration")?;

    info!("Starting dstack mesh proxy {}", app_version());
    info!("Configuration loaded successfully");

    // Start both services - each service creates its own Rocket figment internally
    tokio::select! {
        result = client::run_client_proxy(
            &figment,
            &config
        ) => {
            result.context("Client proxy failed")?;
        }
        result = server::run_auth_service(&figment) => {
            result.context("Auth service failed")?;
        }
    }

    Ok(())
}
