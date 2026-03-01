use loxi_orchestrator::run_server;
use std::sync::{atomic::AtomicUsize, Arc};

#[tokio::main]
async fn main() {
    // Default to port 3005 for standalone mode
    run_server(3005, Arc::new(AtomicUsize::new(0))).await;
}
