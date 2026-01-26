pub mod engines;
pub mod manager;

use crate::engines::vrp::VrpSolver;
use crate::manager::types::{Problem, Solution};
use loxi_wasm_sdk::{loxi_worker_wrapper, LoxiArtifact};
use wasm_bindgen::prelude::*;

pub struct LogisticsArtifact;

impl LoxiArtifact for LogisticsArtifact {
    type Problem = Problem;
    type Solution = Solution;

    fn solve(problem: &Self::Problem) -> Result<Self::Solution, String> {
        VrpSolver::solve(problem).map_err(|e| format!("Solver failed: {}", e))
    }

    fn get_cost(solution: &Self::Solution) -> f64 {
        solution.cost
    }
}

#[wasm_bindgen]
pub fn loxi_solve(problem_json: &str) -> Result<String, JsValue> {
    loxi_worker_wrapper::<LogisticsArtifact>(problem_json)
}

#[wasm_bindgen]
pub fn loxi_solve_seeded(problem_json: &str, _seed: u64) -> Result<String, JsValue> {
    // In the future, this will configure VrpSolver with the seed
    loxi_worker_wrapper::<LogisticsArtifact>(problem_json)
}

#[wasm_bindgen]
pub fn loxi_refine_seeded(
    problem_json: &str,
    _solution_json: &str,
    _seed: u64,
) -> Result<String, JsValue> {
    // For now, refinement just re-solves as a placeholder
    loxi_worker_wrapper::<LogisticsArtifact>(problem_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_solve_route() {
        let problem_json = r#"{
            "stops": [
                {
                    "id": "A",
                    "location": {"lat": 40.0, "lon": -74.0},
                    "time_window": {"start": 0, "end": 86400},
                    "service_time": 300,
                    "demand": 10.0,
                    "priority": 1
                }
            ],
            "vehicle": {
                "capacity": 100.0,
                "start_location": {"lat": 40.0, "lon": -74.0},
                "end_location": {"lat": 40.0, "lon": -74.0},
                "shift_window": {"start": 0, "end": 86400},
                "speed_mps": 10.0
            }
        }"#;

        let result = solve_route(problem_json);
        assert!(result.is_ok());
    }
}
