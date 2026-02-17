use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "loxi")]
struct Args {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Parser, Debug)]
enum Commands {
    Node {
        #[arg(long, default_value = "3005")]
        port: u16,
        #[arg(long, default_value = "8080")]
        http_port: u16,
        #[arg(long, default_value = "./dist")]
        dist: PathBuf,
    },
}

fn main() -> Result<()> {
    let args = Args::parse();

    match &args.command {
        Some(Commands::Node { port, http_port, dist }) => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let orchestrator_port = *port;
                let artifact_port = *http_port;
                let artifact_dir = dist.clone();
                let orchestrator_url = format!("ws://localhost:{}", orchestrator_port);

                let (job_tx, job_rx) = tokio::sync::mpsc::unbounded_channel();
                let (protocol_tx, protocol_rx) = tokio::sync::mpsc::unbounded_channel();
                let shared_cache = std::sync::Arc::new(dashmap::DashMap::new());

                tokio::spawn(async move {
                    loxi_orchestrator::run_server(orchestrator_port).await;
                });

                let tx_clone = job_tx.clone();
                let cache_for_server = shared_cache.clone();
                tokio::spawn(async move {
                    loxi_logistics::server::start_artifact_server(
                        artifact_port,
                        artifact_dir,
                        tx_clone,
                        protocol_tx,
                        cache_for_server,
                    )
                    .await;
                });

                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

                let cache_for_manager = shared_cache.clone();
                let authority_ws_url = format!("ws://localhost:{}/logistics/data", artifact_port);
                tokio::spawn(async move {
                    loxi_logistics::architect::LogisticsArchitect::run_architect(
                        &orchestrator_url,
                        &authority_ws_url,
                        job_rx,
                        protocol_rx,
                        cache_for_manager,
                    )
                    .await;
                });

                tokio::signal::ctrl_c().await.unwrap();
            });
        }
        None => {}
    }

    Ok(())
}
