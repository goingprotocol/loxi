pub mod auction;
mod core;
pub mod partitioner;
pub mod types;

use crate::manager::core::CoreLogistics;
use loxi_core::{DomainAuthority, Message as LoxiMessage, TaskRequirement, TaskType};
use serde::{Deserialize, Serialize};
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Serialize, Deserialize)]
pub struct LogisticsJob {
    pub id: String,
    pub problem: types::Problem,
}

pub struct LogisticsManager {
    pub domain_id: String,
    pub orchestrator_url: String,
    pub auction_manager: auction::AuctionManager,
    pub core: CoreLogistics,
    // Task Cache for Direct Data Route
    pub pending_problems: std::collections::HashMap<String, types::Problem>,
    // Active Room Connections: auction_id -> Vec<mpsc::Sender<WsMessage>>
    #[cfg(not(target_arch = "wasm32"))]
    pub active_rooms: std::collections::HashMap<
        String,
        Vec<mpsc::Sender<tokio_tungstenite::tungstenite::Message>>,
    >,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PartitionResult {
    pub sub_problems: Vec<types::Problem>,
    pub unassigned_jobs: Vec<String>,
}

impl LogisticsManager {
    pub fn new(orchestrator_url: &str) -> Self {
        let mut slf = Self {
            domain_id: "logistics".to_string(),
            orchestrator_url: orchestrator_url.to_string(),
            auction_manager: auction::AuctionManager::new(),
            core: CoreLogistics::new(),
            pending_problems: std::collections::HashMap::new(),
            #[cfg(not(target_arch = "wasm32"))]
            active_rooms: std::collections::HashMap::new(),
        };
        slf.load_state();
        slf
    }

    fn get_db_path() -> String {
        ".loxi_data.json".to_string()
    }

    pub fn load_state(&mut self) {
        if let Ok(data) = std::fs::read_to_string(Self::get_db_path()) {
            if let Ok(problems) = serde_json::from_str(&data) {
                self.pending_problems = problems;
                println!(
                    "💾 [Logistics] Loaded {} problems from persistence.",
                    self.pending_problems.len()
                );
            }
        }
    }

    pub fn save_state(&self) {
        if let Ok(data) = serde_json::to_string(&self.pending_problems) {
            if let Err(e) = std::fs::write(Self::get_db_path(), data) {
                println!("❌ Persistence: Failed to save state: {}", e);
            } else {
                // Silent save
            }
        }
    }

    /// Step 1: Register this node as the Architect for the Logistics domain.
    pub fn generate_registration_message(&self, my_address: &str) -> LoxiMessage {
        LoxiMessage::RegisterAuthority(DomainAuthority {
            domain_id: self.domain_id.clone(),
            authority_address: my_address.to_string(),
        })
    }

    /// Step 2: Request specialized workers from the Orchestrator pool.
    pub fn generate_worker_request(
        &self,
        task_id: String,
        task_type: TaskType,
        min_ram: u64,
    ) -> TaskRequirement {
        let artifact_hash = match task_type {
            TaskType::Matrix => "loxi_valhalla_v1",
            TaskType::Solve => "loxi_vrp_artifact_v1",
            TaskType::Partition => {
                if task_id.contains("sector") {
                    "loxi_sector_v1"
                } else {
                    "loxi_partitioner_v1"
                }
            }
        };

        TaskRequirement {
            id: task_id,
            artifact_hash: artifact_hash.to_string(),
            context_hashes: vec!["H3_BUE_7".to_string()],
            task_type: task_type.clone(),
            min_ram_mb: min_ram,
            use_gpu: false, // Mobile-driver/VRP is CPU-based for now
        }
    }

    /// Step 3: Conduct the competitive auction or delegate partitioning.
    pub fn distribute_tasks(&mut self, problem: &types::Problem) -> Vec<LoxiMessage> {
        let mut messages = Vec::new();

        // --- HIERARCHICAL ORCHESTRATION ---

        // 1. MACRO-STAGE: For massive problems (>5000 stops), we perform "Macro-Partitioning"
        // to create Large Blocks (Sectors).
        if problem.stops.len() > 5000 {
            println!(
                "🌐 Industrial Scale Detected: {} stops. Performing Macro-Partitioning...",
                problem.stops.len()
            );

            // Partition at Resolution 7 (Sectors)
            let macro_partitioner = crate::engines::partitioner::Partitioner::with_options(
                h3o::Resolution::Seven,
                1000,
                1000000.0, // Macro level has high capacity
            );

            let sectors = macro_partitioner.partition_problem(problem);
            println!("📦 Created {} Sectors for Titan delegation.", sectors.len());

            for sector in sectors {
                let sub_stops: Vec<types::Stop> = problem
                    .stops
                    .iter()
                    .filter(|s| sector.job_ids.contains(&s.id))
                    .cloned()
                    .collect();

                let sub_problem = types::Problem { stops: sub_stops, ..problem.clone() };

                let sector_id = format!("sector_{}", sector.id);
                // A Sector Task is now a PARTITION task (Compute Matrix -> Partition -> Slice)
                let req =
                    self.generate_worker_request(sector_id.clone(), TaskType::Partition, 8192);

                self.pending_problems.insert(sector_id.clone(), sub_problem);
                messages.push(self.auction_manager.create_auction(sector_id, req, None));
            }

            self.save_state();
            return messages;
        }

        // 2. MICRO-STAGE: For manageable problems (<5000), we partition locally directly into Routes.
        let sub_partitions = self.core.partition(problem);

        for partition in sub_partitions {
            // Reconstruct sub-problem
            let sub_stops: Vec<types::Stop> = problem
                .stops
                .iter()
                .filter(|s| partition.job_ids.contains(&s.id))
                .cloned()
                .collect();

            let sub_problem = types::Problem {
                stops: sub_stops,
                vehicle: problem.vehicle.clone(),
                fleet_size: 1,
                distance_matrix: None,
                time_matrix: None,
                seed: problem.seed,
            };

            // Stage 2 for these partitions: MATRIX calculation
            let sub_id = partition.id.clone();
            let req = self.generate_worker_request(sub_id.clone(), TaskType::Matrix, 4096);

            // SAVE to Stock
            self.pending_problems.insert(sub_id.clone(), sub_problem);

            println!("🚀 [Engine] Created Matrix Task: {}", sub_id);

            // Post Matrix Task (Worker will discover via "La Sala" / Data Server)
            messages.push(self.auction_manager.create_auction(sub_id, req, None));
        }

        self.save_state();
        messages
    }

    /// Step 4: Automate multi-stage pipelines (The "Conductor" Role)
    /// Takes an incoming message and returns a list of follow-up messages.
    pub fn handle_incoming_message(&mut self, msg: LoxiMessage) -> Vec<LoxiMessage> {
        match msg {
            LoxiMessage::PostTask { auction_id, payload, .. }
            | LoxiMessage::RequestLease {
                requirement: TaskRequirement { id: auction_id, .. },
                payload,
                ..
            } => {
                // ADOPTION LOGIC
                if let Some(payload_str) = payload {
                    if let Ok(problem) = serde_json::from_str::<types::Problem>(&payload_str) {
                        println!("📥 Conductor: Adopted problem for auction {}", auction_id);
                        self.pending_problems.insert(auction_id, problem);
                    } else if let Ok(agnostic) =
                        serde_json::from_str::<loxi_types::Problem>(&payload_str)
                    {
                        if let Some(inner_payload) = agnostic.payload {
                            if let Ok(problem) =
                                serde_json::from_str::<types::Problem>(&inner_payload)
                            {
                                println!(
                                    "📥 Conductor: Adopted agnostic problem for auction {}",
                                    auction_id
                                );
                                self.pending_problems.insert(auction_id, problem);
                            }
                        }
                    }
                }
                self.save_state();
                Vec::new()
            }
            LoxiMessage::SubmitSolution(solution) => {
                let auction_id = solution.auction_id.clone();
                println!("✅ Manager: Received Solution for Auction: {}", auction_id);

                // --- STAGE 1: PARTITION COMPLETE (Macro or Sector) ---
                if auction_id.contains("partition") || auction_id.contains("sector") {
                    println!("🧬 Manager: Partition Stage Complete for {}.", auction_id);
                    let mut outbound = Vec::new();

                    #[cfg(not(target_arch = "wasm32"))]
                    if let Some(ref payload) = solution.payload {
                        if let Ok(result) = serde_json::from_str::<PartitionResult>(payload) {
                            for (i, sub_problem) in result.sub_problems.into_iter().enumerate() {
                                let sub_id = format!("{}_s{}", auction_id, i);

                                let task_type = if sub_problem.distance_matrix.is_some() {
                                    TaskType::Solve
                                } else if sub_problem.stops.len() > 100 {
                                    TaskType::Partition
                                } else {
                                    TaskType::Matrix
                                };

                                let req =
                                    self.generate_worker_request(sub_id.clone(), task_type, 4096);
                                self.pending_problems.insert(sub_id.clone(), sub_problem);
                                outbound
                                    .push(self.auction_manager.create_auction(sub_id, req, None));
                            }

                            // SELF-HEALING: Handle unassigned jobs from partitioning
                            if !result.unassigned_jobs.is_empty() {
                                println!(
                                    "⚠️ Manager: {} ORPHAN JOBS after partitioning {}. Healing...",
                                    result.unassigned_jobs.len(),
                                    auction_id
                                );

                                if let Some(problem) = self.pending_problems.get(&auction_id) {
                                    let orphan_stops: Vec<_> = problem
                                        .stops
                                        .iter()
                                        .filter(|s| result.unassigned_jobs.contains(&s.id))
                                        .cloned()
                                        .collect();

                                    if !orphan_stops.is_empty() {
                                        let healing_id = format!("{}_p_healing", auction_id);
                                        let mut healing_problem = problem.clone();
                                        healing_problem.stops = orphan_stops;
                                        healing_problem.distance_matrix = None;
                                        healing_problem.time_matrix = None;

                                        let req = self.generate_worker_request(
                                            healing_id.clone(),
                                            TaskType::Partition,
                                            2048,
                                        );

                                        self.pending_problems
                                            .insert(healing_id.clone(), healing_problem.clone());

                                        let domain_payload =
                                            serde_json::to_string(&healing_problem).unwrap();
                                        let agnostic_problem = loxi_types::Problem {
                                            auction_id: healing_id.clone(),
                                            domain_id: self.domain_id.clone(),
                                            payload: Some(domain_payload),
                                        };

                                        outbound.push(LoxiMessage::PostTask {
                                            auction_id: healing_id,
                                            requirement: req,
                                            payload: Some(
                                                serde_json::to_string(&agnostic_problem).unwrap(),
                                            ),
                                        });
                                    }
                                }
                            }

                            self.save_state();
                        }
                    }
                    return outbound;
                }
                // --- STAGE 2: MATRIX COMPLETE (Route Level) ---
                else if auction_id.contains("_p") && !auction_id.contains("solve") {
                    if let Some(mut master_problem) =
                        self.pending_problems.get(&auction_id).cloned()
                    {
                        println!("📊 Manager: Matrix Stage Complete for {}.", auction_id);

                        if let Some(ref payload) = solution.payload {
                            if let Ok(matrix) = serde_json::from_str::<Vec<Vec<f64>>>(payload) {
                                master_problem.distance_matrix = Some(matrix);
                            } else if let Ok(valhalla) = serde_json::from_str::<
                                crate::engines::matrix::ValhallaSolution,
                            >(payload)
                            {
                                let matrix: Vec<Vec<f64>> = valhalla
                                    .sources_to_targets
                                    .iter()
                                    .map(|row| row.iter().map(|cost| cost.distance).collect())
                                    .collect();
                                master_problem.distance_matrix = Some(matrix);

                                let time_matrix: Vec<Vec<u32>> = valhalla
                                    .sources_to_targets
                                    .iter()
                                    .map(|row| row.iter().map(|cost| cost.time as u32).collect())
                                    .collect();
                                master_problem.time_matrix = Some(time_matrix);
                            }
                        }

                        // Final VRP Solve for this specific route
                        let solve_task_id = format!("{}_solve", auction_id);
                        let solve_req = self.generate_worker_request(
                            solve_task_id.clone(),
                            TaskType::Solve,
                            1024,
                        );
                        self.pending_problems.insert(solve_task_id.clone(), master_problem.clone());

                        let domain_payload = serde_json::to_string(&master_problem).unwrap();
                        let agnostic_problem = loxi_types::Problem {
                            auction_id: solve_task_id.clone(),
                            domain_id: self.domain_id.clone(),
                            payload: Some(domain_payload),
                        };

                        self.save_state();
                        return vec![LoxiMessage::PostTask {
                            auction_id: solve_task_id,
                            requirement: solve_req,
                            payload: Some(serde_json::to_string(&agnostic_problem).unwrap()),
                        }];
                    }
                }
                // --- STAGE 3: SOLVE COMPLETE ---
                else if auction_id.contains("solve")
                    || auction_id.contains("_r")
                    || auction_id.contains("_s_solve")
                {
                    println!(
                        "🏁 Manager: Final Solver Solution received for {} (Cost: {})",
                        auction_id, solution.cost
                    );

                    if !solution.unassigned_jobs.is_empty() {
                        println!(
                            "⚠️ Manager: {} UNASSIGNED JOBS in {}. Triggering healing auction...",
                            solution.unassigned_jobs.len(),
                            auction_id
                        );

                        if let Some(problem) = self.pending_problems.get(&auction_id) {
                            let unassigned_stops: Vec<_> = problem
                                .stops
                                .iter()
                                .filter(|s| solution.unassigned_jobs.contains(&s.id))
                                .cloned()
                                .collect();

                            if !unassigned_stops.is_empty() {
                                let healing_id = format!("{}_healing", auction_id);
                                let mut healing_problem = problem.clone();
                                healing_problem.stops = unassigned_stops;
                                healing_problem.distance_matrix = None;
                                healing_problem.time_matrix = None;

                                let req = self.generate_worker_request(
                                    healing_id.clone(),
                                    TaskType::Solve,
                                    1024,
                                );

                                self.pending_problems
                                    .insert(healing_id.clone(), healing_problem.clone());

                                let domain_payload =
                                    serde_json::to_string(&healing_problem).unwrap();
                                let agnostic_problem = loxi_types::Problem {
                                    auction_id: healing_id.clone(),
                                    domain_id: self.domain_id.clone(),
                                    payload: Some(domain_payload),
                                };

                                self.save_state();
                                return vec![LoxiMessage::PostTask {
                                    auction_id: healing_id,
                                    requirement: req,
                                    payload: Some(
                                        serde_json::to_string(&agnostic_problem).unwrap(),
                                    ),
                                }];
                            }
                        }
                    }

                    return Vec::new();
                }

                Vec::new()
            }
            LoxiMessage::AuctionClosed { auction_id, winner_id, .. } => {
                println!("🔨 Manager: Auction {} CLOSED. Winner: {}", auction_id, winner_id);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// Step 5: Start a Direct Data Server (The "Sala" / Private Room)
    /// This allows workers to connect directly to the Architect for data exchange.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn start_data_server(
        self_arc: Arc<Mutex<Self>>,
        port: u16,
        orchestrator_tx: mpsc::Sender<LoxiMessage>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let addr = format!("0.0.0.0:{}", port);
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        println!("🔒 Direct Data Server (The Sala) listening on: {}", addr);

        while let Ok((stream, addr)) = listener.accept().await {
            println!("🔌 Data Server: Incoming connection from {}", addr);
            let manager = self_arc.clone();
            let tx = orchestrator_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = Self::handle_worker_direct(stream, manager, tx).await {
                    println!("❌ Error handling direct worker {}: {}", addr, e);
                }
            });
        }
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn handle_worker_direct(
        stream: tokio::net::TcpStream,
        manager: Arc<Mutex<Self>>,
        orchestrator_tx: mpsc::Sender<LoxiMessage>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;

        let ws_stream = accept_async(stream).await?;
        let (mut sink, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::channel::<tokio_tungstenite::tungstenite::Message>(32);

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        println!("⏳ Data Server: Waiting for message from worker...");
        while let Some(msg_result) = read.next().await {
            match msg_result {
                Ok(msg) => {
                    if msg.is_text() {
                        if let Ok(text) = msg.to_text() {
                            if let Ok(loxi_msg) = serde_json::from_str::<LoxiMessage>(text) {
                                match loxi_msg {
                                    LoxiMessage::DiscoverAuthority { domain_id: auction_id } => {
                                        let mut mg = manager.lock().await;

                                        // DEBUG: Log the request and available keys
                                        println!(
                                            "🔍 Data Server: Worker requested payload for ID: {}",
                                            auction_id
                                        );
                                        if !mg.pending_problems.contains_key(&auction_id) {
                                            println!("⚠️ Data Server: ID {} NOT FOUND. Cache has {} items. Keys: {:?}", 
                                                auction_id, mg.pending_problems.len(), mg.pending_problems.keys().take(10).collect::<Vec<_>>());
                                        }

                                        mg.active_rooms
                                            .entry(auction_id.clone())
                                            .or_default()
                                            .push(tx.clone());

                                        if let Some(problem) = mg.pending_problems.get(&auction_id)
                                        {
                                            println!(
                                                "📤 Data Server: Sending payload for ID: {}",
                                                auction_id
                                            );
                                            let domain_payload = serde_json::to_string(problem)?;
                                            let agnostic = loxi_types::Problem {
                                                auction_id: auction_id.clone(),
                                                domain_id: "logistics".to_string(),
                                                payload: Some(domain_payload),
                                            };
                                            let _ = tx
                                                .send(
                                                    tokio_tungstenite::tungstenite::Message::Text(
                                                        serde_json::to_string(&agnostic)?,
                                                    ),
                                                )
                                                .await;
                                        } else {
                                            // FAST FAIL: Tell the worker the data is missing
                                            let error_msg = serde_json::json!({
                                                "error": format!("Payload for ID {} not found in Architect memory", auction_id),
                                                "auction_id": auction_id
                                            });
                                            let _ = tx
                                                .send(
                                                    tokio_tungstenite::tungstenite::Message::Text(
                                                        error_msg.to_string(),
                                                    ),
                                                )
                                                .await;
                                        }
                                    }
                                    LoxiMessage::SubmitSolution(solution) => {
                                        let auction_id = solution.auction_id.clone();
                                        println!("📥 Received Solution in Room: {}", auction_id);

                                        let outbound_msgs = {
                                            let mut mg = manager.lock().await;
                                            mg.handle_incoming_message(LoxiMessage::SubmitSolution(
                                                solution,
                                            ))
                                        };

                                        if !outbound_msgs.is_empty() {
                                            for out_msg in outbound_msgs {
                                                let _ = orchestrator_tx.send(out_msg).await;
                                            }
                                            println!("⚡ Room Submission: {} -> Next tasks published to Grid.", auction_id);
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
