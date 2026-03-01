//! Grid Orchestrator — the central broker for the Loxi compute network.
//!
//! Every node in the Loxi grid connects here. The orchestrator maintains a
//! registry of available workers, runs an auction whenever an Architect
//! requests a lease, and relays solutions back to the right authority once
//! a worker finishes.
//!
//! # Scheduling
//!
//! Tasks are dispatched by [`scheduler::Scheduler`], which uses a binary heap
//! to always pick the highest-scoring available worker. Matching is three-tier:
//! workers that already have the required WASM artifact cached are preferred,
//! followed by workers that meet the hardware minimum, then the general queue.
//!
//! # Fault tolerance
//!
//! A background watchdog runs every 30 seconds. It evicts workers that have
//! been silent for more than 120 seconds and re-queues their tasks. Auctions
//! completed more than an hour ago are also pruned to keep the map bounded.
//! On top of that, if a worker disconnects cleanly, the connection handler
//! immediately re-schedules any task it held.
//!
//! # Security
//!
//! Lease assignments carry a short-lived RS256 JWT signed by [`auth::KeyManager`].
//! The logistics data plane verifies this ticket before sending any payload to a
//! connecting worker, so a worker that didn't win the auction can't claim the data.

use futures_util::{SinkExt, StreamExt};
use loxi_core::{Message as LoxiMessage, NodeSpecs, WorkerLease};
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

pub mod scheduler;
use scheduler::Scheduler;
pub mod auth;
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AuctionCompletionStatus {
    Pending,
    Completed,
}

pub struct AuctionMetadata {
    pub poster_id: String,
    pub consensus_hashes: Vec<String>,
    // [FAULT TOLERANCE] Persist Requirement for Re-Scheduling
    pub original_req: Option<loxi_core::TaskRequirement>,
    pub assigned_worker_id: Option<String>,
    pub created_at: u64,
    pub status: AuctionCompletionStatus,
}

pub async fn run_server(port: u16, node_count: Arc<AtomicUsize>) {
    dotenv().ok(); // Load .env

    let addr = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");
    println!("Loxi Grid Orchestrator (Heap Dispatch V2 + Security) listening on: {}", addr);

    let peers: PeerMap = Arc::new(DashMap::new());
    let authority_peers: PeerMap = Arc::new(DashMap::new());
    let nodes: NodeRegistry = Arc::new(DashMap::new());
    let authorities: AuthorityRegistry = Arc::new(DashMap::new());
    let scheduler: SharedScheduler = Arc::new(Mutex::new(Scheduler::new()));
    let key_manager: SharedKeyManager = Arc::new(KeyManager::new()); // Init Keys
    let active_auctions: ActiveAuctions = Arc::new(DashMap::new());

    // [WATCHDOG] Re-queue tasks whose assigned workers stop responding.
    // Runs every 30s; evicts workers silent for more than 120s.
    {
        const CHECK_INTERVAL_SECS: u64 = 30;
        const TASK_TIMEOUT_SECS: u64 = 120;

        let sched_wdog = scheduler.clone();
        let auctions_wdog = active_auctions.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_secs(CHECK_INTERVAL_SECS));
            loop {
                interval.tick().await;
                let timeout = std::time::Duration::from_secs(TASK_TIMEOUT_SECS);
                let expired = sched_wdog.lock().await.drain_expired(timeout);

                // TTL eviction for stale completed auctions
                const AUCTION_TTL_SECS: u64 = 3600;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                auctions_wdog
                    .retain(|_, meta| now.saturating_sub(meta.created_at) < AUCTION_TTL_SECS);

                for worker_id in expired {
                    eprintln!(
                        "⏰ Watchdog: worker {} silent for >{}s — re-queuing task",
                        worker_id, TASK_TIMEOUT_SECS
                    );

                    // Find the auction this worker was handling
                    let task_info = auctions_wdog
                        .iter()
                        .find(|e| e.value().assigned_worker_id.as_deref() == Some(&worker_id))
                        .map(|e| {
                            (
                                e.key().clone(),
                                e.value().poster_id.clone(),
                                e.value().original_req.clone(),
                            )
                        });

                    if let Some((task_id, poster_id, Some(req))) = task_info {
                        // Clear the stale assignment so the task can be re-scheduled
                        if let Some(mut meta) = auctions_wdog.get_mut(&task_id) {
                            meta.assigned_worker_id = None;
                        }
                        // Re-queue; the next free/connecting worker will pick it up
                        sched_wdog.lock().await.schedule_task(task_id.clone(), req, poster_id);
                        eprintln!("🔄 Watchdog: task {} re-queued", task_id);
                    }
                }
            }
        });
    }

    while let Ok((stream, addr)) = listener.accept().await {
        let ctx = ConnectionCtx {
            peers_map: peers.clone(),
            authority_peers_map: authority_peers.clone(),
            nodes_map: nodes.clone(),
            authorities_map: authorities.clone(),
            scheduler: scheduler.clone(),
            key_manager: key_manager.clone(),
            active_auctions: active_auctions.clone(),
            node_count: node_count.clone(),
        };
        tokio::spawn(handle_connection(stream, addr, ctx));
    }
}

struct ConnectionCtx {
    peers_map: PeerMap,
    authority_peers_map: PeerMap,
    nodes_map: NodeRegistry,
    authorities_map: AuthorityRegistry,
    scheduler: SharedScheduler,
    key_manager: SharedKeyManager,
    active_auctions: ActiveAuctions,
    node_count: Arc<AtomicUsize>,
}

async fn handle_connection(stream: TcpStream, addr: SocketAddr, ctx: ConnectionCtx) {
    let ConnectionCtx {
        peers_map,
        authority_peers_map,
        nodes_map,
        authorities_map,
        scheduler,
        key_manager,
        active_auctions,
        node_count,
    } = ctx;
    println!("Incoming connection from: {}", addr);
    let ws_stream = accept_async(stream).await.expect("Error during the websocket handshake");
    let (mut sink, mut stream) = ws_stream.split();

    let (tx, mut rx) = mpsc::channel::<WsMessage>(1024);

    // 1. WebSocket Writer Loop
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
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
    let mut _current_authority_id: Option<String> = None;

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
                        node_count.fetch_add(1, Ordering::Relaxed);

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
                                    ticket,
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
                        _current_authority_id = Some(id.clone());
                        authorities_map.insert(id.clone(), auth.authority_address);
                        // authorities ARE NOT workers, they live in their own map to avoid broadcast loops
                        authority_peers_map.insert(id, tx.clone());
                    }
                    LoxiMessage::RequestLease { domain_id, requirement, count: _count } => {
                        let auction_id = requirement.id.clone();

                        // [NEW] Automatically register authority peer if not already set,
                        // this ensures we have a connection to relay results to.
                        authority_peers_map.insert(domain_id.clone(), tx.clone());
                        _current_authority_id = Some(domain_id.clone());

                        // HEAP DISPATCH LOGIC
                        println!(
                            "📥 Received Task {} for {}. Attempting Direct Dispatch...",
                            auction_id, domain_id
                        );

                        let poster_id = if let Some(ref id) = _current_authority_id {
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
                                    created_at: std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs(),
                                    status: AuctionCompletionStatus::Pending,
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
                                            ticket,
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
                        let authority_peers_map = authority_peers_map.clone();
                        let nodes_map = nodes_map.clone();
                        let authorities_map = authorities_map.clone();
                        let scheduler = scheduler.clone();
                        let key_manager = key_manager.clone();

                        // NON-BLOCKING EVALUATION
                        tokio::spawn(async move {
                            // 1. CONSENSUS VERIFICATION & OWNER RELAY
                            let mut auth_tx = None;

                            if let Some(mut meta) = active_auctions.get_mut(&solution.auction_id) {
                                if meta.status == AuctionCompletionStatus::Completed {
                                    return; // duplicate — ignore
                                }
                                meta.status = AuctionCompletionStatus::Completed;
                                meta.consensus_hashes.push(solution.result_hash.clone());
                                // Try relaying to the original poster first
                                auth_tx = authority_peers_map
                                    .get(&meta.poster_id)
                                    .map(|p| p.value().clone());
                            }

                            // If not found by poster_id, try by the explicit client_owner_id in the solution
                            if auth_tx.is_none() {
                                if let Some(owner_id) = &solution.client_owner_id {
                                    auth_tx = authority_peers_map
                                        .get(owner_id)
                                        .map(|p| p.value().clone());
                                }
                            }

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
                                            ticket,
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
                    LoxiMessage::NotifyOwner { owner_id, notify_type, payload, metadata } => {
                        println!(
                            "📢 NotifyOwner relay requested for: {} (Type: {})",
                            owner_id, notify_type
                        );
                        let peers_map = peers_map.clone();
                        let nodes_map = nodes_map.clone();
                        let authority_peers_map = authority_peers_map.clone();

                        tokio::spawn(async move {
                            // 1. Check Node/Worker Peers by owner_id
                            let target_peers: Vec<_> = nodes_map
                                .iter()
                                .filter(|r| r.value().owner_id.as_ref() == Some(&owner_id))
                                .filter_map(|r| peers_map.get(r.key()).map(|p| p.value().clone()))
                                .collect();

                            let mut sent_count = 0;
                            let msg_text = serde_json::to_string(&LoxiMessage::NotifyOwner {
                                owner_id: owner_id.clone(),
                                notify_type: notify_type.clone(),
                                payload: payload.clone(),
                                metadata: metadata.clone(),
                            })
                            .unwrap();

                            for tx in target_peers {
                                let _ = tx.send(WsMessage::Text(msg_text.clone())).await;
                                sent_count += 1;
                            }

                            // 2. Also check Authority Peers (if they register with the same ID)
                            if let Some(tx) = authority_peers_map.get(&owner_id) {
                                let _ = tx.value().send(WsMessage::Text(msg_text)).await;
                                sent_count += 1;
                            }

                            println!(
                                "✅ NotifyOwner: Relayed message to {} targets for owner {}",
                                sent_count, owner_id
                            );
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
                    LoxiMessage::Signal { from_id, target_id, payload } => {
                        let peers_map = peers_map.clone();
                        tokio::spawn(async move {
                            if let Some(tx) = peers_map.get(&target_id).map(|p| p.value().clone()) {
                                let _ = tx
                                    .send(WsMessage::Text(
                                        serde_json::to_string(&LoxiMessage::Signal {
                                            from_id,
                                            target_id,
                                            payload,
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
        node_count.fetch_sub(1, Ordering::Relaxed);

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
