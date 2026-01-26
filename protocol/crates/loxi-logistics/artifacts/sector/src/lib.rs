use loxi_logistics::engines::matrix::{ValhallaProblem, ValhallaSolution};
use loxi_logistics::engines::partitioner::Partitioner;
use loxi_logistics::manager::types::Problem;
use loxi_wasm_sdk::{loxi_worker_wrapper, LoxiArtifact};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// --- DOMAIN TYPES ---

#[derive(Debug, Serialize, Deserialize)]
pub struct PartitionResult {
    pub sub_problems: Vec<Problem>,
    pub unassigned_jobs: Vec<String>,
}

// --- FOREIGN INTERFACE (The Valhalla Bridge) ---

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = "callValhallaBridge")]
    fn call_valhalla_bridge(json_input: &str) -> String;
}

// --- ARTIFACT IMPLEMENTATION ---

pub struct SectorArtifact;

impl LoxiArtifact for SectorArtifact {
    type Problem = Problem;
    type Solution = PartitionResult;

    fn solve(problem: &Self::Problem) -> Result<Self::Solution, String> {
        // 1. Prepare Valhalla Problem
        let v_problem = ValhallaProblem {
            locations: problem.stops.iter().map(|s| s.location.clone()).collect(),
            costing: "auto".to_string(),
            extra: serde_json::Map::new(),
        };

        // 2. CALL THE BRIDGE (Matrix Calculation)
        let json_str =
            serde_json::to_string(&v_problem).map_err(|e| format!("Serialization error: {}", e))?;
        let response_str = call_valhalla_bridge(&json_str);

        if response_str.is_empty() || response_str.starts_with("ERROR") {
            return Err(format!("Bridge Error: {}", response_str));
        }

        let valhalla: ValhallaSolution =
            serde_json::from_str(&response_str).map_err(|e| format!("Parsing error: {}", e))?;

        // 3. MICRO-PARTITION (Decentralized Capacity-Aware Slicing)
        let partitioner = Partitioner::with_options(
            loxi_logistics::engines::partitioner::Resolution::Nine,
            25,
            problem.vehicle.capacity,
        );
        let routes = partitioner.partition_problem(problem);

        let mut sub_problems = Vec::new();

        let dist_matrix: Vec<Vec<f64>> = valhalla
            .sources_to_targets
            .iter()
            .map(|row| row.iter().map(|cell| cell.distance).collect())
            .collect();
        let time_matrix: Vec<Vec<u32>> = valhalla
            .sources_to_targets
            .iter()
            .map(|row| row.iter().map(|cell| cell.time as u32).collect())
            .collect();

        for route in &routes {
            let stop_indices: Vec<usize> = problem
                .stops
                .iter()
                .enumerate()
                .filter(|(_, s)| route.job_ids.contains(&s.id))
                .map(|(idx, _)| idx)
                .collect();

            let sub_stops: Vec<_> =
                problem.stops.iter().filter(|s| route.job_ids.contains(&s.id)).cloned().collect();

            if !sub_stops.is_empty() {
                let mut sub_problem = Problem {
                    stops: sub_stops,
                    fleet_size: 1,
                    vehicle: problem.vehicle.clone(),
                    distance_matrix: None,
                    time_matrix: None,
                    seed: problem.seed,
                };

                // Attach sliced matrices
                sub_problem.distance_matrix = Some(
                    stop_indices
                        .iter()
                        .map(|&i| stop_indices.iter().map(|&j| dist_matrix[i][j]).collect())
                        .collect(),
                );
                sub_problem.time_matrix = Some(
                    stop_indices
                        .iter()
                        .map(|&i| stop_indices.iter().map(|&j| time_matrix[i][j]).collect())
                        .collect(),
                );

                sub_problems.push(sub_problem);
            }
        }

        let mut assigned_ids = std::collections::HashSet::new();
        for route in &routes {
            assigned_ids.extend(route.job_ids.clone());
        }

        let unassigned_jobs: Vec<String> = problem
            .stops
            .iter()
            .filter(|s| !assigned_ids.contains(&s.id))
            .map(|s| s.id.clone())
            .collect();

        Ok(PartitionResult { sub_problems, unassigned_jobs })
    }

    fn get_cost(_solution: &Self::Solution) -> f64 {
        0.0
    }

    fn get_unassigned_jobs(solution: &Self::Solution) -> Vec<String> {
        solution.unassigned_jobs.clone()
    }
}

#[wasm_bindgen]
pub fn solve_sector(problem_json: &str) -> String {
    match loxi_worker_wrapper::<SectorArtifact>(problem_json) {
        Ok(json) => json,
        Err(e) => format!("{{\"error\": {:?}}}", e.as_string()),
    }
}
