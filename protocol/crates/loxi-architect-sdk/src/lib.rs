use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use loxi_core::Message as LoxiMessage;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Trait that any Domain Manager must implement to host its own data server.
#[async_trait]
pub trait DataProvider: Send + Sync {
    async fn get_payload(&self, auction_id: &str) -> Option<String>;
    async fn handle_solution(&self, solution: loxi_core::Solution) -> Vec<LoxiMessage>;
    async fn handle_push_data(
        &self,
        auction_id: String,
        payload: String,
        progress: f32,
    ) -> Vec<LoxiMessage>;
    async fn handle_mission_status(
        &self,
        mission_id: String,
        status: String,
        details: Option<String>,
    ) -> Vec<LoxiMessage>;
}

/// Generic container for grouping related tasks.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct Mission {
    pub id: String,
    pub domain: String,
    pub tasks: Vec<String>,
    pub status: String,
    pub metadata: HashMap<String, String>,
}

pub struct DataServer<P: DataProvider> {
    provider: Arc<P>,
    domain_id: String,
    // Active Room Connections: auction_id -> Vec<mpsc::Sender<WsMessage>>
    active_rooms: Arc<Mutex<HashMap<String, Vec<mpsc::Sender<WsMessage>>>>>,
}

impl<P: DataProvider + 'static> DataServer<P> {
    pub fn new(provider: Arc<P>, domain_id: String) -> Self {
        Self { provider, domain_id, active_rooms: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn start(
        self,
        port: u16,
        orchestrator_tx: mpsc::Sender<LoxiMessage>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let addr = format!("0.0.0.0:{}", port);
        let listener = TcpListener::bind(&addr).await?;
        println!("🔒 [ArchitectSDK] Data Server (La Sala) listening on: {}", addr);

        let server_arc = Arc::new(self);

        while let Ok((stream, addr)) = listener.accept().await {
            let server = server_arc.clone();
            let tx = orchestrator_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = server.handle_worker_direct(stream, tx).await {
                    println!("❌ [ArchitectSDK] Error handling direct worker {}: {}", addr, e);
                }
            });
        }
        Ok(())
    }

    async fn handle_worker_direct(
        &self,
        stream: TcpStream,
        orchestrator_tx: mpsc::Sender<LoxiMessage>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ws_stream = accept_async(stream).await?;
        let (mut sink, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<WsMessage>(32);

        // Task to send messages to this worker
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        while let Some(msg_result) = read.next().await {
            match msg_result {
                Ok(msg) => {
                    if msg.is_text() {
                        if let Ok(text) = msg.to_text() {
                            if let Ok(loxi_msg) = serde_json::from_str::<LoxiMessage>(text) {
                                match loxi_msg {
                                    LoxiMessage::DiscoverAuthority { domain_id: auction_id } => {
                                        self.active_rooms
                                            .lock()
                                            .await
                                            .entry(auction_id.clone())
                                            .or_default()
                                            .push(tx.clone());

                                        if let Some(payload_str) =
                                            self.provider.get_payload(&auction_id).await
                                        {
                                            // Wrap in loxi_types::Problem for agnostic transport
                                            let agnostic = loxi_types::Problem {
                                                auction_id: auction_id.clone(),
                                                domain_id: self.domain_id.clone(),
                                                payload: Some(payload_str),
                                            };
                                            let _ = tx
                                                .send(WsMessage::Text(serde_json::to_string(
                                                    &agnostic,
                                                )?))
                                                .await;
                                        } else {
                                            let error_msg = serde_json::json!({
                                                "error": format!("Payload for ID {} not found", auction_id),
                                                "auction_id": auction_id
                                            });
                                            let _ = tx
                                                .send(WsMessage::Text(error_msg.to_string()))
                                                .await;
                                        }
                                    }
                                    LoxiMessage::SubmitSolution(solution) => {
                                        let outbound =
                                            self.provider.handle_solution(solution).await;
                                        for out_msg in outbound {
                                            let _ = orchestrator_tx.send(out_msg).await;
                                        }
                                    }
                                    LoxiMessage::PushData { auction_id, payload, progress } => {
                                        let outbound = self
                                            .provider
                                            .handle_push_data(auction_id, payload, progress)
                                            .await;
                                        for out_msg in outbound {
                                            let _ = orchestrator_tx.send(out_msg).await;
                                        }
                                    }
                                    LoxiMessage::UpdateMissionStatus {
                                        mission_id,
                                        status,
                                        details,
                                    } => {
                                        let outbound = self
                                            .provider
                                            .handle_mission_status(mission_id, status, details)
                                            .await;
                                        for out_msg in outbound {
                                            let _ = orchestrator_tx.send(out_msg).await;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                _ => break,
            }
        }
        Ok(())
    }
}
