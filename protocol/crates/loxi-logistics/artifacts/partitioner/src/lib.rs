use loxi_logistics::engines::partitioner::{Partition, Partitioner};
use loxi_logistics::manager::types::Problem;
use loxi_wasm_sdk::{loxi_worker_wrapper, LoxiArtifact};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// --- DOMAIN TYPES (Result Definition) ---

#[derive(Debug, Serialize, Deserialize)]
pub struct PartitionResult {
    pub sub_problems: Vec<Problem>,
}

// --- ARTIFACT IMPLEMENTATION (The SDK Glue) ---

pub struct PartitionerArtifact;

impl LoxiArtifact for PartitionerArtifact {
    type Problem = Problem;
    type Solution = PartitionResult;

    fn solve(problem: &Self::Problem) -> Result<Self::Solution, String> {
        let partitioner = Partitioner::new();
        let partitions = partitioner.partition_problem(problem);

        // Convert partitions back to sub-problems
        let mut sub_problems = Vec::new();
        for part in partitions {
            let sub_stops: Vec<_> =
                problem.stops.iter().filter(|s| part.job_ids.contains(&s.id)).cloned().collect();

            if !sub_stops.is_empty() {
                sub_problems.push(Problem {
                    stops: sub_stops,
                    fleet_size: 1,
                    vehicle: problem.vehicle.clone(),
                    distance_matrix: None,
                    time_matrix: None,
                    seed: problem.seed,
                    solution: None,
                });
            }
        }

        Ok(PartitionResult { sub_problems })
    }

    fn get_cost(_solution: &Self::Solution) -> f64 {
        0.0 // Partitioning has no intrinsic "cost" in VRP terms
    }
}

// --- WASM ENTRY POINT (Using SDK Wrapper) ---

#[wasm_bindgen]
pub fn partition(problem_json: &str) -> String {
    match loxi_worker_wrapper::<PartitionerArtifact>(problem_json) {
        Ok(json) => json,
        Err(e) => {
            let error_msg = e.as_string().unwrap_or_else(|| format!("{:?}", e));
            format!("{{\"error\": {:?}}}", error_msg)
        }
    }
}
