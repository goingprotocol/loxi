use loxi_logistics::engines::matrix::{ValhallaProblem, ValhallaSolution};
use loxi_wasm_sdk::LoxiArtifact;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// --- FOREIGN INTERFACE (The Puppeteer Strings) ---

#[wasm_bindgen]
extern "C" {
    // This function must be implemented in the hosting JavaScript environment (App.tsx)
    // IMPORTANT: It must return an OBJECT (JsValue), not a JSON String, to avoid WASM memory exhaustion.
    #[wasm_bindgen(js_name = "callValhallaBridgeSync")]
    fn call_valhalla_bridge(json_input: &str) -> JsValue;
}

// --- DATA STRUCTURES ---

#[derive(Deserialize)]
struct BridgeError {
    error: String,
}

#[derive(Serialize)]
struct ArtifactResponseJs {
    payload: ValhallaSolution, // Direct Object, not String
    hash: String,
    cost: f64,
    unassigned_jobs: Vec<String>,
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
        // Now returns a Handle to the JS Object in V8 heap
        let response_js_val = call_valhalla_bridge(&json_str);

        // 3. Handle Bridge Errors (String or Object)
        if response_js_val.is_string() {
            let s = response_js_val.as_string().unwrap_or_default();
            return Err(format!("Bridge Error (String): {}", s));
        }

        if let Ok(err_obj) = serde_wasm_bindgen::from_value::<BridgeError>(response_js_val.clone())
        {
            return Err(format!("Bridge Error (Object): {}", err_obj.error));
        }

        // 4. Deserialize the Valhalla response DIRECTLY from JsValue into our struct
        // This traverses the JS Object and builds Rust struct without allocating giant string in WASM
        let solution: ValhallaSolution = serde_wasm_bindgen::from_value(response_js_val)
            .map_err(|e| format!("Invalid Data from Valhalla Bridge: {}", e))?;

        Ok(solution)
    }

    fn get_cost(solution: &Self::Solution) -> f64 {
        // Calculate travel time sum as metric
        solution.sources_to_targets.iter().flat_map(|row| row.iter().map(|cell| cell.time)).sum()
    }
}

// --- WASM ENTRY POINT ---

#[wasm_bindgen]
pub fn solve(problem_json: &str) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();

    // 1. Parse Input
    let problem: ValhallaProblem = serde_json::from_str(problem_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse problem: {}", e)))?;

    // 2. Solve (Using optimized Bridge)
    let solution = MatrixArtifact::solve(&problem).map_err(|e| JsValue::from_str(&e))?;

    // 3. Extract Metrics
    let cost = MatrixArtifact::get_cost(&solution);

    // 4. Construct Response (Direct Object Transfer)
    let response = ArtifactResponseJs {
        payload: solution,
        hash: "matrix_generation_skipped_hash".to_string(),
        cost,
        unassigned_jobs: vec![],
    };

    // 5. Convert to JS Object (No serialization to String!)
    serde_wasm_bindgen::to_value(&response)
        .map_err(|e| JsValue::from_str(&format!("Failed to convert response to JS: {}", e)))
}
