use loxi_logistics::engines::matrix::{ValhallaProblem, ValhallaSolution};
use loxi_wasm_sdk::{loxi_worker_wrapper, LoxiArtifact};
use wasm_bindgen::prelude::*;

// --- FOREIGN INTERFACE (The Puppeteer Strings) ---

#[wasm_bindgen]
extern "C" {
    // This function must be implemented in the hosting JavaScript environment (App.tsx)
    #[wasm_bindgen(js_name = "callValhallaBridge")]
    fn call_valhalla_bridge(json_input: &str) -> String;
}

// --- ARTIFACT IMPLEMENTATION ---

pub struct MatrixArtifact;

impl LoxiArtifact for MatrixArtifact {
    type Problem = ValhallaProblem;
    type Solution = ValhallaSolution;

    fn solve(problem: &Self::Problem) -> Result<Self::Solution, String> {
        // 1. Serialize the problem to JSON string to pass across the bridge
        let json_str = serde_json::to_string(problem)
            .map_err(|e| format!("Failed to serialize problem for bridge: {}", e))?;

        // 2. CALL THE BRIDGE (Rust -> JS -> Valhalla -> JS -> Rust)
        let response_str = call_valhalla_bridge(&json_str);

        // 3. Handle Bridge Errors
        if response_str.is_empty() {
            return Err("Bridge returned empty response".to_string());
        }
        if response_str.starts_with("ERROR") {
            return Err(format!("Valhalla Bridge Error: {}", response_str));
        }

        // 4. Deserialize the Valhalla response back into our struct
        let solution: ValhallaSolution = serde_json::from_str(&response_str).map_err(|e| {
            format!("Invalid JSON from Valhalla Bridge: {}. Raw: {}", e, response_str)
        })?;

        Ok(solution)
    }

    fn get_cost(solution: &Self::Solution) -> f64 {
        // Calculate travel time sum as metric
        solution.sources_to_targets.iter().flat_map(|row| row.iter().map(|cell| cell.time)).sum()
    }
}

// --- WASM ENTRY POINT ---

#[wasm_bindgen]
pub fn solve(problem_json: &str) -> String {
    match loxi_worker_wrapper::<MatrixArtifact>(problem_json) {
        Ok(json) => json,
        Err(e) => {
            let error_msg = e.as_string().unwrap_or_else(|| format!("{:?}", e));
            format!("{{\"error\": {:?}}}", error_msg)
        }
    }
}
