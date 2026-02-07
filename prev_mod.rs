pub mod auction;
mod core;
pub mod partitioner;
pub mod types;
use types::TaskRole;

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
    pub pending_payloads: std::collections::HashMap<String, String>, // AuctionID -> Payload
    pub pending_confirmations: std::collections::HashMap<String, loxi_core::Solution>, // AuctionID -> Control Msg
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
            pending_payloads: std::collections::HashMap::new(),
            pending_confirmations: std::collections::HashMap::new(),
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
        min_cpu: Option<u32>,
        priority_owner: Option<String>,
    ) -> TaskRequirement {
        let mut affinities = context_hashes;
        affinities.push(artifact_hash.to_string());

        let mut metadata = vec![("state".to_string(), state.to_string())];
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

        // Ensure problem has the correctly set ID and Mission tracking
        let mut problem = problem.clone();
        let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
        problem.id = Some(auction_id.clone());
        problem.mission_id = Some(mission_id.clone());

        // --- HIERARCHICAL ORCHESTRATION ---

        // 0. BYPASS: If the problem is small enough, don't partition.
        if problem.stops.len() <= 12 {
            let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
            let mut p_copy = problem.clone();
            let task_id = auction_id.clone();
            p_copy.id = Some(task_id.clone());
            p_copy.mission_id = Some(mission_id.clone());
            p_copy.role = TaskRole::Leaf;
            let problem = p_copy;

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
                problem.config.min_cpu,
                problem.config.priority_owner.clone(),
            );

            self.pending_problems.insert(task_id.clone(), problem);
            ids.push(task_id.clone());
            messages.push(self.auction_manager.create_auction(task_id, req));

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
                1000000.0,
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
                    role: TaskRole::Partitioner,
                    ..problem.clone()
                };

                let partitioner_hash = problem
                    .config
                    .partitioner_hash
                    .clone()
                    .unwrap_or_else(|| "loxi_partitioner_v1".to_string());

                let req = self.generate_worker_request(
                    sector_task_id.clone(),
                    &partitioner_hash,
                    TaskType::Custom("sector".to_string()),
                    Some(mission_id.clone()),
                    problem.config.required_contexts.clone(),
                    problem.config.workflow_id.clone(),
                    "partitioning",
                    8192,
                    problem.config.min_cpu,
                    problem.config.priority_owner.clone(),
                );

                self.pending_problems.insert(sector_task_id.clone(), sub_problem);
                ids.push(sector_task_id.clone());
                messages.push(self.auction_manager.create_auction(sector_task_id, req));
            }

            self.save_state();
            return (messages, ids);
        }

        // 2. MICRO-STAGE: For manageable problems (<5000), we partition locally directly into Routes.
        let sub_partitions = self.core.partition(&problem);

        let mission_id = problem.mission_id.clone().unwrap_or(auction_id.clone());
        for partition in sub_partitions {
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
                stops: sub_stops,
                fleet_size: 1,
                vehicle: problem.vehicle.clone(),
                distance_matrix: None,
                time_matrix: None,
                seed: problem.seed,
                solution: None,
                role: TaskRole::MatrixPartition,
                config: problem.config.clone(),
            };

            let matrix_hash = problem
                .config
                .matrix_artifact_hash
                .clone()
                .unwrap_or_else(|| "loxi_valhalla_v1".to_string());
            let req = self.generate_worker_request(
                sub_task_id.clone(),
                &matrix_hash,
                TaskType::Compute,
                Some(mission_id.clone()),
                problem.config.required_contexts.clone(),
                problem.config.workflow_id.clone(),
                "matrix",
                8192,
                problem.config.min_cpu,
                problem.config.priority_owner.clone(),
            );

            self.pending_problems.insert(sub_task_id.clone(), sub_problem);
            ids.push(sub_task_id.clone());

            println!("🚀 [Engine] Created Matrix Task: {}", sub_task_id);
            messages.push(self.auction_manager.create_auction(sub_task_id, req));
        }

        self.save_state();
        (messages, ids)
    }

    pub fn handle_incoming_message(&mut self, msg: LoxiMessage) -> Vec<LoxiMessage> {
        match &msg {
            LoxiMessage::SubmitSolution(s) => {
                println!("📥 Conductor: Received SubmitSolution for {}", s.auction_id)
            }
            LoxiMessage::PostTask { auction_id, .. } => {
                println!("📥 Conductor: Received PostTask for {}", auction_id)
            }
            _ => {}
        }

        match msg {
            LoxiMessage::PostTask {
                auction_id,
                requirement: TaskRequirement { id: _ignored_id, .. },
                payload,
                ..
            } => {
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
            LoxiMessage::RequestLease {
                requirement: TaskRequirement { id: auction_id, .. },
                ..
            } => {
                println!(
                    "📥 Conductor: Seen RequestLease for {}. (No Payload Adoption)",
                    auction_id
                );
                self.save_state();
                Vec::new()
            }
            LoxiMessage::SubmitSolution(solution) => {
                let auction_id = solution.auction_id.clone();
                println!("✅ Manager: Received Control Signal for Auction: {}", auction_id);

                if solution.payload.is_none() {
                    if let Some(problem) = self.pending_problems.get(&auction_id) {
                        if problem.solution.is_some() {
                            return Vec::new();
                        }
                    }
                }

                let mut full_solution = solution.clone();
                if let Some(payload) = self.pending_payloads.remove(&auction_id) {
                    println!("🔗 Manager: Reconciled Payload for {}", auction_id);
                    full_solution.payload = Some(payload);
                } else {
                    println!("⏳ Manager: Waiting for Data Plane Payload (SubmitSolution Signal Received) for {}...", auction_id);
                    self.pending_confirmations.insert(auction_id.clone(), solution);
                    return Vec::new();
                }

                self.process_solution(full_solution)
            }
            LoxiMessage::AuctionClosed { auction_id, winner_id, .. } => {
                println!("Hammer Manager: Auction {} CLOSED. Winner: {}", auction_id, winner_id);
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

        println!("🛤️ Manager: Processing Solution for {} (Role: {:?})", auction_id, role);

        match role {
            TaskRole::Partitioner => {
                println!(
                    "🧬 Manager: Partitioner finished for {}. Spawning Matrix sub-tasks...",
                    auction_id
                );
                let mut outbound = Vec::new();

                if let Some(ref payload) = solution.payload {
                    if let Ok(result) = serde_json::from_str::<PartitionResult>(payload) {
                        println!("📦 Manager: Partitioner returned {} sub-problems and {} unassigned jobs.", 
                            result.sub_problems.len(), result.unassigned_jobs.len());

                        if let Some(parent) = self.pending_problems.get(&auction_id) {
                            let mission_id = parent.mission_id.clone();
                            let config = parent.config.clone();

                            let total_sub = result.sub_problems.len();
                            for (i, mut sub_problem) in result.sub_problems.into_iter().enumerate()
                            {
                                let sub_task_id = uuid::Uuid::new_v4().to_string();
                                sub_problem.mission_id = mission_id.clone();
                                sub_problem.config = config.clone();
                                sub_problem.id = Some(sub_task_id.clone());
                                sub_problem.role = TaskRole::MatrixPartition;

                                let matrix_hash = config
                                    .matrix_artifact_hash
                                    .clone()
                                    .unwrap_or_else(|| "loxi_valhalla_v1".to_string());

                                let req = self.generate_worker_request(
                                    sub_task_id.clone(),
                                    &matrix_hash,
                                    TaskType::Compute,
                                    mission_id.clone(),
                                    config.required_contexts.clone(),
                                    config.workflow_id.clone(),
                                    "matrix",
                                    8192,
                                    config.min_cpu,
                                    config.priority_owner.clone(),
                                );

                                self.pending_problems.insert(sub_task_id.clone(), sub_problem);
                                let msg =
                                    self.auction_manager.create_auction(sub_task_id.clone(), req);
                                println!(
                                    "📡 Manager: [{}/{}] Posting Matrix Sub-task: {}",
                                    i + 1,
                                    total_sub,
                                    sub_task_id
                                );
                                outbound.push(msg);
                            }
                        }
                    } else {
                        println!(
                            "❌ Manager: Failed to parse Partitioner payload for {}!",
                            auction_id
                        );
                    }
                }
                self.save_state();
                outbound
            }
            TaskRole::MatrixPartition => {
                println!(
                    "📊 Manager: Matrix Partition finished for {}. Spawning Solver...",
                    auction_id
                );

                if let Some(mut problem) = self.pending_problems.get(&auction_id).cloned() {
                    let mut matrix_parsed = false;
                    if let Some(ref payload) = solution.payload {
                        if let Ok(matrix) = serde_json::from_str::<Vec<Vec<f64>>>(payload) {
                            println!(
                                "✅ Manager: Parsed raw matrix (Vec<Vec<f64>>) for {}",
                                auction_id
                            );
                            problem.distance_matrix = Some(matrix);
                            matrix_parsed = true;
                        } else if let Ok(valhalla) = serde_json::from_str::<
                            crate::engines::matrix::ValhallaSolution,
                        >(payload)
                        {
                            println!(
                                "✅ Manager: Parsed Valhalla Solution ({} rows) for {}",
                                auction_id,
                                valhalla.sources_to_targets.len()
                            );
                            let matrix: Vec<Vec<f64>> = valhalla
                                .sources_to_targets
                                .iter()
                                .map(|row| row.iter().map(|cost| cost.distance).collect())
                                .collect();
                            problem.distance_matrix = Some(matrix);
                            let time_matrix: Vec<Vec<u32>> = valhalla
                                .sources_to_targets
                                .iter()
                                .map(|row| row.iter().map(|cost| cost.time as u32).collect())
                                .collect();
                            problem.time_matrix = Some(time_matrix);
                            matrix_parsed = true;
                        } else {
                            // Try to unwrap ArtifactResponse if it exists
                            let actual_payload = if let Ok(resp) =
                                serde_json::from_str::<loxi_wasm_sdk::ArtifactResponse>(payload)
                            {
                                resp.payload
                            } else {
                                payload.clone()
                            };

                            if let Ok(loxi_sol) =
                                serde_json::from_str::<types::Solution>(&actual_payload)
                            {
                                if let Some(matrix_val) = loxi_sol.matrix {
                                    if let Ok(valhalla) =
                                        serde_json::from_value::<
                                            crate::engines::matrix::ValhallaSolution,
                                        >(matrix_val)
                                    {
                                        println!(
                                            "✅ Manager: Parsed Valhalla Matrix from Loxi Solution for {}",
                                            auction_id
                                        );
                                        let matrix: Vec<Vec<f64>> = valhalla
                                            .sources_to_targets
                                            .iter()
                                            .map(|row| {
                                                row.iter().map(|cost| cost.distance).collect()
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
                                        matrix_parsed = true;
                                    }
                                }
                            }
                        }
                    }

                    if !matrix_parsed {
                        println!("⚠️ Manager: MatrixPartition finished but no valid matrix was provided for {}!", auction_id);
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
                    self.pending_problems.insert(auction_id.clone(), problem.clone());

                    let solver_hash = problem
                        .config
                        .solver_artifact_hash
                        .clone()
                        .unwrap_or_else(|| "loxi_solver_v1".to_string());

                    let solve_id = uuid::Uuid::new_v4().to_string();
                    let req = self.generate_worker_request(
                        solve_id.clone(),
                        &solver_hash,
                        TaskType::Compute,
                        problem.mission_id.clone(),
                        problem.config.required_contexts.clone(),
                        problem.config.workflow_id.clone(),
                        "solving",
                        1024,
                        problem.config.min_cpu,
                        problem.config.priority_owner.clone(),
                    );

                    let mut solve_problem = problem.clone();
                    solve_problem.id = Some(solve_id.clone());
                    solve_problem.role = TaskRole::Solver;
                    solve_problem.solution = None;

                    println!(
                        "🚀 Manager: Posting Solver Task for sub-problem {} -> NEW ID: {}",
                        auction_id, solve_id
                    );
                    self.pending_problems.insert(solve_id.clone(), solve_problem);
                    self.save_state();

                    vec![self.auction_manager.create_auction(solve_id, req)]
                } else {
                    Vec::new()
                }
            }
            TaskRole::Solver | TaskRole::Leaf => {
                let role_label = format!("{:?}", role);
                println!(
                    "🏁 Manager: {} finished for {}. Saving Final Result.",
                    role_label, auction_id
                );

                if let Some(mut problem) = self.pending_problems.get(&auction_id).cloned() {
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
                            problem.solution = Some(solver_solution);
                            self.pending_problems.insert(auction_id.clone(), problem.clone());
                            self.save_state();
                        } else {
                            println!(
                                "❌ Manager: Failed to parse Solver payload for {}!",
                                auction_id
                            );
                        }
                    }
                }
                Vec::new()
            }
        }
    }

    pub fn handle_pushed_payload(
        &mut self,
        auction_id: String,
        payload: String,
    ) -> Vec<LoxiMessage> {
        println!("💾 Manager: Stored Pushed Payload for {}", auction_id);

        if let Some(solution) = self.pending_confirmations.remove(&auction_id) {
            println!("🔗 Manager: Late Reconciliation for {}", auction_id);
            let mut full_solution = solution.clone();
            full_solution.payload = Some(payload);
            return self.process_solution(full_solution);
        } else {
            self.pending_payloads.insert(auction_id, payload);
            Vec::new()
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

    async fn handle_solution_push(&self, auction_id: String, payload: String) -> Vec<LoxiMessage> {
        let mut mg = self.manager.lock().await;
        mg.handle_pushed_payload(auction_id, payload)
    }
}
