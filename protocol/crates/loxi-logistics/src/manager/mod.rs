pub mod auction;
mod core;
pub mod partitioner;
pub mod types;

use crate::manager::core::CoreLogistics;
use async_trait::async_trait;
use loxi_architect_sdk::DataProvider;
use loxi_core::{DomainAuthority, Message as LoxiMessage, TaskRequirement, TaskType};
use serde::{Deserialize, Serialize};
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use std::sync::Arc;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use tokio::sync::Mutex;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use uuid;

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
        artifact_hash: &str,
        task_type: TaskType,
        mission_id: Option<String>,
        context_hashes: Vec<String>,
        workflow_id: Option<String>,
        state: &str,
        min_ram: u64,
    ) -> TaskRequirement {
        TaskRequirement {
            id: task_id,
            artifact_hash: artifact_hash.to_string(),
            context_hashes,
            task_type,
            mission_id,
            min_ram_mb: min_ram,
            use_gpu: false,
            workflow_id,
            state: Some(state.to_string()),
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

        // Ensure problem has the correctly set ID and Mission tracking
        let mut problem = problem.clone();
        let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
        problem.id = Some(auction_id.clone());
        problem.mission_id = Some(mission_id.clone());

        // --- HIERARCHICAL ORCHESTRATION ---

        // 0. BYPASS: If the problem is small enough, don't partition.
        if problem.stops.len() <= 12 {
            let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
            let mut problem = problem;
            problem.mission_id = Some(mission_id.clone());
            problem.id = Some(auction_id.clone());

            let task_id = auction_id.clone();
            let solver_hash = problem
                .config
                .solver_artifact_hash
                .clone()
                .unwrap_or_else(|| "loxi_vrp_artifact_v1".to_string());
            let req = self.generate_worker_request(
                task_id.clone(),
                &solver_hash,
                TaskType::Compute,
                Some(mission_id.clone()),
                problem.config.required_contexts.clone(),
                problem.config.workflow_id.clone(),
                "solving",
                1024,
            );

            self.pending_problems.insert(task_id.clone(), problem);
            ids.push(task_id.clone());
            messages.push(self.auction_manager.create_auction(task_id, req, None));

            self.save_state();
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
                1000000.0, // Macro level has high capacity
            );

            let (sectors, unassigned) = macro_partitioner.partition_problem(&problem);
            println!(
                "📦 Created {} Sectors for Titan delegation. Unassigned: {}",
                sectors.len(),
                unassigned.len()
            );

            let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
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
                    ..problem.clone()
                };

                // A Sector Task is now a PARTITION task (Compute Matrix -> Partition -> Slice)
                let partitioner_hash = problem
                    .config
                    .partitioner_hash
                    .clone()
                    .unwrap_or_else(|| "loxi_sector_v1".to_string());
                let req = self.generate_worker_request(
                    sector_task_id.clone(),
                    &partitioner_hash,
                    TaskType::Custom("sector".to_string()),
                    Some(mission_id.clone()),
                    problem.config.required_contexts.clone(),
                    problem.config.workflow_id.clone(),
                    "partitioning",
                    8192,
                );

                self.pending_problems.insert(sector_task_id.clone(), sub_problem);
                ids.push(sector_task_id.clone());
                messages.push(self.auction_manager.create_auction(sector_task_id, req, None));
            }

            self.save_state();
            return (messages, ids);
        }

        // 2. MICRO-STAGE: For manageable problems (<5000), we partition locally directly into Routes.
        let sub_partitions = self.core.partition(&problem);

        let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
        for partition in sub_partitions {
            // Reconstruct sub-problem
            let sub_stops: Vec<types::Stop> = problem
                .stops
                .iter()
                .filter(|s| partition.job_ids.contains(&s.id))
                .cloned()
                .collect();

            let sub_task_id = uuid::Uuid::new_v4().to_string();
            let sub_problem = types::Problem {
                id: Some(sub_task_id.clone()),
                mission_id: Some(mission_id.clone()),
                config: problem.config.clone(),
                stops: sub_stops,
                vehicle: problem.vehicle.clone(),
                fleet_size: 1,
                distance_matrix: None,
                time_matrix: None,
                seed: problem.seed,
                solution: None,
            };

            // Stage 2 for these partitions: MATRIX calculation
            let matrix_hash = problem
                .config
                .matrix_artifact_hash
                .clone()
                .unwrap_or_else(|| "loxi_valhalla_v1".to_string());
            let req = self.generate_worker_request(
                sub_task_id.clone(),
                &matrix_hash,
                TaskType::Batch,
                Some(mission_id.clone()),
                problem.config.required_contexts.clone(),
                problem.config.workflow_id.clone(),
                "matrix",
                4096,
            );

            // SAVE to Stock
            self.pending_problems.insert(sub_task_id.clone(), sub_problem);
            ids.push(sub_task_id.clone());

            println!("🚀 [Engine] Created Matrix Task: {}", sub_task_id);

            // Post Matrix Task (Worker will discover via "La Sala" / Data Server)
            messages.push(self.auction_manager.create_auction(sub_task_id, req, None));
        }

        self.save_state();
        (messages, ids)
    }

    /// Step 4: Automate multi-stage pipelines (The "Conductor" Role)
    /// Takes an incoming message and returns a list of follow-up messages.
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

                // --- PIPELINE LOGIC (Explicit Signals) ---
                if let Some(ref next) = solution.next_action {
                    println!("🛤️ Manager: Processing Next Action: {}", next);
                    match next.as_str() {
                        "matrix" => {
                            // Stage 1 -> 2: Transition from Partitioning to Matrix
                            println!("🧬 Manager: Partition Stage Complete for {}.", auction_id);
                            let mut outbound = Vec::new();

                            if let Some(ref payload) = solution.payload {
                                if let Ok(result) = serde_json::from_str::<PartitionResult>(payload)
                                {
                                    if let Some(parent) = self.pending_problems.get(&auction_id) {
                                        let mission_id = parent.mission_id.clone();
                                        let config = parent.config.clone();
                                        let mut sub_tasks = Vec::new();
                                        for mut sub_problem in result.sub_problems {
                                            let sub_task_id = uuid::Uuid::new_v4().to_string();
                                            sub_problem.mission_id = mission_id.clone();
                                            sub_problem.config = config.clone();
                                            sub_problem.id = Some(sub_task_id.clone());

                                            let matrix_hash = config
                                                .matrix_artifact_hash
                                                .clone()
                                                .unwrap_or_else(|| "loxi_valhalla_v1".to_string());
                                            let req = self.generate_worker_request(
                                                sub_task_id.clone(),
                                                &matrix_hash,
                                                TaskType::Batch,
                                                mission_id.clone(),
                                                config.required_contexts.clone(),
                                                config.workflow_id.clone(),
                                                "matrix",
                                                4096,
                                            );
                                            sub_tasks.push((sub_task_id, req, sub_problem));
                                        }

                                        for (sub_task_id, req, sub_problem) in sub_tasks {
                                            self.pending_problems
                                                .insert(sub_task_id.clone(), sub_problem);
                                            outbound.push(self.auction_manager.create_auction(
                                                sub_task_id,
                                                req,
                                                None,
                                            ));
                                        }
                                    }
                                }
                            }
                            self.save_state();
                            return outbound;
                        }
                        "solve" => {
                            // Stage 2 -> 3: Transition from Matrix to Solve
                            if let Some(mut master_problem) =
                                self.pending_problems.get(&auction_id).cloned()
                            {
                                println!("📊 Manager: Matrix Stage Complete for {}.", auction_id);
                                if let Some(ref payload) = solution.payload {
                                    if let Ok(matrix) =
                                        serde_json::from_str::<Vec<Vec<f64>>>(payload)
                                    {
                                        master_problem.distance_matrix = Some(matrix);
                                    } else if let Ok(valhalla) =
                                        serde_json::from_str::<
                                            crate::engines::matrix::ValhallaSolution,
                                        >(payload)
                                    {
                                        let matrix: Vec<Vec<f64>> = valhalla
                                            .sources_to_targets
                                            .iter()
                                            .map(|row| {
                                                row.iter().map(|cost| cost.distance).collect()
                                            })
                                            .collect();
                                        master_problem.distance_matrix = Some(matrix);
                                        let time_matrix: Vec<Vec<u32>> = valhalla
                                            .sources_to_targets
                                            .iter()
                                            .map(|row| {
                                                row.iter().map(|cost| cost.time as u32).collect()
                                            })
                                            .collect();
                                        master_problem.time_matrix = Some(time_matrix);
                                    }
                                }

                                let solver_hash = master_problem
                                    .config
                                    .solver_artifact_hash
                                    .clone()
                                    .unwrap_or_else(|| "loxi_vrp_artifact_v1".to_string());
                                let solve_id = uuid::Uuid::new_v4().to_string(); // UNIQUE ID for solve stage
                                let req = self.generate_worker_request(
                                    solve_id.clone(),
                                    &solver_hash,
                                    TaskType::Compute,
                                    master_problem.mission_id.clone(),
                                    master_problem.config.required_contexts.clone(),
                                    master_problem.config.workflow_id.clone(),
                                    "solving",
                                    1024,
                                );
                                let mut solve_problem = master_problem.clone();
                                solve_problem.id = Some(solve_id.clone());
                                self.pending_problems
                                    .insert(solve_id.clone(), solve_problem.clone());
                                let agnostic = loxi_types::Problem {
                                    auction_id: solve_id.clone(),
                                    domain_id: self.domain_id.clone(),
                                    payload: Some(serde_json::to_string(&solve_problem).unwrap()),
                                };
                                self.save_state();
                                return vec![LoxiMessage::PostTask {
                                    auction_id: solve_id,
                                    requirement: req,
                                    payload: Some(serde_json::to_string(&agnostic).unwrap()),
                                }];
                            }
                        }
                        "finish" => {
                            // Final Stage: Save Solution
                            println!(
                                "🏁 Manager: Final Solver Solution received for {}.",
                                auction_id
                            );
                            if let Some(mut problem) =
                                self.pending_problems.get(&auction_id).cloned()
                            {
                                if let Some(ref payload) = solution.payload {
                                    if let Ok(sol) =
                                        serde_json::from_str::<types::Solution>(payload)
                                    {
                                        problem.solution = Some(sol);
                                        self.pending_problems.insert(auction_id, problem);
                                        self.save_state();
                                    }
                                }
                            }
                            return Vec::new();
                        }
                        _ => {
                            println!("⚠️ Unknown Next Action: {}", next);
                        }
                    }
                }

                // --- LEGACY/FALLBACK LOGIC (ID-based) ---
                if auction_id.contains("partition") || auction_id.contains("sector") {
                    println!(
                        "🏁 Manager: Final Solver Solution received for {} (Cost: {})",
                        auction_id, solution.cost
                    );

                    if let Some(mut master_problem) =
                        self.pending_problems.get(&auction_id).cloned()
                    {
                        if let Some(ref payload) = solution.payload {
                            if let Ok(sol) = serde_json::from_str::<types::Solution>(payload) {
                                master_problem.solution = Some(sol);
                                self.pending_problems.insert(auction_id.clone(), master_problem);
                                self.save_state();
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
            LoxiMessage::PushData { auction_id, progress, .. } => {
                println!("📈 Manager: Data Pushed for {}: {}%", auction_id, progress * 100.0);
                Vec::new()
            }
            LoxiMessage::UpdateMissionStatus { mission_id, status, .. } => {
                println!("🚩 Manager: Mission {} Status -> {}", mission_id, status);
                Vec::new()
            }
            // Agnostic safety: Catch all other messages to satisfy the compiler
            _ => Vec::new(),
        }
    }
}

pub struct LogisticsDataProvider {
    pub manager: Arc<Mutex<LogisticsManager>>,
}

#[async_trait]
impl DataProvider for LogisticsDataProvider {
    async fn get_payload(&self, auction_id: &str) -> Option<String> {
        let mg = self.manager.lock().await;
        mg.pending_problems.get(auction_id).and_then(|p| serde_json::to_string(p).ok())
    }

    async fn handle_solution(&self, solution: loxi_core::Solution) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().await;
        mg.handle_incoming_message(loxi_core::Message::SubmitSolution(solution))
    }

    async fn handle_push_data(
        &self,
        auction_id: String,
        payload: String,
        progress: f32,
    ) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().await;
        mg.handle_incoming_message(loxi_core::Message::PushData { auction_id, payload, progress })
    }

    async fn handle_mission_status(
        &self,
        mission_id: String,
        status: String,
        details: Option<String>,
    ) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().await;
        mg.handle_incoming_message(loxi_core::Message::UpdateMissionStatus {
            mission_id,
            status,
            details,
        })
    }
}
