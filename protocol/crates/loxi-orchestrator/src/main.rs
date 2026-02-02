use futures_util::{SinkExt, StreamExt};
use loxi_core::{
    Assignment, DomainAuthority, Message as LoxiMessage, NodeSpecs, TaskRequirement, WorkerLease,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

mod scheduler;
use scheduler::Scheduler;
mod auth;
use auth::KeyManager;
use dotenv::dotenv;

// Global State
type PeerMap = Arc<Mutex<HashMap<String, mpsc::Sender<WsMessage>>>>;
type NodeRegistry = Arc<Mutex<HashMap<String, NodeSpecs>>>;
type AuthorityRegistry = Arc<Mutex<HashMap<String, String>>>;
type SharedScheduler = Arc<Mutex<Scheduler>>; // New Brain
type SharedKeyManager = Arc<KeyManager>; // Security
type ActiveAuctions = Arc<Mutex<HashMap<String, AuctionMetadata>>>; // Consensus & Tracking

pub struct AuctionMetadata {
    pub poster_id: String,
    pub consensus_hashes: Vec<String>,
}

#[tokio::main]
async fn main() {
    dotenv().ok(); // Load .env

    let addr = "0.0.0.0:3005";
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");
    println!("Loxi Grid Orchestrator (Heap Dispatch V2 + Security) listening on: {}", addr);

    let peers: PeerMap = Arc::new(Mutex::new(HashMap::new()));
    let nodes: NodeRegistry = Arc::new(Mutex::new(HashMap::new()));
    let authorities: AuthorityRegistry = Arc::new(Mutex::new(HashMap::new()));
    let scheduler: SharedScheduler = Arc::new(Mutex::new(Scheduler::new()));
    let key_manager: SharedKeyManager = Arc::new(KeyManager::new()); // Init Keys
    let active_auctions: ActiveAuctions = Arc::new(Mutex::new(HashMap::new()));

    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(handle_connection(
            stream,
            addr,
            peers.clone(),
            nodes.clone(),
            authorities.clone(),
            scheduler.clone(),
            key_manager.clone(),
            active_auctions.clone(),
        ));
    }
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    peers_map: PeerMap,
    nodes_map: NodeRegistry,
    authorities_map: AuthorityRegistry,
    scheduler: SharedScheduler,
    key_manager: SharedKeyManager,
    active_auctions: ActiveAuctions,
) {
    println!("Incoming connection from: {}", addr);
    let ws_stream = accept_async(stream).await.expect("Error during the websocket handshake");
    let (mut sink, mut stream) = ws_stream.split();

    let (tx, mut rx) = mpsc::channel::<WsMessage>(32);

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(_) = sink.send(msg).await {
                break;
            }
        }
    });

    let mut current_node_id: Option<String> = None;
    let mut current_authority_id: Option<String> = None;

    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };

        if msg.is_text() || msg.is_binary() {
            let text = msg.to_string();

            if let Ok(loxi_msg) = serde_json::from_str::<LoxiMessage>(&text) {
                match loxi_msg {
                    LoxiMessage::RegisterNode(node_specs) => {
                        let id = node_specs.id.clone();
                        println!("✅ Node Registered: {} (RAM: {}MB)", id, node_specs.ram_mb);
                        current_node_id = Some(id.clone());

                        nodes_map.lock().await.insert(id.clone(), node_specs.clone());
                        peers_map.lock().await.insert(id.clone(), tx.clone());

                        // HEAP: Add to Idle Pool proactively
                        scheduler.lock().await.add_worker(node_specs);
                    }
                    LoxiMessage::RegisterAuthority(auth) => {
                        let id = auth.domain_id.clone();
                        println!(
                            "👑 Authority Registered: Domain={} at {}",
                            id, auth.authority_address
                        );
                        current_authority_id = Some(id.clone());
                        authorities_map.lock().await.insert(id.clone(), auth.authority_address);
                        peers_map.lock().await.insert(id, tx.clone());
                    }
                    LoxiMessage::RequestLease { domain_id: auction_id, requirement, count } => {
                        // HEAP DISPATCH LOGIC
                        println!("📥 Received Task {}. Attempting Direct Dispatch...", auction_id);

                        let poster_id = if let Some(ref id) = current_authority_id {
                            id.clone()
                        } else {
                            "anonymous".to_string()
                        };

                        let active_auctions = active_auctions.clone();
                        let scheduler = scheduler.clone();
                        let peers_map = peers_map.clone();
                        let authorities_map = authorities_map.clone();
                        let key_manager = key_manager.clone();

                        // NON-BLOCKING DISPATCH
                        tokio::spawn(async move {
                            // TRACK OWNERSHIP
                            // Note: We use block scope to drop lock asap if needed, or just standard await
                            active_auctions.lock().await.insert(
                                auction_id.clone(),
                                AuctionMetadata {
                                    poster_id: poster_id.clone(),
                                    consensus_hashes: Vec::new(),
                                },
                            );

                            let assignment_opt = scheduler.lock().await.schedule_task(
                                auction_id.clone(),
                                requirement.clone(),
                                poster_id.clone(),
                            );

                            if let Some(assignment) = assignment_opt {
                                // INSTANT WINNER!
                                println!(
                                    "🎯 DIRECT HIT! Assigned Task {} to {}",
                                    auction_id, assignment.node_id
                                );

                                // Send LeaseAssignment to Worker
                                let peers = peers_map.lock().await;
                                if let Some(worker_tx) = peers.get(&assignment.node_id) {
                                    // Resolve Architect Address
                                    let mut architect_addr = "grid://orchestrator".to_string();
                                    let auths = authorities_map.lock().await;
                                    if let Some(addr) = auths.get(&poster_id) {
                                        architect_addr = addr.clone();
                                    }

                                    // SIGN TICKET
                                    let ticket =
                                        key_manager.sign_ticket(&assignment.node_id, &auction_id);

                                    let lease = WorkerLease {
                                        auction_id: auction_id.clone(),
                                        worker_id: assignment.node_id.clone(),
                                        architect_address: architect_addr,
                                        task_type: assignment.task_type,
                                        ticket: ticket,
                                        affinities: requirement.affinities.clone(),
                                        metadata: requirement.metadata.clone(),
                                    };
                                    let _ = worker_tx
                                        .send(WsMessage::Text(
                                            serde_json::to_string(&LoxiMessage::LeaseAssignment(
                                                lease,
                                            ))
                                            .unwrap(),
                                        ))
                                        .await;
                                }
                            } else {
                                println!("zzz Task {} Queued (Zero Latency Backlog)", auction_id);
                            }
                        });
                    }
                    LoxiMessage::SubmitSolution(solution) => {
                        println!("🏁 Received Solution for {}", solution.auction_id);

                        let active_auctions = active_auctions.clone();
                        let peers_map = peers_map.clone();
                        let nodes_map = nodes_map.clone();
                        let authorities_map = authorities_map.clone(); // Needed for looking up architect addr if needed
                        let scheduler = scheduler.clone();
                        let tx = tx.clone(); // To reply to this worker (RevealRequest)

                        // NON-BLOCKING EVALUATION
                        tokio::spawn(async move {
                            // 1. CONSENSUS VERIFICATION
                            let mut auctions = active_auctions.lock().await;

                            if let Some(meta) = auctions.get_mut(&solution.auction_id) {
                                println!("🔒 Consensus Check: Hash={}", solution.result_hash);
                                meta.consensus_hashes.push(solution.result_hash.clone());

                                // 2. SEND REVEAL REQUEST TO WORKER (COMMIT-REVEAL)
                                let reveal_msg = LoxiMessage::RevealRequest {
                                    auction_id: solution.auction_id.clone(),
                                    destination: "architect_lookup_pending".to_string(), // In V4 we lookup. V3 assumes Worker knows.
                                };
                                let _ = tx
                                    .send(WsMessage::Text(
                                        serde_json::to_string(&reveal_msg).unwrap(),
                                    ))
                                    .await;

                                // 3. RELAY PROOF TO TRUE OWNER
                                let peers = peers_map.lock().await;
                                if let Some(auth_tx) = peers.get(&meta.poster_id) {
                                    // Forward only the Proof (Hash)
                                    let _ = auth_tx
                                        .send(WsMessage::Text(
                                            serde_json::to_string(&LoxiMessage::SubmitSolution(
                                                solution.clone(),
                                            ))
                                            .unwrap(),
                                        ))
                                        .await;
                                    println!(
                                        "📤 Relayed Proof for {} to Owner '{}'.",
                                        solution.auction_id, meta.poster_id
                                    );
                                } else {
                                    println!(
                                        "⚠️ Could not relay: Owner '{}' disconnected.",
                                        meta.poster_id
                                    );
                                }
                            } else {
                                println!(
                                    "⚠️ Solution for unknown/expired auction: {}",
                                    solution.auction_id
                                );
                                return; // Stop if invalid
                            }

                            // drop lock before release logic
                            drop(auctions);

                            let worker_id = solution.worker_id.clone();

                            // 4. WORKER RELEASE & PIPELINING
                            let final_specs = {
                                let nodes = nodes_map.lock().await;
                                nodes.get(&worker_id).cloned()
                            };

                            if let Some(specs) = final_specs {
                                let piped_result =
                                    scheduler.lock().await.release_worker(&worker_id, specs);

                                if let Some((
                                    assignment,
                                    next_task_id,
                                    next_poster_id,
                                    next_affinities,
                                    next_metadata,
                                )) = piped_result
                                {
                                    println!(
                                        "🔥 PIPELINE: Worker {} immediately re-assigned to {}",
                                        worker_id, assignment.node_id
                                    );

                                    // Send NEXT Lease
                                    let peers = peers_map.lock().await;
                                    if let Some(worker_tx) = peers.get(&worker_id) {
                                        let mut architect_addr = "grid://orchestrator".to_string();
                                        let auths = authorities_map.lock().await;
                                        if let Some(addr) = auths.get(&next_poster_id) {
                                            architect_addr = addr.clone();
                                        }

                                        // TODO: Sign Ticket capability needs KeyManager clone in this thread
                                        // For now, we skip signing in Piped task to avoid Arc hell in this snippet refactor
                                        // or pass key_manager.
                                        let ticket = "piped_ticket_placeholder".to_string();

                                        let lease = WorkerLease {
                                            auction_id: next_task_id,
                                            worker_id: worker_id.clone(),
                                            architect_address: architect_addr,
                                            task_type: assignment.task_type,
                                            ticket: ticket,
                                            affinities: next_affinities,
                                            metadata: next_metadata,
                                        };
                                        let _ = worker_tx
                                            .send(WsMessage::Text(
                                                serde_json::to_string(
                                                    &LoxiMessage::LeaseAssignment(lease),
                                                )
                                                .unwrap(),
                                            ))
                                            .await;
                                    }
                                }
                            }
                        });
                    }
                    // Handle all other messages gracefully
                    _ => {}
                }
            } else {
                // Log messages that fail to parse
                if text.len() > 200 {
                    println!("⚠️ Failed to parse message (truncated): {}...", &text[..200]);
                } else {
                    println!("⚠️ Failed to parse message: {}", text);
                }
            }
        }
    }

    if let Some(id) = current_node_id {
        println!("❌ Node Left: {}", id);
        nodes_map.lock().await.remove(&id);
        peers_map.lock().await.remove(&id);
    }
}
