use futures_util::{SinkExt, StreamExt};
use loxi_core::{
    DomainAuthority, Message as LoxiMessage, NodeSpecs, OrchestratorLogic, TaskRequirement,
    WorkerLease,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

mod auction;
use auction::{AuctionManager, AuctionStatus};

// Global State
type PeerMap = Arc<Mutex<HashMap<String, mpsc::Sender<WsMessage>>>>;
type NodeRegistry = Arc<Mutex<HashMap<String, NodeSpecs>>>;
type AuthorityRegistry = Arc<Mutex<HashMap<String, String>>>;
type SharedAuctionManager = Arc<Mutex<AuctionManager>>;

#[tokio::main]
async fn main() {
    let addr = "0.0.0.0:3005";
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");
    println!("Loxi Grid Orchestrator (Agnostic) listening on: {}", addr);

    let peers: PeerMap = Arc::new(Mutex::new(HashMap::new()));
    let nodes: NodeRegistry = Arc::new(Mutex::new(HashMap::new()));
    let authorities: AuthorityRegistry = Arc::new(Mutex::new(HashMap::new()));
    let auction_manager: SharedAuctionManager = Arc::new(Mutex::new(AuctionManager::new()));

    // --- BACKGROUND MONITOR: Lease Expiry ---
    {
        let manager_monitor = auction_manager.clone();
        let peers_monitor = peers.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

                let expired = {
                    let mut mgr = manager_monitor.lock().await;
                    mgr.check_expired_leases(30000) // 30s Timeout
                };

                if !expired.is_empty() {
                    let peers_map = peers_monitor.lock().await;
                    for (id, req, _posted_by) in expired {
                        println!(
                            "♻️  Lease EXPIRED for Task {}. Revoking and Re-broadcasting...",
                            id
                        );

                        // Re-broadcast Open Auction by simulating a new RequestLease
                        let msg = LoxiMessage::RequestLease {
                            domain_id: "generic_grid".to_string(),
                            requirement: req,
                            count: 1,
                            payload: None, // Payload is fetched from Authority upon winning
                        };

                        if let Ok(payload_str) = serde_json::to_string(&msg) {
                            // Broadcast to ALL peers to find a new worker
                            for (_, tx) in peers_map.iter() {
                                let _ = tx.send(WsMessage::Text(payload_str.clone())).await;
                            }
                        }
                    }
                }
            }
        });
    }

    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(handle_connection(
            stream,
            addr,
            peers.clone(),
            nodes.clone(),
            authorities.clone(),
            auction_manager.clone(),
        ));
    }
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    peers_map: PeerMap,
    nodes_map: NodeRegistry,
    authorities_map: AuthorityRegistry,
    auction_manager: SharedAuctionManager,
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
            println!(
                "🔍 DEBUG: Received message (len={}): {}",
                text.len(),
                if text.len() > 100 { &text[..100] } else { &text }
            );

            if let Ok(loxi_msg) = serde_json::from_str::<LoxiMessage>(&text) {
                match loxi_msg {
                    LoxiMessage::RegisterNode(node_specs) => {
                        let id = node_specs.id.clone();
                        println!(
                            "✅ Node Registered: {} (RAM: {}MB, Capacity Score: {})",
                            id, node_specs.ram_mb, node_specs.verified_capacity
                        );
                        current_node_id = Some(id.clone());

                        nodes_map.lock().await.insert(id.clone(), node_specs);
                        peers_map.lock().await.insert(id.clone(), tx.clone());
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
                    LoxiMessage::PostTask { auction_id, requirement, payload } => {
                        println!(
                            "📢 New Task Posted! Auction: {} (Type: {:?})",
                            auction_id, requirement.task_type
                        );
                        let mut manager = auction_manager.lock().await;

                        let poster_id = if let Some(ref id) = current_authority_id {
                            id.clone()
                        } else if let Some(ref id) = current_node_id {
                            id.clone()
                        } else {
                            "anonymous".to_string()
                        };

                        let broadcast_msg = manager.create_auction(
                            auction_id.clone(),
                            requirement,
                            payload,
                            poster_id,
                        );

                        let peers = peers_map.lock().await;
                        let broadcast_payload = serde_json::to_string(&broadcast_msg).unwrap();
                        for (_id, peer_tx) in peers.iter() {
                            let _ = peer_tx.send(WsMessage::Text(broadcast_payload.clone())).await;
                        }
                        println!(
                            "📡 Broadcasted Auction {} to {} peers. Waiting for bids...",
                            auction_id,
                            peers.len()
                        );
                    }
                    LoxiMessage::SubmitBid(bid) => {
                        println!(
                            "🙋 Bid Received from {} for Auction {}",
                            bid.worker_id, bid.auction_id
                        );
                        let mut manager = auction_manager.lock().await;
                        let auction_id = bid.auction_id.clone();

                        let is_first_bid = if let Some(auction) = manager.get_auction(&auction_id) {
                            auction.bids.is_empty()
                        } else {
                            false
                        };

                        match manager.place_bid(&auction_id, bid) {
                            Ok(_) => {
                                // ADAPTIVE TIMEOUT: First bid triggers a 1.5s settlement window
                                if is_first_bid {
                                    println!("⏰ First bid received! Starting 1.5s settlement window for {}", auction_id);

                                    let auction_id_c = auction_id.clone();
                                    let auction_manager_c = auction_manager.clone();
                                    let peers_map_c = peers_map.clone();
                                    let authorities_map_c = authorities_map.clone();

                                    tokio::spawn(async move {
                                        tokio::time::sleep(tokio::time::Duration::from_millis(
                                            1500,
                                        ))
                                        .await;
                                        println!("🕒 Closing auction {}", auction_id_c);

                                        let mut manager = auction_manager_c.lock().await;
                                        if let Some(assignment) =
                                            manager.close_auction(&auction_id_c)
                                        {
                                            let winner_id = assignment.node_id.clone();
                                            let peers = peers_map_c.lock().await;

                                            if let Some(winner_tx) = peers.get(&winner_id) {
                                                let mut architect_addr =
                                                    "grid://orchestrator".to_string();
                                                if let Some(auction) =
                                                    manager.get_auction(&auction_id_c)
                                                {
                                                    let auths = authorities_map_c.lock().await;
                                                    if let Some(addr) =
                                                        auths.get(&auction.posted_by)
                                                    {
                                                        architect_addr = addr.clone();
                                                    }
                                                }

                                                let lease = WorkerLease {
                                                    auction_id: auction_id_c.clone(),
                                                    worker_id: winner_id.clone(),
                                                    architect_address: architect_addr,
                                                    artifact_hash: assignment.artifact_hash.clone(),
                                                    task_type: assignment.task_type.clone(),
                                                };

                                                println!("🏆 Lease Assigned to: {}", winner_id);
                                                let _ = winner_tx
                                                    .send(WsMessage::Text(
                                                        serde_json::to_string(
                                                            &LoxiMessage::LeaseAssignment(lease),
                                                        )
                                                        .unwrap(),
                                                    ))
                                                    .await;
                                            }

                                            let closed_msg = LoxiMessage::AuctionClosed {
                                                auction_id: auction_id_c.clone(),
                                                winner_id: winner_id.clone(),
                                                winning_hash: "".to_string(),
                                            };
                                            let broadcast_payload =
                                                serde_json::to_string(&closed_msg).unwrap();
                                            for (_id, peer_tx) in peers.iter() {
                                                let _ = peer_tx
                                                    .send(WsMessage::Text(
                                                        broadcast_payload.clone(),
                                                    ))
                                                    .await;
                                            }
                                        }
                                    });
                                }
                            }
                            Err(e) => println!("❌ Invalid Bid: {}", e),
                        }
                    }

                    LoxiMessage::SubmitSolution(solution) => {
                        let auction_id = solution.auction_id.clone();
                        println!(
                            "🏠 Destination reached: Solution received for task {} (Hash: {})",
                            auction_id, solution.result_hash
                        );

                        // --- FIX: Mark Task as Completed to stop Lease Expiry Monitor ---
                        {
                            let mut manager = auction_manager.lock().await;
                            if let Some(auction) = manager.get_auction_mut(&auction_id) {
                                auction.status = AuctionStatus::Completed;
                                println!("✅ Auction {} marked as COMPLETED", auction_id);
                            }
                        }

                        let peers = peers_map.lock().await;
                        if let Some(auction) = auction_manager.lock().await.get_auction(&auction_id)
                        {
                            if let Some(poster_tx) = peers.get(&auction.posted_by) {
                                let relayed_msg = LoxiMessage::SubmitSolution(solution);
                                let _ = poster_tx
                                    .send(WsMessage::Text(
                                        serde_json::to_string(&relayed_msg).unwrap(),
                                    ))
                                    .await;
                                println!(
                                    "📡 Solution relayed to task poster: {}",
                                    auction.posted_by
                                );
                            } else {
                                println!(
                                    "⚠️ Task poster {} disconnected, solution dropped",
                                    auction.posted_by
                                );
                            }
                        } else {
                            println!("⚠️ Unknown auction {}, solution dropped", auction_id);
                        }
                    }
                    LoxiMessage::ConsensusReached { auction_id, winner_id } => {
                        println!(
                            "🤝 Consensus Reached for Auction {}! Winner: {}",
                            auction_id, winner_id
                        );
                        // Relay order to winner to upload payload
                        let peers = peers_map.lock().await;
                        if let Some(winner_tx) = peers.get(&winner_id) {
                            let msg = LoxiMessage::ConsensusReached { auction_id, winner_id };
                            let _ = winner_tx
                                .send(WsMessage::Text(serde_json::to_string(&msg).unwrap()))
                                .await;
                        }
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
        nodes_map.lock().await.remove(&id);
        peers_map.lock().await.remove(&id);
    }
}
