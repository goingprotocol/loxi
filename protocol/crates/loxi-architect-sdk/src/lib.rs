use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use loxi_core::Message as LoxiMessage;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

pub mod protocol {
    use loxi_core::Message as LoxiMessage;

    /// Generates a RevealRequest message to trigger the direct push from a worker.
    pub fn request_reveal(auction_id: String, worker_id: String) -> LoxiMessage {
        LoxiMessage::RevealRequest { auction_id, worker_id, destination: "direct_push".to_string() }
    }
}

/// Trait that any Architect must implement to host its own data server.
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

    async fn handle_solution_push(&self, auction_id: String, payload: String) -> Vec<LoxiMessage>;
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
    active_rooms: Arc<dashmap::DashMap<String, Vec<mpsc::Sender<WsMessage>>>>,
}

impl<P: DataProvider + 'static> DataServer<P> {
    pub fn new(provider: Arc<P>, domain_id: String) -> Self {
        Self { provider, domain_id, active_rooms: Arc::new(dashmap::DashMap::new()) }
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
                            match serde_json::from_str::<LoxiMessage>(text) {
                                Ok(loxi_msg) => match loxi_msg {
                                    LoxiMessage::PushSolution { auction_id, ticket, payload } => {
                                        let public_key_pem =
                                            std::env::var("RSA_PUBLIC_KEY").unwrap_or_default();
                                        let decoding_key = jsonwebtoken::DecodingKey::from_rsa_pem(
                                            public_key_pem.as_bytes(),
                                        )
                                        .unwrap_or_else(|_| {
                                            jsonwebtoken::DecodingKey::from_secret(b"secret")
                                        });

                                        let mut validation = jsonwebtoken::Validation::new(
                                            jsonwebtoken::Algorithm::RS256,
                                        );
                                        validation.set_audience(&[auction_id.clone()]);

                                        match jsonwebtoken::decode::<serde_json::Value>(
                                            &ticket,
                                            &decoding_key,
                                            &validation,
                                        ) {
                                            Ok(_token_data) => {
                                                println!("💾 [ArchitectSDK] Receiving Pushed Payload for Task {}", auction_id);
                                                let response = self
                                                    .provider
                                                    .handle_solution_push(auction_id, payload)
                                                    .await;
                                                for msg in response {
                                                    // CRITICAL: Relay to Orchestrator, NOT back to the worker!
                                                    let _ = orchestrator_tx.send(msg).await;
                                                }
                                            }
                                            Err(e) => {
                                                println!("⛔ [ArchitectSDK] Access Denied for Task {}: Invalid Ticket. Error: {:?}", auction_id, e);
                                                let _ = tx.send(WsMessage::Text(serde_json::json!({"error": format!("Invalid Ticket: {:?}", e)}).to_string())).await;
                                            }
                                        }
                                    }
                                    LoxiMessage::ClaimTask { auction_id, ticket } => {
                                        let public_key_pem =
                                            std::env::var("RSA_PUBLIC_KEY").unwrap_or_default();
                                        if public_key_pem.is_empty() {
                                            println!("⚠️ [ArchitectSDK] No RSA_PUBLIC_KEY found. Cannot verify tickets.");
                                            let _ = tx
                                                .send(WsMessage::Text(
                                                    serde_json::json!({
                                                        "error": "Architect missing Public Key"
                                                    })
                                                    .to_string(),
                                                ))
                                                .await;
                                            continue;
                                        }

                                        let decoding_key =
                                            match jsonwebtoken::DecodingKey::from_rsa_pem(
                                                public_key_pem.as_bytes(),
                                            ) {
                                                Ok(k) => k,
                                                Err(e) => {
                                                    println!(
                                                        "❌ [ArchitectSDK] Invalid Public Key: {}",
                                                        e
                                                    );
                                                    continue;
                                                }
                                            };

                                        let mut validation = jsonwebtoken::Validation::new(
                                            jsonwebtoken::Algorithm::RS256,
                                        );
                                        validation.set_audience(&[auction_id.clone()]);

                                        match jsonwebtoken::decode::<serde_json::Value>(
                                            &ticket,
                                            &decoding_key,
                                            &validation,
                                        ) {
                                            Ok(_token_data) => {
                                                println!("🔓 [ArchitectSDK] Ticket Validated for Task {}", auction_id);
                                                // Serve Payload
                                                if let Some(payload_str) =
                                                    self.provider.get_payload(&auction_id).await
                                                {
                                                    // Wrap in loxi_types::Problem for agnostic transport
                                                    let agnostic = loxi_types::Problem {
                                                        auction_id: auction_id.clone(),
                                                        domain_id: self.domain_id.clone(),
                                                        payload: Some(payload_str),
                                                    };
                                                    let wrapped_payload =
                                                        serde_json::to_string(&agnostic)?;

                                                    let response = LoxiMessage::PostTask {
                                                        auction_id: auction_id.clone(),
                                                        requirement: loxi_core::TaskRequirement {
                                                            id: auction_id.clone(),
                                                            affinities: vec![],
                                                            min_ram_mb: 0,
                                                            min_cpu_threads: 1, // Default
                                                            use_gpu: false,
                                                            priority_for_owner: None, // Default
                                                            task_type: loxi_core::TaskType::Compute,
                                                            metadata: vec![],
                                                        },
                                                        payload: Some(wrapped_payload),
                                                    };
                                                    let _ = tx
                                                        .send(WsMessage::Text(
                                                            serde_json::to_string(&response)?,
                                                        ))
                                                        .await;
                                                } else {
                                                    let _ = tx.send(WsMessage::Text(serde_json::json!({"error": "Payload not found"}).to_string())).await;
                                                }
                                            }
                                            Err(e) => {
                                                println!("⛔ [ArchitectSDK] Access Denied: Invalid Ticket. {}", e);
                                                let _ = tx.send(WsMessage::Text(serde_json::json!({"error": "Invalid Ticket"}).to_string())).await;
                                            }
                                        }
                                    }
                                    LoxiMessage::DiscoverAuthority { domain_id: auction_id } => {
                                        // Open Discovery (Public Rooms)
                                        self.active_rooms
                                            .entry(auction_id.clone())
                                            .or_default()
                                            .push(tx.clone());

                                        if let Some(payload_str) =
                                            self.provider.get_payload(&auction_id).await
                                        {
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
                                },
                                Err(_) => {}
                            }
                        }
                    }
                }
                Err(_) => {
                    break;
                }
            }
        }
        Ok(())
    }
}
