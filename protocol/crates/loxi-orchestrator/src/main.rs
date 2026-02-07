use futures_util::{SinkExt, StreamExt};
use loxi_core::{Message as LoxiMessage, NodeSpecs, WorkerLease};
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
use dashmap::DashMap;
use dotenv::dotenv;

// Global State
type PeerMap = Arc<DashMap<String, mpsc::Sender<WsMessage>>>;
type NodeRegistry = Arc<DashMap<String, NodeSpecs>>;
type AuthorityRegistry = Arc<DashMap<String, String>>;
type SharedScheduler = Arc<Mutex<Scheduler>>; // New Brain
type SharedKeyManager = Arc<KeyManager>; // Security
type ActiveAuctions = Arc<DashMap<String, AuctionMetadata>>; // Consensus & Tracking

pub struct AuctionMetadata {
    pub poster_id: String,
    pub consensus_hashes: Vec<String>,
    // [FAULT TOLERANCE] Persist Requirement for Re-Scheduling
    pub original_req: Option<loxi_core::TaskRequirement>,
    pub assigned_worker_id: Option<String>,
}

#[tokio::main]
async fn main() {
    dotenv().ok(); // Load .env

    let addr = "0.0.0.0:3005";
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");
    println!("Loxi Grid Orchestrator (Heap Dispatch V2 + Security) listening on: {}", addr);

    let peers: PeerMap = Arc::new(DashMap::new());
    let nodes: NodeRegistry = Arc::new(DashMap::new());
    let authorities: AuthorityRegistry = Arc::new(DashMap::new());
    let scheduler: SharedScheduler = Arc::new(Mutex::new(Scheduler::new()));
    let key_manager: SharedKeyManager = Arc::new(KeyManager::new()); // Init Keys
    let active_auctions: ActiveAuctions = Arc::new(DashMap::new());

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

    let (tx, mut rx) = mpsc::channel::<WsMessage>(1024);

    // 1. WebSocket Writer Loop
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(_) = sink.send(msg).await {
                break;
            }
        }
    });

    // 2. Heartbeat Task (Keep transitions alive during CPU-heavy tasks)
    let hb_tx = tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(20)).await;
            if hb_tx.send(WsMessage::Ping(Vec::new())).await.is_err() {
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

                        // Register in Maps
                        nodes_map.insert(id.clone(), node_specs.clone());
                        peers_map.insert(id.clone(), tx.clone());

                        // Add to Scheduler & Check for IMMEDIATE Pending Task (Queue Draining)
                        let immediate_assignment = scheduler.lock().await.add_worker(node_specs);

                        if let Some((
                            assignment,
                            task_id,
                            poster_id,
                            next_affinities,
                            next_metadata,
                        )) = immediate_assignment
                        {
                            // [FAULT TOLERANCE] Track who has it
                            if let Some(mut meta) = active_auctions.get_mut(&task_id) {
                                meta.assigned_worker_id = Some(id.clone());
                            }

                            // Resolve Architect Address
                            let mut architect_addr = "grid://orchestrator".to_string();
                            if let Some(addr) = authorities_map.get(&poster_id) {
                                architect_addr = addr.value().clone();
                            }

                            // EXTRACT SENDER TO AVOID HOLDING DASHMAP REF ACROSS AWAIT
                            let worker_tx_opt = peers_map.get(&id).map(|p| p.value().clone());

                            if let Some(worker_tx) = worker_tx_opt {
                                // SIGN TICKET
                                let ticket = key_manager.sign_ticket(&id, &task_id);

                                let lease = WorkerLease {
                                    auction_id: task_id,
                                    worker_id: id.clone(),
                                    architect_address: architect_addr,
                                    task_type: assignment.task_type,
                                    ticket: ticket,
                                    affinities: next_affinities,
                                    metadata: next_metadata,
                                };
                                let _ = worker_tx
                                    .send(WsMessage::Text(
                                        serde_json::to_string(&LoxiMessage::LeaseAssignment(lease))
                                            .unwrap(),
                                    ))
                                    .await;
                            }
                        }
                    }
                    LoxiMessage::RegisterAuthority(auth) => {
                        let id = auth.domain_id.clone();
                        println!(
                            "👑 Authority Registered: Domain={} at {}",
                            id, auth.authority_address
                        );
                        current_authority_id = Some(id.clone());
                        authorities_map.insert(id.clone(), auth.authority_address);
                        peers_map.insert(id, tx.clone());
                    }
                    LoxiMessage::RequestLease { domain_id, requirement, count: _count } => {
                        let auction_id = requirement.id.clone();
                        // HEAP DISPATCH LOGIC
                        println!(
                            "📥 Received Task {} for {}. Attempting Direct Dispatch...",
                            auction_id, domain_id
                        );

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
                            println!(
                                "📢 New Auction: {} (Affinity: {:?})",
                                auction_id, requirement.affinities
                            );

                            // 1. Register Auction with RECOVERY support (Using UNIQUE task id)
                            active_auctions.insert(
                                auction_id.clone(),
                                AuctionMetadata {
                                    poster_id: poster_id.clone(),
                                    consensus_hashes: Vec::new(),
                                    original_req: Some(requirement.clone()), // Save for later
                                    assigned_worker_id: None,
                                },
                            );

                            let active_auctions_ref = active_auctions.clone(); // Clone for closure

                            // 2. Schedule Task
                            tokio::spawn(async move {
                                let assignment_opt = scheduler.lock().await.schedule_task(
                                    auction_id.clone(),
                                    requirement.clone(),
                                    poster_id.clone(),
                                );

                                if let Some(assignment) = assignment_opt {
                                    // [FAULT TOLERANCE] Track who has it
                                    if let Some(mut meta) = active_auctions_ref.get_mut(&auction_id)
                                    {
                                        meta.assigned_worker_id = Some(assignment.node_id.clone());
                                    }

                                    // Send LeaseAssignment to Worker
                                    let worker_tx_opt = peers_map
                                        .get(&assignment.node_id)
                                        .map(|p| p.value().clone());

                                    if let Some(worker_tx) = worker_tx_opt {
                                        let mut architect_addr = "grid://orchestrator".to_string();
                                        if let Some(addr) = authorities_map.get(&poster_id) {
                                            architect_addr = addr.value().clone();
                                        }

                                        let ticket = key_manager
                                            .sign_ticket(&assignment.node_id, &auction_id);

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
                                                serde_json::to_string(
                                                    &LoxiMessage::LeaseAssignment(lease),
                                                )
                                                .unwrap(),
                                            ))
                                            .await;
                                    }
                                }
                            });
                        });
                    }
                    LoxiMessage::SubmitSolution(solution) => {
                        println!("🏁 Received Solution for {}", solution.auction_id);

                        let active_auctions = active_auctions.clone();
                        let peers_map = peers_map.clone();
                        let nodes_map = nodes_map.clone();
                        let authorities_map = authorities_map.clone(); // Needed for looking up architect addr if needed
                        let scheduler = scheduler.clone();
                        let key_manager = key_manager.clone();

                        // NON-BLOCKING EVALUATION
                        tokio::spawn(async move {
                            // 1. CONSENSUS VERIFICATION
                            let auth_tx = if let Some(mut meta) =
                                active_auctions.get_mut(&solution.auction_id)
                            {
                                meta.consensus_hashes.push(solution.result_hash.clone());
                                peers_map.get(&meta.poster_id).map(|p| p.value().clone())
                            } else {
                                None
                            };

                            if let Some(tx) = auth_tx {
                                let _ = tx
                                    .send(WsMessage::Text(
                                        serde_json::to_string(&LoxiMessage::SubmitSolution(
                                            solution.clone(),
                                        ))
                                        .unwrap(),
                                    ))
                                    .await;
                            }

                            let worker_id = solution.worker_id.clone();

                            // 4. WORKER RELEASE & PIPELINING
                            let final_specs = nodes_map.get(&worker_id).map(|n| n.clone());

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
                                        worker_id, next_task_id
                                    );

                                    // TRACK ASSIGNMENT IN STATE
                                    if let Some(mut meta) = active_auctions.get_mut(&next_task_id) {
                                        meta.assigned_worker_id = Some(worker_id.clone());
                                    }

                                    // Send NEXT Lease
                                    let worker_tx_opt =
                                        peers_map.get(&worker_id).map(|p| p.value().clone());

                                    if let Some(worker_tx) = worker_tx_opt {
                                        let mut architect_addr = "grid://orchestrator".to_string();
                                        if let Some(addr) = authorities_map.get(&next_poster_id) {
                                            architect_addr = addr.value().clone();
                                        }

                                        let ticket =
                                            key_manager.sign_ticket(&worker_id, &next_task_id);

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
                    LoxiMessage::RevealRequest { auction_id, worker_id, destination } => {
                        println!(
                            "🔓 Reveal Requested for {} -> Worker {}. Mode: {}",
                            auction_id, worker_id, destination
                        );
                        let peers_map = peers_map.clone();

                        tokio::spawn(async move {
                            let worker_tx_opt =
                                peers_map.get(&worker_id).map(|p| p.value().clone());
                            if let Some(tx) = worker_tx_opt {
                                let _ = tx
                                    .send(WsMessage::Text(
                                        serde_json::to_string(&LoxiMessage::RevealRequest {
                                            auction_id,
                                            worker_id,
                                            destination,
                                        })
                                        .unwrap(),
                                    ))
                                    .await;
                            }
                        });
                    }
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
        nodes_map.remove(&id);
        peers_map.remove(&id);

        // [FAULT TOLERANCE] RECOVERY PROCEDURE
        // 1. Find all auctions assigned to this dead node
        // Collect IDs first
        let abandoned_task_ids: Vec<String> = active_auctions
            .iter()
            .filter(|r| r.value().assigned_worker_id.as_deref() == Some(&id))
            .map(|r| r.key().clone())
            .collect();

        for task_id in abandoned_task_ids {
            if let Some(mut meta) = active_auctions.get_mut(&task_id) {
                if let Some(req) = meta.original_req.clone() {
                    println!(
                        "🚑 RECOVERY: Re-scheduling abandoned Task {} (was on {})",
                        task_id, id
                    );
                    meta.assigned_worker_id = None;
                    let poster_id = meta.poster_id.clone();
                    drop(meta); // Release entry before scheduling

                    scheduler.lock().await.schedule_task(task_id, req, poster_id);
                }
            }
        }
    }
}
