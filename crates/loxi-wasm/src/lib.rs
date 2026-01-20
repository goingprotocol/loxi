use loxi_heuristics::{Solver, SolverConfig};
use loxi_types::{Problem, Solution};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn solve_route(problem_json: &str) -> Result<String, JsValue> {
    init_panic_hook();

    let problem: Problem = serde_json::from_str(problem_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse problem: {}", e)))?;

    let mut solver = Solver::default();
    let solution =
        solver.solve(&problem).map_err(|e| JsValue::from_str(&format!("Solver failed: {}", e)))?;

    let solution_json = serde_json::to_string(&solution)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize solution: {}", e)))?;

    Ok(solution_json)
}

#[wasm_bindgen]
pub fn solve_route_seeded(problem_json: &str, seed: u64) -> Result<String, JsValue> {
    init_panic_hook();

    let problem: Problem = serde_json::from_str(problem_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse problem: {}", e)))?;

    let config = SolverConfig { seed: Some(seed), ..Default::default() };

    let mut solver = Solver::new(config);
    let solution =
        solver.solve(&problem).map_err(|e| JsValue::from_str(&format!("Solver failed: {}", e)))?;

    let solution_json = serde_json::to_string(&solution)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize solution: {}", e)))?;

    Ok(solution_json)
}

#[wasm_bindgen]
pub fn refine_route_seeded(
    problem_json: &str,
    solution_json: &str,
    seed: u64,
) -> Result<String, JsValue> {
    init_panic_hook();

    let problem: Problem = serde_json::from_str(problem_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse problem: {}", e)))?;
    let initial: Solution = serde_json::from_str(solution_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse solution: {}", e)))?;

    let config = SolverConfig { seed: Some(seed), ..Default::default() };
    let mut solver = Solver::new(config);
    let refined = solver
        .refine_solution(&problem, &initial)
        .map_err(|e| JsValue::from_str(&format!("Refine failed: {}", e)))?;

    serde_json::to_string(&refined)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize solution: {}", e)))
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
