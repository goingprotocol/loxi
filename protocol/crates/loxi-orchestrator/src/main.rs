use loxi_orchestrator::run_server;

#[tokio::main]
async fn main() {
    // Default to port 3005 for standalone mode
    run_server(3005).await;
}
