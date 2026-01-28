pub mod engines;
pub mod manager;

use crate::engines::vrp::VrpSolver;
use crate::manager::types::{Problem, Solution};
#[cfg(feature = "include_wasm")]
use loxi_wasm_sdk::loxi_worker_wrapper;
use loxi_wasm_sdk::LoxiArtifact;
#[cfg(feature = "include_wasm")]
use wasm_bindgen::prelude::*;

pub struct LogisticsArtifact;

impl LoxiArtifact for LogisticsArtifact {
    type Problem = Problem;
    type Solution = Solution;

    fn solve(problem: &Self::Problem) -> Result<Self::Solution, String> {
        let mut problem = problem.clone();

        // 1. Check if we need to calculate the matrix using Valhalla
        if problem.distance_matrix.is_none() {
            #[cfg(all(
                any(target_arch = "wasm32", target_arch = "wasm64"),
                feature = "include_wasm"
            ))]
            {
                // Attempt to use the native Matrix engine if initialized
                if let Ok((dists, times)) =
                    crate::engines::matrix::MatrixEngine::calculate_matrices_for_problem(&problem)
                {
                    problem.distance_matrix = Some(dists);
                    problem.time_matrix = Some(times);
                }
            }
        }

        // 2. Run the VRP solver
        VrpSolver::solve(&problem).map_err(|e| format!("Solver failed: {}", e))
    }

    fn get_cost(solution: &Self::Solution) -> f64 {
        solution.cost
    }
}

#[cfg(feature = "include_wasm")]
#[wasm_bindgen]
pub fn solve(problem_json: &str) -> Result<String, JsValue> {
    loxi_worker_wrapper::<LogisticsArtifact>(problem_json)
}

#[cfg(feature = "include_wasm")]
#[no_mangle]
pub extern "C" fn loxi_solve(ptr: *const u8, len: usize) -> *mut u8 {
    let s = unsafe { std::slice::from_raw_parts(ptr, len) };
    let json = std::str::from_utf8(s).unwrap_or("");
    let res = solve(json);
    match res {
        Ok(s) => std::ffi::CString::new(s).unwrap().into_raw() as *mut u8,
        Err(_) => std::ptr::null_mut(),
    }
}

#[cfg(feature = "include_wasm")]
#[wasm_bindgen]
pub fn init_engine(config_json_path: &str) -> Result<(), JsValue> {
    crate::engines::matrix::MatrixEngine::init(config_json_path).map_err(|e| JsValue::from_str(&e))
}

#[cfg(feature = "include_wasm")]
#[no_mangle]
pub extern "C" fn loxi_init_engine(ptr: *const u8, len: usize) -> i32 {
    let s = unsafe { std::slice::from_raw_parts(ptr, len) };
    let path = std::str::from_utf8(s).unwrap_or("");
    match init_engine(path) {
        Ok(_) => 0,
        Err(_) => 1,
    }
}

#[cfg(feature = "include_wasm")]
#[wasm_bindgen]
pub fn solve_seeded(problem_json: &str, _seed: u64) -> Result<String, JsValue> {
    // In the future, this will configure VrpSolver with the seed
    loxi_worker_wrapper::<LogisticsArtifact>(problem_json)
}

#[cfg(feature = "include_wasm")]
#[wasm_bindgen]
pub fn refine_seeded(
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
    #[cfg(feature = "include_wasm")]
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
                "id": "V1",
                "capacity": 100.0,
                "start_location": {"lat": 40.0, "lon": -74.0},
                "shift_window": {"start": 0, "end": 86400},
                "speed_mps": 10.0
            }
        }"#;

        let result = solve(problem_json);
        let _target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        assert!(result.is_ok());
    }
}
