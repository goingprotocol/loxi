pub mod auction;
mod core;
pub mod partitioner;
pub mod storage;
// pub mod types; // Moved to crate root
use crate::types;
use crate::types::TaskRole;

use crate::architect::core::CoreLogistics;
#[allow(unused_imports)]
use async_trait::async_trait;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use loxi_architect_sdk::DataProvider;
use loxi_core::{DomainAuthority, Message as LoxiMessage, TaskRequirement, TaskType};
use serde::{Deserialize, Serialize};
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use std::sync::Arc;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use std::sync::Mutex;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use uuid;

/// Parameters for `LogisticsArchitect::generate_worker_request`.
/// Avoids a function signature exceeding the clippy argument limit.
pub struct WorkerRequestParams {
    pub task_id: String,
    pub artifact_hash: String,
    pub task_type: TaskType,
    pub mission_id: Option<String>,
    pub context_hashes: Vec<String>,
    pub workflow_id: Option<String>,
    pub state: String,
    pub min_ram: u64,
    pub min_cpu: Option<u32>,
    pub priority_owner: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogisticsJob {
    pub id: String,
    pub problem: types::Problem,
}

pub struct LogisticsArchitect {
    pub domain_id: String,
    pub orchestrator_url: String,
    pub auction_manager: auction::ArchitectAuction,
    pub core: CoreLogistics,
    // Task Cache for Direct Data Route (SHARED)
    pub pending_problems: Arc<dashmap::DashMap<String, types::Problem>>,
    pub pending_payloads: dashmap::DashMap<String, String>, // AuctionID -> Payload
    pub pending_confirmations: dashmap::DashMap<String, loxi_core::Solution>, // AuctionID -> Control Msg
    pub pending_bids: dashmap::DashMap<String, Vec<loxi_core::Solution>>, // AuctionID -> List of Candidates
    pub expected_results: dashmap::DashMap<String, usize>, // AuctionID -> Total Workers Assigned
    pub mission_roots: dashmap::DashMap<String, String>,   // MissionID -> RootProblemID
    pub verify_fn: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PartitionResult {
    pub sectors: Vec<crate::engines::partitioner::Partition>,
    pub unassigned: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct LogisticsState {
    problems: std::collections::HashMap<String, types::Problem>,
    payloads: std::collections::HashMap<String, String>,
    confirmations: std::collections::HashMap<String, loxi_core::Solution>,
    bids: std::collections::HashMap<String, Vec<loxi_core::Solution>>,
    results: std::collections::HashMap<String, usize>,
    auctions: std::collections::HashMap<String, auction::Auction>,
    mission_roots: std::collections::HashMap<String, String>,
}

impl LogisticsArchitect {
    pub fn new(
        orchestrator_url: &str,
        domain_id: &str,
        shared_cache: Arc<dashmap::DashMap<String, types::Problem>>,
        verify_fn: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Self {
        Self {
            domain_id: domain_id.to_string(),
            orchestrator_url: orchestrator_url.to_string(),
            auction_manager: auction::ArchitectAuction::new(),
            core: CoreLogistics::new(),
            pending_problems: shared_cache,
            pending_payloads: dashmap::DashMap::new(),
            pending_confirmations: dashmap::DashMap::new(),
            pending_bids: dashmap::DashMap::new(),
            expected_results: dashmap::DashMap::new(),
            mission_roots: dashmap::DashMap::new(),
            verify_fn,
        }
    }

    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    pub async fn run_architect(
        orchestrator_url: &str,
        authority_ws_url: &str,
        domain_id: &str,
        mut job_rx: tokio::sync::mpsc::UnboundedReceiver<LogisticsJob>,
        mut protocol_rx: tokio::sync::mpsc::UnboundedReceiver<loxi_core::Message>,
        shared_cache: Arc<dashmap::DashMap<String, types::Problem>>,
        verify_fn: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    ) {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;
        use url::Url;

        println!("🚚 Logistics Architect: Connecting to Orchestrator at {}...", orchestrator_url);

        let url = Url::parse(orchestrator_url).expect("Invalid Orchestrator URL");
        let (ws_stream, _) = connect_async(url).await.expect("Failed to connect");
        println!("✅ Connected to Orchestrator!");

        let (mut write, mut read) = ws_stream.split();
        // LogisticsArchitect itself is protected by a Mutex (async one for the loop)
        // We use std::sync::Mutex to match the shared cache type, even though we are in async context.
        // This blocks the thread briefly, which is acceptable for this logic.
        let manager = Arc::new(std::sync::Mutex::new(Self::new(
            orchestrator_url,
            domain_id,
            shared_cache,
            verify_fn,
        )));

        // 1. REGISTER
        let reg_msg = {
            let m = manager.lock().unwrap();
            m.generate_registration_message(authority_ws_url)
        };
        write
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::to_string(&reg_msg).unwrap(),
            ))
            .await
            .expect("Failed to register");

        // 2. EVENT LOOP (Unified Select)
        loop {
            tokio::select! {
                // A. WebSocket Messages (Control Plane)
                Some(msg) = read.next() => {
                    match msg {
                        Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                            if let Ok(loxi_msg) = serde_json::from_str::<LoxiMessage>(&text) {
                                let responses = {
                                    let mut m = manager.lock().unwrap();
                                    m.handle_incoming_message(loxi_msg)
                                };

                                for resp in responses {
                                    let json = serde_json::to_string(&resp).unwrap();
                                    write
                                        .send(tokio_tungstenite::tungstenite::Message::Text(json))
                                        .await
                                        .expect("Failed to send response");
                                }
                            }
                        }
                        Ok(tokio_tungstenite::tungstenite::Message::Ping(data)) => {
                            write
                                .send(tokio_tungstenite::tungstenite::Message::Pong(data))
                                .await
                                .expect("Failed to pong");
                        }
                        _ => {}
                    }
                }

                // B. Internal Job Channel (Data Plane / API)
                Some(job) = job_rx.recv() => {
                    println!("🚚 Architect: Received Internal Job ID: {}", job.id);
                    let responses = {
                        let mut m = manager.lock().unwrap();
                        // Directly inject as if it was a distribution request
                        let (msgs, _) = m.distribute_tasks(job.id, &job.problem);
                        msgs
                    };

                    // Feed all auction requests into the sink buffer first, then
                    // flush once — this fires all partition auctions as a batch
                    // rather than waiting for each send to complete sequentially.
                    for resp in &responses {
                        let json = serde_json::to_string(resp).unwrap();
                        write
                            .feed(tokio_tungstenite::tungstenite::Message::Text(json))
                            .await
                            .expect("Failed to feed Auction Request");
                    }
                    write.flush().await.expect("Failed to flush Auction Requests");
                }

                // C. Direct Protocol Messages (from Data Plane)
                Some(p_msg) = protocol_rx.recv() => {
                    println!("🚚 Architect: Received Direct Protocol Message");
                    let responses = {
                        let mut m = manager.lock().unwrap();
                        m.handle_incoming_message(p_msg)
                    };

                    for resp in responses {
                        let json = serde_json::to_string(&resp).unwrap();
                        write
                            .send(tokio_tungstenite::tungstenite::Message::Text(json))
                            .await
                            .expect("Failed to send response");
                    }
                }

                else => break, // All channels closed
            }
        }
        println!("❌ Logistics Architect: Disconnected.");
    }

    fn get_db_path() -> String {
        ".loxi_data.json".to_string()
    }

    pub fn load_state(&mut self) {
        if let Ok(data) = std::fs::read_to_string(Self::get_db_path()) {
            if let Ok(state) = serde_json::from_str::<LogisticsState>(&data) {
                // Clear and repopulate all DashMaps
                self.pending_problems.clear();
                for (k, v) in state.problems {
                    self.pending_problems.insert(k, v);
                }

                self.pending_payloads.clear();
                for (k, v) in state.payloads {
                    self.pending_payloads.insert(k, v);
                }

                self.pending_confirmations.clear();
                for (k, v) in state.confirmations {
                    self.pending_confirmations.insert(k, v);
                }

                self.pending_bids.clear();
                for (k, v) in state.bids {
                    self.pending_bids.insert(k, v);
                }

                self.expected_results.clear();
                for (k, v) in state.results {
                    self.expected_results.insert(k, v);
                }

                self.auction_manager.auctions.clear();
                for (k, v) in state.auctions {
                    self.auction_manager.auctions.insert(k, v);
                }

                self.mission_roots.clear();
                for (k, v) in &state.mission_roots {
                    self.mission_roots.insert(k.clone(), v.clone());
                }

                println!(
                    "💾 [Logistics] Loaded {} problems and {} auctions from persistence.",
                    self.pending_problems.len(),
                    self.auction_manager.auctions.len()
                );
            }
        }
    }

    pub fn snapshot(&self) -> LogisticsState {
        let mut problems = std::collections::HashMap::new();
        for entry in self.pending_problems.iter() {
            problems.insert(entry.key().clone(), entry.value().clone());
        }

        let mut payloads = std::collections::HashMap::new();
        for entry in self.pending_payloads.iter() {
            payloads.insert(entry.key().clone(), entry.value().clone());
        }

        let mut confirmations = std::collections::HashMap::new();
        for entry in self.pending_confirmations.iter() {
            confirmations.insert(entry.key().clone(), entry.value().clone());
        }

        let mut bids = std::collections::HashMap::new();
        for entry in self.pending_bids.iter() {
            bids.insert(entry.key().clone(), entry.value().clone());
        }

        let mut results = std::collections::HashMap::new();
        for entry in self.expected_results.iter() {
            results.insert(entry.key().clone(), *entry.value());
        }

        let mut auctions = std::collections::HashMap::new();
        for entry in self.auction_manager.auctions.iter() {
            auctions.insert(entry.key().clone(), entry.value().clone());
        }

        let mut mission_roots = std::collections::HashMap::new();
        for entry in self.mission_roots.iter() {
            mission_roots.insert(entry.key().clone(), entry.value().clone());
        }

        LogisticsState { problems, payloads, confirmations, bids, results, auctions, mission_roots }
    }

    pub fn save_state(&self) {
        let state = self.snapshot();
        let path = Self::get_db_path();
        std::thread::spawn(move || {
            if let Ok(data) = serde_json::to_string(&state) {
                if let Err(e) = std::fs::write(path, data) {
                    println!("❌ Persistence: Failed to save state in background: {}", e);
                }
            }
        });
    }

    /// Step 1: Register this node as the Architect for the Logistics domain.
    pub fn generate_registration_message(&self, my_address: &str) -> LoxiMessage {
        LoxiMessage::RegisterAuthority(DomainAuthority {
            domain_id: self.domain_id.clone(),
            authority_address: my_address.to_string(), // Dynamic Data Plane
        })
    }

    /// Step 2: Request specialized workers from the Orchestrator pool.
    pub fn generate_worker_request(&self, params: WorkerRequestParams) -> TaskRequirement {
        let WorkerRequestParams {
            task_id,
            artifact_hash,
            task_type,
            mission_id,
            context_hashes,
            workflow_id,
            state,
            min_ram,
            min_cpu,
            priority_owner,
        } = params;
        let mut affinities = context_hashes;
        affinities.push(artifact_hash);

        let mut metadata = vec![("state".to_string(), state)];
        if let Some(m_id) = mission_id {
            metadata.push(("mission_id".to_string(), m_id));
        }
        if let Some(w_id) = workflow_id {
            metadata.push(("workflow_id".to_string(), w_id));
        }

        TaskRequirement {
            id: task_id,
            affinities,
            task_type,
            min_ram_mb: min_ram,
            min_cpu_threads: min_cpu.unwrap_or(2), // Default to 2 if not specified
            use_gpu: false,

            priority_for_owner: priority_owner,
            metadata,
        }
    }

    /// Step 3: Conduct the competitive auction or delegate partitioning.
    pub fn distribute_tasks(
        &mut self,
        auction_id: String,
        problem: &types::Problem,
    ) -> (Vec<LoxiMessage>, Vec<String>) {
        let mut messages = Vec::new();
        let mut ids = Vec::new();

        let mut problem = problem.clone();
        let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
        problem.id = Some(auction_id.clone());
        problem.mission_id = Some(mission_id.clone());

        // 🔑 CRITICAL: Persistent the ROOT problem so check_mission_completion can find it
        self.pending_problems.insert(auction_id.clone(), problem.clone());
        self.mission_roots.insert(mission_id.clone(), auction_id.clone());

        // --- HIERARCHICAL ORCHESTRATION ---

        // 0. BYPASS: If the problem is small enough, don't partition.
        // NOTE: Disabled — VrpSolver requires a precomputed matrix; Haversine fallback removed.
        // All problems now go through the MatrixPartition → Solver pipeline.
        if problem.stops.is_empty() {
            let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
            let mut p_copy = problem.clone();
            let task_id = auction_id.clone();
            p_copy.id = Some(task_id.clone());
            p_copy.mission_id = Some(mission_id.clone());
            p_copy.fleet_size = problem.fleet_size; // Propagate or preserve
            p_copy.role = TaskRole::Leaf;
            let problem = p_copy;

            let solver_hash = problem
                .config
                .solver_artifact_hash
                .clone()
                .unwrap_or_else(|| "loxi_vrp".to_string());

            let req = self.generate_worker_request(WorkerRequestParams {
                task_id: task_id.clone(),
                artifact_hash: solver_hash,
                task_type: TaskType::Compute,
                mission_id: Some(mission_id.clone()),
                context_hashes: problem.config.required_contexts.clone(),
                workflow_id: problem.config.workflow_id.clone(),
                state: "solving".to_string(),
                min_ram: 1024,
                min_cpu: problem.config.min_cpu,
                priority_owner: problem.config.priority_owner.clone(),
            });

            self.pending_problems.insert(task_id.clone(), problem);
            self.expected_results.insert(task_id.clone(), 1);
            ids.push(task_id.clone());
            messages.push(self.auction_manager.create_auction(
                task_id,
                self.domain_id.clone(),
                req,
            ));

            // self.save_state();
            return (messages, ids);
        }

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
                1000000.0,
            );

            let (sectors, unassigned) = macro_partitioner.partition_problem(&problem);
            println!(
                "📦 Created {} Sectors for Titan delegation. Unassigned: {}",
                sectors.len(),
                unassigned.len()
            );

            let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
            let mut sector_ids = Vec::new();
            for sector in sectors {
                let sub_stops: Vec<types::Stop> = problem
                    .stops
                    .iter()
                    .filter(|s| sector.job_ids.contains(&s.id))
                    .cloned()
                    .collect();

                let sector_task_id = uuid::Uuid::new_v4().to_string();
                let sub_problem = types::Problem {
                    id: Some(sector_task_id.clone()),
                    mission_id: Some(mission_id.clone()),
                    stops: sub_stops,
                    role: TaskRole::Partitioner,
                    parent_id: Some(auction_id.clone()),
                    ..problem.clone()
                };

                let partitioner_hash = problem
                    .config
                    .partitioner_hash
                    .clone()
                    .unwrap_or_else(|| "loxi_partitioner".to_string());

                let req = self.generate_worker_request(WorkerRequestParams {
                    task_id: sector_task_id.clone(),
                    artifact_hash: partitioner_hash,
                    task_type: TaskType::Custom("sector".to_string()),
                    mission_id: Some(mission_id.clone()),
                    context_hashes: problem.config.required_contexts.clone(),
                    workflow_id: problem.config.workflow_id.clone(),
                    state: "partitioning".to_string(),
                    min_ram: 8192,
                    min_cpu: problem.config.min_cpu,
                    priority_owner: problem.config.priority_owner.clone(),
                });

                self.pending_problems.insert(sector_task_id.clone(), sub_problem);
                self.expected_results.insert(sector_task_id.clone(), 1);
                ids.push(sector_task_id.clone());
                sector_ids.push(sector_task_id.clone());
                messages.push(self.auction_manager.create_auction(
                    sector_task_id,
                    self.domain_id.clone(),
                    req,
                ));
            }

            // Update parent problem to know its sub-tasks
            if let Some(mut parent) = self.pending_problems.get_mut(&auction_id) {
                parent.subtask_ids = sector_ids;
            }

            // self.save_state();
            return (messages, ids);
        }

        // 2. MICRO-STAGE: For manageable problems (<5000), we partition locally directly into Routes.
        let sub_partitions = self.core.partition(&problem);

        let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
        let mut partition_ids = Vec::new();
        for partition in sub_partitions {
            let sub_stops: Vec<types::Stop> = problem
                .stops
                .iter()
                .filter(|s| partition.job_ids.contains(&s.id))
                .cloned()
                .collect();

            let sub_task_id = if partition.id == "overflow_rescue" {
                format!("overflow_rescue_{}", uuid::Uuid::new_v4())
            } else {
                uuid::Uuid::new_v4().to_string()
            };
            let sub_problem = types::Problem {
                id: Some(sub_task_id.clone()),
                mission_id: Some(mission_id.clone()),
                stops: sub_stops.clone(),
                fleet_size: problem.fleet_size, // Propagate or proportional
                fleet: problem.fleet.clone(),
                vehicle: problem.vehicle.clone(),
                distance_matrix: None,
                time_matrix: None,
                seed: problem.seed,
                solution: None,
                role: TaskRole::MatrixPartition,
                config: problem.config.clone(),
                candidate_routes: None,
                client_owner_id: problem.client_owner_id.clone(),
                parent_id: Some(auction_id.clone()),
                subtask_ids: Vec::new(),
            };

            println!(
                "🚀 [Engine] Created Matrix Task: {} with {} stops (Original: {})",
                sub_task_id,
                sub_problem.stops.len(),
                problem.stops.len()
            );

            self.pending_problems.insert(sub_task_id.clone(), sub_problem);
            self.expected_results.insert(sub_task_id.clone(), 1);
            ids.push(sub_task_id.clone());
            partition_ids.push(sub_task_id.clone());

            let matrix_hash = problem
                .config
                .matrix_artifact_hash
                .clone()
                .unwrap_or_else(|| "loxi_matrix".to_string());
            let req = self.generate_worker_request(WorkerRequestParams {
                task_id: sub_task_id.clone(),
                artifact_hash: matrix_hash,
                task_type: TaskType::Compute,
                mission_id: Some(mission_id.clone()),
                context_hashes: problem.config.required_contexts.clone(),
                workflow_id: problem.config.workflow_id.clone(),
                state: "matrix".to_string(),
                min_ram: 8192,
                min_cpu: problem.config.min_cpu,
                priority_owner: problem.config.priority_owner.clone(),
            });

            messages.push(self.auction_manager.create_auction(
                sub_task_id,
                self.domain_id.clone(),
                req,
            ));
        }

        // Update parent problem to know its sub-tasks
        if let Some(mut parent) = self.pending_problems.get_mut(&auction_id) {
            parent.subtask_ids = partition_ids;
        }

        // self.save_state();
        (messages, ids)
    }

    pub fn handle_incoming_message(&mut self, msg: LoxiMessage) -> Vec<LoxiMessage> {
        match msg {
            LoxiMessage::PostTask {
                auction_id,
                requirement: TaskRequirement { id: _ignored_id, .. },
                payload,
                ..
            } => {
                if let Some(payload_str) = payload {
                    let incoming_problem =
                        if let Ok(p) = serde_json::from_str::<types::Problem>(&payload_str) {
                            Some(p)
                        } else if let Ok(agnostic) =
                            serde_json::from_str::<loxi_types::Problem>(&payload_str)
                        {
                            agnostic.payload.and_then(|inner| {
                                serde_json::from_str::<types::Problem>(&inner).ok()
                            })
                        } else {
                            None
                        };

                    if let Some(problem) = incoming_problem {
                        let incoming_len = problem.stops.len();
                        let should_insert = if let Some(existing) =
                            self.pending_problems.get(&auction_id)
                        {
                            let existing_len = existing.stops.len();
                            if incoming_len < existing_len {
                                println!("🛑 Architect: IGNORING hollow PostTask for {} (Local: {} stops, Incoming: {})", 
                                    auction_id, existing_len, incoming_len);
                                false
                            } else if incoming_len == existing_len && incoming_len > 0 {
                                // Potentially identical, skip insert to avoid unnecessary clones
                                false
                            } else {
                                true
                            }
                        } else if incoming_len == 0 {
                            println!(
                                "🛑 Architect: REJECTING empty PostTask for {} (Brand New ID from network)",
                                auction_id
                            );
                            false
                        } else {
                            true
                        };
                        if should_insert {
                            println!(
                                "📥 Conductor: Adopted problem for auction {} ({} stops)",
                                auction_id, incoming_len
                            );
                            self.pending_problems.insert(auction_id, problem);
                        }
                    }
                }
                Vec::new()
            }
            LoxiMessage::RequestLease {
                requirement: TaskRequirement { id: auction_id, .. },
                ..
            } => {
                println!(
                    "📥 Conductor: Seen RequestLease for {}. (No Payload Adoption)",
                    auction_id
                );
                Vec::new()
            }
            LoxiMessage::SubmitSolution(solution) => {
                let auction_id = solution.auction_id.clone();
                println!("✅ Architect: Received Control Signal for Auction: {}", auction_id);
                if solution.payload.is_none() {
                    // 1. Store candidate bid for evaluation
                    // DashMap doesn't have entry API like HashMap, so we use a different pattern
                    if !self.pending_bids.contains_key(&auction_id) {
                        self.pending_bids.insert(auction_id.clone(), Vec::new());
                    }
                    if let Some(mut bids) = self.pending_bids.get_mut(&auction_id) {
                        bids.push(solution.clone());
                    }

                    let expected = self.expected_results.get(&auction_id).map(|r| *r).unwrap_or(1);
                    let received = self.pending_bids.get(&auction_id).map(|b| b.len()).unwrap_or(0);

                    println!(
                        "📋 Architect: [BID] Auction {}: Registered candidate {}. ({}/{})",
                        auction_id, solution.worker_id, received, expected
                    );

                    // 2. TRIGGER SELECTION: If threshold met (e.g., 100% for 1:1)
                    if (received as f32) >= (expected as f32) * 1.0 {
                        println!(
                            "🎯 Architect: Quorum met for {}. Selecting winner...",
                            auction_id
                        );
                        return self.evaluate_and_reveal(auction_id);
                    }

                    return Vec::new();
                }

                // CASE B: Reveal Signal (With Payload)
                self.process_solution(solution)
            }
            LoxiMessage::PushSolution { auction_id, ticket, payload } => {
                if !(self.verify_fn)(&ticket) {
                    eprintln!(
                        "⚠️ PushSolution rejected: invalid ticket for {}",
                        auction_id
                    );
                    return vec![];
                }
                println!(
                    "🔓 Architect: Received Revealed Solution for {} (ticket verified)",
                    auction_id
                );
                let solution = loxi_core::Solution {
                    auction_id,
                    mission_id: None, // Will be recovered from pending problem
                    worker_id: "revealed".to_string(), // In Push mode we already know it's the winner
                    result_hash: "".to_string(),       // Hash already verified in control stage
                    payload: Some(payload),
                    client_owner_id: None, // Will be recovered from pending problem
                    metadata: Vec::new(),
                };
                self.process_solution(solution)
            }
            LoxiMessage::AuctionClosed { auction_id, winner_id, .. } => {
                println!("📦 [Logistics] Auction {} CLOSED. Winner: {}", auction_id, winner_id);
                Vec::new()
            }
            LoxiMessage::PushData { .. } => {
                // Silenced snapshots to avoid congestion in large missions
                Vec::new()
            }
            LoxiMessage::UpdateMissionStatus { mission_id, status, .. } => {
                println!("🚩 [Logistics] Mission {} Status -> {}", mission_id, status);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    pub fn process_solution(&mut self, solution: loxi_core::Solution) -> Vec<LoxiMessage> {
        let auction_id = solution.auction_id.clone();
        let role = self
            .pending_problems
            .get(&auction_id)
            .map(|p| p.role.clone())
            .unwrap_or(TaskRole::Leaf);

        println!("🛤️ Architect: Processing Solution for {} (Role: {:?})", auction_id, role);

        match role {
            TaskRole::Partitioner => {
                println!(
                    "🧬 Architect: Partitioner finished for {}. Spawning Matrix sub-tasks...",
                    auction_id
                );
                let mut outbound = Vec::new();

                if let Some(ref payload) = solution.payload {
                    // Try to unwrap ArtifactResponse if it exists
                    let actual_payload = if let Ok(resp) =
                        serde_json::from_str::<loxi_wasm_sdk::ArtifactResponse>(payload)
                    {
                        resp.payload
                    } else {
                        payload.clone()
                    };

                    if let Ok(result) = serde_json::from_str::<PartitionResult>(&actual_payload) {
                        println!(
                            "📦 Architect: Partitioner returned {} sectors and {} unassigned jobs.",
                            result.sectors.len(),
                            result.unassigned.len()
                        );

                        // DashMap: we need a reference to clone the parent problem
                        let parent_problem_opt =
                            self.pending_problems.get(&auction_id).map(|r| r.value().clone());

                        if let Some(parent) = parent_problem_opt {
                            let mission_id =
                                solution.mission_id.clone().or_else(|| parent.mission_id.clone());
                            let config = parent.config.clone();

                            let total_sub = result.sectors.len();
                            for (i, sector) in result.sectors.into_iter().enumerate() {
                                let sub_task_id = uuid::Uuid::new_v4().to_string();

                                // Map job_ids back to Stops
                                let sub_stops: Vec<types::Stop> = parent
                                    .stops
                                    .iter()
                                    .filter(|s| sector.job_ids.contains(&s.id))
                                    .cloned()
                                    .collect();

                                println!(
                                    "🧩 Architect: Sector {} mapped to {} stops (expected {})",
                                    sector.id,
                                    sub_stops.len(),
                                    sector.job_ids.len()
                                );
                                if sub_stops.is_empty() {
                                    println!("🚨 CRITICAL: Created EMPTY Sector task! Job IDs in sector: {:?}", sector.job_ids);
                                }

                                let sub_problem = types::Problem {
                                    id: Some(sub_task_id.clone()),
                                    mission_id: mission_id.clone(),
                                    stops: sub_stops.clone(),
                                    fleet_size: 1,
                                    fleet: parent.fleet.clone(),
                                    vehicle: parent.vehicle.clone(),
                                    distance_matrix: None,
                                    time_matrix: None,
                                    seed: parent.seed,
                                    solution: None,
                                    role: TaskRole::MatrixPartition,
                                    config: config.clone(),
                                    candidate_routes: None,
                                    client_owner_id: parent.client_owner_id.clone(),
                                    parent_id: Some(auction_id.clone()),
                                    subtask_ids: Vec::new(),
                                };

                                let matrix_hash = config
                                    .matrix_artifact_hash
                                    .clone()
                                    .unwrap_or_else(|| "loxi_matrix".to_string());

                                let req = self.generate_worker_request(WorkerRequestParams {
                                    task_id: sub_task_id.clone(),
                                    artifact_hash: matrix_hash,
                                    task_type: TaskType::Compute,
                                    mission_id: mission_id.clone(),
                                    context_hashes: config.required_contexts.clone(),
                                    workflow_id: config.workflow_id.clone(),
                                    state: "matrix".to_string(),
                                    min_ram: 8192,
                                    min_cpu: config.min_cpu,
                                    priority_owner: config.priority_owner.clone(),
                                });

                                self.pending_problems.insert(sub_task_id.clone(), sub_problem);

                                // 🔑 CRITICAL: Track subtasks at the ROOT level for mission completion
                                let root_id = self.find_ultimate_root(&auction_id);
                                if let Some(mut root_ref) = self.pending_problems.get_mut(&root_id)
                                {
                                    if !root_ref.subtask_ids.contains(&sub_task_id) {
                                        root_ref.subtask_ids.push(sub_task_id.clone());
                                        println!(
                                            "🌳 Root {} now tracking sub-task {}",
                                            root_id, sub_task_id
                                        );
                                    }
                                }

                                let msg = self.auction_manager.create_auction(
                                    sub_task_id.clone(),
                                    self.domain_id.clone(),
                                    req,
                                );
                                println!(
                                    "📡 Architect: [{}/{}] Posting Matrix Sub-task: {}",
                                    i + 1,
                                    total_sub,
                                    sub_task_id
                                );
                                outbound.push(msg);
                            }
                        }

                        // Mark Partitioner task itself as "solved" with a dummy solution so it counts toward completion
                        if let Some(mut self_ref) = self.pending_problems.get_mut(&auction_id) {
                            self_ref.solution = Some(types::Solution::default());
                        }
                    } else {
                        println!(
                            "❌ Architect: Failed to parse Partitioner payload for {}!",
                            auction_id
                        );
                    }
                }
                outbound
            }
            TaskRole::MatrixPartition => {
                println!(
                    "📊 Architect: Matrix Partition finished for {}. Spawning Solver...",
                    auction_id
                );

                let problem_opt = self.pending_problems.get(&auction_id).map(|r| r.value().clone());
                if let Some(mut problem) = problem_opt {
                    println!(
                        "📊 Architect: Retrieved Problem for {}; Stops: {}",
                        auction_id,
                        problem.stops.len()
                    );
                    let mut matrix_parsed = false;
                    if let Some(ref payload) = solution.payload {
                        // Try to unwrap ArtifactResponse if it exists
                        let actual_payload = if let Ok(resp) =
                            serde_json::from_str::<loxi_wasm_sdk::ArtifactResponse>(payload)
                        {
                            resp.payload
                        } else {
                            payload.clone()
                        };

                        if let Ok(matrix) = serde_json::from_str::<Vec<Vec<f64>>>(&actual_payload) {
                            problem.distance_matrix = Some(matrix);
                            matrix_parsed = true;
                        } else if let Ok(valhalla) = serde_json::from_str::<
                            crate::engines::matrix::ValhallaSolution,
                        >(&actual_payload)
                        {
                            let matrix: Vec<Vec<f64>> = valhalla
                                .sources_to_targets
                                .iter()
                                .map(|row| row.iter().map(|cost| cost.distance * 1000.0).collect())
                                .collect();
                            problem.distance_matrix = Some(matrix);
                            let time_matrix: Vec<Vec<u32>> = valhalla
                                .sources_to_targets
                                .iter()
                                .map(|row| row.iter().map(|cost| cost.time as u32).collect())
                                .collect();
                            problem.time_matrix = Some(time_matrix);
                            println!(
                                "✅ Architect: Parsed direct ValhallaSolution for {} (Dim: {})",
                                auction_id,
                                valhalla.sources_to_targets.len()
                            );
                            matrix_parsed = true;
                        } else if let Ok(loxi_sol) =
                            serde_json::from_str::<types::Solution>(&actual_payload)
                        {
                            if let Some(matrix_val) = loxi_sol.matrix {
                                if let Ok(valhalla) = serde_json::from_value::<
                                    crate::engines::matrix::ValhallaSolution,
                                >(matrix_val)
                                {
                                    let matrix: Vec<Vec<f64>> = valhalla
                                        .sources_to_targets
                                        .iter()
                                        .map(|row| {
                                            row.iter().map(|cost| cost.distance * 1000.0).collect()
                                        })
                                        .collect();
                                    problem.distance_matrix = Some(matrix);
                                    let time_matrix: Vec<Vec<u32>> = valhalla
                                        .sources_to_targets
                                        .iter()
                                        .map(|row| {
                                            row.iter().map(|cost| cost.time as u32).collect()
                                        })
                                        .collect();
                                    problem.time_matrix = Some(time_matrix);
                                    println!(
                                        "✅ Architect: Parsed Solution.matrix for {} (Dim: {})",
                                        auction_id,
                                        valhalla.sources_to_targets.len()
                                    );
                                    matrix_parsed = true;
                                } else {
                                    println!("⚠️ Architect: Solution.matrix was present but failed to parse into ValhallaSolution for {}", auction_id);
                                }
                            } else {
                                println!("⚠️ Architect: Solution payload found but .matrix field was None for {}", auction_id);
                            }
                        } else {
                            println!("⚠️ Architect: All parsing attempts failed for actual_payload of {}", auction_id);
                        }

                        if matrix_parsed {
                            // 🟢 Assign Matrix Indices to Stops (Index 0 is Vehicle Start)
                            for (i, stop) in problem.stops.iter_mut().enumerate() {
                                stop.matrix_index = Some((i + 1) as u32);
                            }
                        }
                    }

                    if !matrix_parsed {
                        println!("⚠️ Architect: MatrixPartition finished but no valid matrix was provided for {}!", auction_id);
                        if let Some(ref p) = solution.payload {
                            println!(
                                "DEBUG: Received Payload (first 200 chars): {}",
                                &p[..std::cmp::min(200, p.len())]
                            );
                        }
                        return Vec::new();
                    }

                    let partition_sol = types::Solution::default();
                    problem.solution = Some(partition_sol);
                    println!("📊 Architect: Updating MatrixPartition task {} in cache with {} stops and matrix.", 
                        auction_id, problem.stops.len());
                    self.pending_problems.insert(auction_id.clone(), problem.clone());

                    let solver_hash = problem
                        .config
                        .solver_artifact_hash
                        .clone()
                        .unwrap_or_else(|| "loxi_vrp".to_string());

                    let solve_id = uuid::Uuid::new_v4().to_string();
                    let req = self.generate_worker_request(WorkerRequestParams {
                        task_id: solve_id.clone(),
                        artifact_hash: solver_hash,
                        task_type: TaskType::Compute,
                        mission_id: problem.mission_id.clone(),
                        context_hashes: problem.config.required_contexts.clone(),
                        workflow_id: problem.config.workflow_id.clone(),
                        state: "solving".to_string(),
                        min_ram: 1024,
                        min_cpu: problem.config.min_cpu,
                        priority_owner: problem.config.priority_owner.clone(),
                    });

                    let mut solve_problem = problem.clone();
                    solve_problem.id = Some(solve_id.clone());
                    solve_problem.role = TaskRole::Solver;
                    solve_problem.solution = None;

                    if solve_problem.stops.is_empty() {
                        println!(
                            "🚨 EMERGENCY: Matrix task {} had matrix but 0 STOPS before creating Solver {}!",
                            auction_id, solve_id
                        );
                    }

                    println!(
                        "🚀 Architect: Posting Solver Task for sub-problem {} -> NEW ID: {}; Stops: {} (Matrix Dim: {})",
                        auction_id,
                        solve_id,
                        solve_problem.stops.len(),
                        solve_problem.distance_matrix.as_ref().map(|m| format!("{}x{}", m.len(), m.first().map(|r| r.len()).unwrap_or(0))).unwrap_or("None".to_string())
                    );
                    if solve_problem.stops.is_empty() {
                        println!(
                            "🚨 CRITICAL ERROR: Spawning Solver Task {} with 0 STOPS!",
                            solve_id
                        );
                    }
                    self.pending_problems.insert(solve_id.clone(), solve_problem);

                    // 🔑 CRITICAL: Track Solver task at the ROOT level
                    let root_id = self.find_ultimate_root(&auction_id);
                    if let Some(mut root_ref) = self.pending_problems.get_mut(&root_id) {
                        if !root_ref.subtask_ids.contains(&solve_id) {
                            root_ref.subtask_ids.push(solve_id.clone());
                            println!("🌳 Root {} now tracking solver-task {}", root_id, solve_id);
                        }
                    }

                    vec![self.auction_manager.create_auction(solve_id, self.domain_id.clone(), req)]
                } else {
                    Vec::new()
                }
            }
            TaskRole::Solver | TaskRole::Leaf => {
                let mut messages = Vec::new();
                let role_label = format!("{:?}", role);
                println!(
                    "🏁 Architect: {} finished for {}. Saving Final Result.",
                    role_label, auction_id
                );

                let problem_opt = self.pending_problems.get(&auction_id).map(|r| r.value().clone());
                if let Some(mut problem) = problem_opt {
                    if let Some(ref payload) = solution.payload {
                        // Try to unwrap ArtifactResponse if it exists
                        let actual_payload = if let Ok(resp) =
                            serde_json::from_str::<loxi_wasm_sdk::ArtifactResponse>(payload)
                        {
                            resp.payload
                        } else {
                            payload.clone()
                        };

                        if let Ok(solver_solution) =
                            serde_json::from_str::<types::Solution>(&actual_payload)
                        {
                            problem.solution = Some(solver_solution.clone());
                            self.pending_problems.insert(auction_id.clone(), problem.clone());

                            // 2. CHECK UNASSIGNED JOBS (Recursive Solver)
                            if !solver_solution.unassigned_jobs.is_empty() {
                                println!("⚠️ Architect: Solver for {} left {} unassigned jobs. Re-queuing...", 
                                    auction_id, solver_solution.unassigned_jobs.len());

                                let mut retry_problem = problem.clone();
                                // Filter stops to only include unassigned ones
                                retry_problem.stops = problem
                                    .stops
                                    .into_iter()
                                    .filter(|s| solver_solution.unassigned_jobs.contains(&s.id))
                                    .collect();
                                retry_problem.solution = None;

                                // 🟢 Diagnostic: Verify matrix_index preservation
                                if !retry_problem.stops.is_empty() {
                                    println!("📊 Architect: Re-queuing {} stops for mission {}. Indices: {:?}",
                                        retry_problem.stops.len(),
                                        retry_problem.mission_id.as_ref().unwrap_or(&"unknown".to_string()),
                                        retry_problem.stops.iter().map(|s| s.matrix_index).collect::<Vec<_>>()
                                    );
                                }

                                let retry_id = uuid::Uuid::new_v4().to_string();
                                retry_problem.id = Some(retry_id.clone());

                                if retry_problem.stops.is_empty() {
                                    println!("🚨 EMERGENCY: Re-queued task {} has 0 STOPS. Solver unassigned IDs: {:?}", 
                                        retry_id, solver_solution.unassigned_jobs);
                                }

                                let solver_hash = problem
                                    .config
                                    .solver_artifact_hash
                                    .clone()
                                    .unwrap_or_else(|| "loxi_vrp".to_string());

                                let req = self.generate_worker_request(WorkerRequestParams {
                                    task_id: retry_id.clone(),
                                    artifact_hash: solver_hash,
                                    task_type: TaskType::Compute,
                                    mission_id: problem.mission_id.clone(),
                                    context_hashes: problem.config.required_contexts.clone(),
                                    workflow_id: problem.config.workflow_id.clone(),
                                    state: "solving-retry".to_string(),
                                    min_ram: 1024,
                                    min_cpu: problem.config.min_cpu,
                                    priority_owner: problem.config.priority_owner.clone(),
                                });

                                // 🔑 CRITICAL: Update parent's subtask_ids with the new retry task
                                if let Some(_m_id) = &problem.mission_id {
                                    // 1. Traverse up to find the ULTIMATE root of this mission
                                    let rid = self.find_ultimate_root(&auction_id);
                                    retry_problem.parent_id = Some(rid.clone());

                                    self.pending_problems.insert(retry_id.clone(), retry_problem);

                                    if let Some(mut root_ref) = self.pending_problems.get_mut(&rid)
                                    {
                                        // If the current task was the root and just spawned its first subtask,
                                        // we must add ITSELF to the subtask list to preserve its routes,
                                        // UNLESS it's already there (e.g. from partitioning)
                                        if rid == auction_id && root_ref.subtask_ids.is_empty() {
                                            root_ref.subtask_ids.push(auction_id.clone());
                                            println!(
                                                "🌳 Root {} now tracking itself as subtask.",
                                                rid
                                            );
                                        }

                                        // Add the retry task
                                        if !root_ref.subtask_ids.contains(&retry_id) {
                                            root_ref.subtask_ids.push(retry_id.clone());
                                            println!(
                                                "✅ Updated mission root {} with new retry task {}",
                                                rid, retry_id
                                            );
                                        }
                                    }
                                }

                                messages.push(self.auction_manager.create_auction(
                                    retry_id,
                                    self.domain_id.clone(),
                                    req,
                                ));
                            }

                            // 3. EMIT MISSION UPDATE
                            let mission_id =
                                solution.mission_id.clone().or_else(|| problem.mission_id.clone());
                            if let Some(m_id) = mission_id {
                                let update_msg = LoxiMessage::UpdateMissionStatus {
                                    mission_id: m_id.clone(),
                                    status: "Partial Result Found".to_string(),
                                    details: Some(format!(
                                        "Solver finished sub-auction: {}",
                                        auction_id
                                    )),
                                };
                                messages.push(update_msg.clone());

                                // 📢 Notify Client if owner exists
                                if let Some(owner_id) = &problem.client_owner_id {
                                    let log_payload = types::LogMessage {
                                        problem_id: Some(auction_id.clone()),
                                        client_owner_id: owner_id.clone(),
                                        status: "processing".to_string(),
                                        message: Some(format!(
                                            "Solver finished sub-auction: {}",
                                            auction_id
                                        )),
                                        timestamp: std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_secs(),
                                    };
                                    messages.push(LoxiMessage::NotifyOwner {
                                        owner_id: owner_id.clone(),
                                        notify_type: "PARTIAL_RESULT".to_string(),
                                        payload: serde_json::to_string(&log_payload)
                                            .unwrap_or_default(),
                                        metadata: Vec::new(),
                                    });
                                }

                                // Check if entire mission is completed
                                messages.extend(self.check_mission_completion(&m_id));
                                return messages;
                            }
                        } else {
                            println!(
                                "❌ Architect: Failed to parse Solver payload for {}!",
                                auction_id
                            );
                        }
                    }
                }
                messages
            }
        }
    }

    pub fn evaluate_and_reveal(&mut self, auction_id: String) -> Vec<LoxiMessage> {
        let bids =
            self.pending_bids.get(&auction_id).map(|r| r.value().clone()).unwrap_or_default();
        if bids.is_empty() {
            return Vec::new();
        }

        let winner = bids
            .iter()
            .min_by_key(|b| {
                b.metadata
                    .iter()
                    .find(|(k, _)| k == "score")
                    .and_then(|(_, v)| v.parse::<i64>().ok())
                    .unwrap_or(i64::MAX)
            })
            .unwrap_or(&bids[0])
            .clone();

        println!("🏆 Architect: Winner for {} is worker {}.", auction_id, winner.worker_id);

        // Step 4: REGISTRATION FOR RECONCILIATION
        println!("📝 Registry: Storing winning bid for {} in pending_confirmations.", auction_id);
        self.pending_confirmations.insert(auction_id.clone(), winner.clone());

        // Step 5: Check for early PUSH (if payload arrived before quorum was met)
        if let Some((_, payload_content)) = self.pending_payloads.remove(&auction_id) {
            println!(
                "🔗 Architect: Early Payload reconciliation for {} (Payload size: {})",
                auction_id,
                payload_content.len()
            );
            let mut sol = winner;
            sol.payload = Some(payload_content);
            let mut msgs = self.process_solution(sol.clone());

            // Fix borrow checker: Extract m_id and drop the lock BEFORE calling mutable method
            let mission_id_opt =
                self.pending_problems.get(&auction_id).and_then(|p| p.mission_id.clone());

            if let Some(m_id) = mission_id_opt {
                msgs.extend(self.check_mission_completion(&m_id));
            }
            return msgs;
        }

        // Step 6: Command Reveal via Orchestrator Relay
        println!(
            "🔓 Architect: Emitting RevealRequest for {} (Worker: {})",
            auction_id, winner.worker_id
        );

        #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
        {
            vec![loxi_architect_sdk::protocol::request_reveal(auction_id, winner.worker_id)]
        }

        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        {
            // WASM doesn't support architect SDK or reveal requests
            println!("⚠️ [WASM] Skipping RevealRequest (SDK not available)");
            Vec::new()
        }
    }

    pub fn handle_pushed_payload(
        &mut self,
        auction_id: String,
        payload: String,
    ) -> Vec<LoxiMessage> {
        println!(
            "💾 [Architect] Stored Pushed Payload for {}. Size: {} bytes.",
            auction_id,
            payload.len()
        );

        // Check if Control Signal is waiting
        if let Some(solution) = self.pending_confirmations.remove(&auction_id) {
            println!("🔗 [Architect] Late Reconciliation Success for {}", auction_id);
            let mut full_solution = solution.1;
            full_solution.payload = Some(payload); // Inject
            self.process_solution(full_solution)
        } else {
            let available_keys: Vec<String> =
                self.pending_confirmations.iter().map(|entry| entry.key().clone()).collect();
            println!(
                "⏳ [Architect] Payload arrived but NO confirmation found for {}. Available: {:?}",
                auction_id, available_keys
            );
            self.pending_payloads.insert(auction_id, payload);
            Vec::new()
        }
    }

    pub fn find_ultimate_root(&self, auction_id: &str) -> String {
        let mut current_id = auction_id.to_string();
        let mut root_id = auction_id.to_string();
        let mut visited = std::collections::HashSet::new();
        visited.insert(current_id.clone());

        while let Some(prob) = self.pending_problems.get(&current_id) {
            if let Some(pid) = &prob.parent_id {
                if visited.contains(pid) {
                    println!(
                        "🚨 [Logistics] Circular dependency detected in task hierarchy for {}!",
                        auction_id
                    );
                    break;
                }
                current_id = pid.clone();
                root_id = current_id.clone();
                visited.insert(current_id.clone());
            } else {
                break;
            }
        }
        root_id
    }

    pub fn check_mission_completion(&mut self, mission_id: &str) -> Vec<LoxiMessage> {
        let mut messages = Vec::new();
        println!("🏁 Architect: Checking hierarchical completion for mission {}", mission_id);

        let root_problem_id = if let Some(id) = self.mission_roots.get(mission_id) {
            id.clone()
        } else {
            // Fallback: Scan if not in cache (e.g. legacy state)
            let mut found = None;
            for r in self.pending_problems.iter() {
                let p = r.value();
                if p.mission_id.as_deref() == Some(mission_id) && p.parent_id.is_none() {
                    found = Some(p.id.clone().unwrap_or_default());
                    break;
                }
            }
            if let Some(fid) = found {
                self.mission_roots.insert(mission_id.to_string(), fid.clone());
                fid
            } else {
                println!("⚠️ Mission {} has no root problem yet", mission_id);
                return Vec::new();
            }
        };

        if root_problem_id.is_empty() {
            return Vec::new();
        }
        let rid = root_problem_id;

        // Use a block to drop the read lock as soon as possible
        let root_problem = self.pending_problems.get(&rid).map(|r| r.value().clone());

        if root_problem.is_none() {
            println!("⚠️ Mission {} root problem {} missing from cache", mission_id, rid);
            return Vec::new();
        }

        let mut combined_all_stops = Vec::new();
        let mut combined_tours = Vec::new();
        let mut combined_stops = Vec::new();
        let mut combined_cost = 0.0;
        let mut completed_count = 0;
        let mut total_count = 0;
        let mut overflow_rescue_stop_count = 0usize;

        if let Some(ref root) = root_problem {
            if !root.subtask_ids.is_empty() {
                total_count = root.subtask_ids.len();
                for sub_id in &root.subtask_ids {
                    if sub_id.starts_with("overflow_rescue_") {
                        if let Some(sub_ref) = self.pending_problems.get(sub_id) {
                            overflow_rescue_stop_count += sub_ref.value().stops.len();
                        }
                    }
                    if let Some(sub_ref) = self.pending_problems.get(sub_id) {
                        let sub = sub_ref.value();
                        if let Some(ref sol) = sub.solution {
                            completed_count += 1;
                            combined_all_stops.extend(sol.all_stops.clone());

                            // 🔑 CRITICAL: Aggregate tours correctly
                            if let Some(ref sub_tours) = sol.tours {
                                combined_tours.extend(sub_tours.clone());
                            } else {
                                // Fallback for simple/leaf tasks
                                combined_tours.push(sol.all_stops.clone());
                            }

                            combined_stops.extend(sub.stops.clone());
                            combined_cost += sol.cost;
                        }
                    }
                }
            } else {
                total_count = 1;
                if let Some(ref sol) = root.solution {
                    completed_count = 1;
                    combined_all_stops.extend(sol.all_stops.clone());

                    if let Some(ref sub_tours) = sol.tours {
                        combined_tours.extend(sub_tours.clone());
                    } else {
                        combined_tours.push(sol.all_stops.clone());
                    }

                    combined_stops.extend(root.stops.clone());
                    combined_cost += sol.cost;
                }
            }
        }

        println!(
            "📊 Mission {}: {}/{} tasks completed. Combined {} paths.",
            mission_id,
            completed_count,
            total_count,
            combined_tours.len()
        );

        if completed_count == total_count && total_count > 0 {
            println!("🎉 Mission {} FULLY COMPLETED!", mission_id);

            let overflow_violations: Vec<types::Violation> = if overflow_rescue_stop_count > 0 {
                vec![types::Violation {
                    violation_type: "overflow_rescue".to_string(),
                    stop_id: "partition".to_string(),
                    magnitude: overflow_rescue_stop_count as f64,
                }]
            } else {
                Vec::new()
            };

            if overflow_rescue_stop_count > 0 {
                println!(
                    "⚠️ Mission {}: {} stop(s) fell into overflow rescue partition — check coordinate validity",
                    mission_id, overflow_rescue_stop_count
                );
            }

            let final_solution = types::Solution {
                all_stops: combined_all_stops,
                tours: Some(combined_tours),
                cost: combined_cost,
                unassigned_jobs: Vec::new(),
                cost_breakdown: Default::default(),
                violations: overflow_violations,
                metadata: Default::default(),
                matrix: None,
            };

            // 1. Update the root problem
            let client_owner_id = if let Some(mut parent_ref) = self.pending_problems.get_mut(&rid)
            {
                let parent = parent_ref.value_mut();
                parent.solution = Some(final_solution.clone());
                parent.stops = combined_stops.clone(); // HYDRATE: Ensure the root problem has the actual stops!
                parent.client_owner_id.clone()
            } else {
                None
            };

            // 2. Notify the owner with a complete artifact package
            if let Some(owner_id) = client_owner_id {
                println!("📢 Emitting NotifyOwner (Complete Artifact) for client: {}", owner_id);

                let completion_payload = serde_json::json!({
                    "mission_id": mission_id,
                    "solution": final_solution,
                    "stops": combined_stops,
                    "status": "completed"
                });

                messages.push(loxi_core::Message::NotifyOwner {
                    owner_id: owner_id.clone(),
                    notify_type: "MISSION_COMPLETED".to_string(),
                    payload: serde_json::to_string(&completion_payload).unwrap_or_default(),
                    metadata: vec![(
                        "visualizer_artifact".to_string(),
                        "loxi_solution_visualizer".to_string(),
                    )],
                });
            }

            // 3. Mark mission as Finished
            messages.push(LoxiMessage::UpdateMissionStatus {
                mission_id: mission_id.to_string(),
                status: "Finished".to_string(),
                details: Some(format!("All tasks resolved. Combined {} routes.", total_count)),
            });

            // 4. Persistence (Final only)
            // self.save_state();

            messages
        } else {
            messages
        }
    }
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub struct LogisticsArchitectProvider {
    pub manager: Arc<Mutex<LogisticsArchitect>>,
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
#[async_trait]
impl DataProvider for LogisticsArchitectProvider {
    async fn get_payload(&self, auction_id: &str) -> Option<String> {
        // Clone the Arc to avoid holding the manager lock while accessing the map
        let problems_arc = {
            let mg = self.manager.lock().unwrap();
            mg.pending_problems.clone()
        };

        let res = problems_arc.get(auction_id).and_then(|p| serde_json::to_string(p.value()).ok());
        res
    }

    async fn handle_solution(&self, solution: loxi_core::Solution) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().unwrap();
        mg.handle_incoming_message(loxi_core::Message::SubmitSolution(solution))
    }

    async fn handle_push_data(
        &self,
        auction_id: String,
        payload: String,
        progress: f32,
    ) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().unwrap();
        mg.handle_incoming_message(loxi_core::Message::PushData { auction_id, payload, progress })
    }

    async fn handle_mission_status(
        &self,
        mission_id: String,
        status: String,
        details: Option<String>,
    ) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().unwrap();
        mg.handle_incoming_message(loxi_core::Message::UpdateMissionStatus {
            mission_id,
            status,
            details,
        })
    }

    async fn handle_solution_push(&self, auction_id: String, payload: String) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().unwrap();
        mg.handle_pushed_payload(auction_id, payload)
    }
}
