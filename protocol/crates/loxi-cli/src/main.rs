use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use std::sync::{atomic::AtomicUsize, Arc};

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
    dotenv::dotenv().ok(); // Load .env before creating KeyManager
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
                let shared_cache = Arc::new(dashmap::DashMap::new());

                // Shared primitives for A1 (ticket verify) and B5 (worker count)
                let node_count = Arc::new(AtomicUsize::new(0));
                let km = Arc::new(loxi_orchestrator::auth::KeyManager::new());
                let verify_ticket: loxi_logistics::VerifyFn =
                    Arc::new(move |token: &str| {
                        km.verify_ticket(token).ok().map(|c| (c.sub, c.aud))
                    });

                let nc = node_count.clone();
                tokio::spawn(async move {
                    loxi_orchestrator::run_server(orchestrator_port, nc).await;
                });

                let verify_for_architect = verify_ticket.clone();
                let tx_clone = job_tx.clone();
                let cache_for_server = shared_cache.clone();
                tokio::spawn(async move {
                    loxi_logistics::server::start_artifact_server(
                        artifact_port,
                        artifact_dir,
                        tx_clone,
                        protocol_tx,
                        cache_for_server,
                        verify_ticket,
                        node_count,
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
                        "logistics",
                        job_rx,
                        protocol_rx,
                        cache_for_manager,
                        verify_for_architect,
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
