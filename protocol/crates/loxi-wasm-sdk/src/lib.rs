use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

/// Core trait that all LOXI-compatible WASM artifacts must implement.
pub trait LoxiArtifact {
    type Problem: for<'de> Deserialize<'de>;
    type Solution: Serialize;

    /// Solve the given problem. (WASM artifacts often need async/await for IO/Wait)
    fn solve(
        problem: &Self::Problem,
    ) -> impl std::future::Future<Output = Result<Self::Solution, String>>;

    /// (Optional) Refine an existing solution.
    fn refine(
        _problem: &Self::Problem,
        _previous_solution: &Self::Solution,
    ) -> impl std::future::Future<Output = Result<Self::Solution, String>> {
        async { Err("Refinement not implemented for this artifact".to_string()) }
    }

    /// (Optional) Get the cost of a solution.
    fn get_cost(solution: &Self::Solution) -> f64;
}

#[derive(Serialize, Deserialize)]
pub struct ArtifactResponse {
    pub payload: String,
    pub hash: String,
    pub cost: f64,
}

/// Standardized wrapper to handle the WASM boundary.
/// This ensures deterministic hashing and uniform response structure.
pub async fn loxi_worker_wrapper<T: LoxiArtifact>(problem_json: &str) -> Result<String, JsValue> {
    // 1. Initialize diagnostics
    console_error_panic_hook::set_once();

    // 2. Parse input
    let problem: T::Problem = serde_json::from_str(problem_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse problem: {}", e)))?;

    // 3. Execute solver
    let solution = T::solve(&problem)
        .await
        .map_err(|e| JsValue::from_str(&format!("Solver execution failed: {}", e)))?;

    // 4. Extract cost
    let cost = T::get_cost(&solution);

    // 5. Serialize solution
    let solution_json = serde_json::to_string(&solution)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize solution: {}", e)))?;

    // 6. Generate deterministic hash
    let mut hasher = Sha256::new();
    hasher.update(solution_json.as_bytes());
    let result_hash = format!("{:x}", hasher.finalize());

    // 7. Wrap for the network
    let response = ArtifactResponse { payload: solution_json, hash: result_hash, cost };

    Ok(serde_json::to_string(&response).unwrap())
}

#[derive(Serialize, Deserialize)]
pub struct ArtifactResponseBinary {
    pub payload: Vec<u8>,
    pub hash: String,
    pub cost: f64,
}

/// Zero-Copy binary wrapper for the WASM boundary.
/// Ingests native bincode slices directly from the Orchestrator, completely avoiding JSON serialization.
pub async fn loxi_worker_wrapper_binary<T: LoxiArtifact>(
    problem_bytes: &[u8],
) -> Result<Vec<u8>, JsValue> {
    console_error_panic_hook::set_once();

    // 1. Parse binary input
    let problem: T::Problem = bincode::deserialize(problem_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse binary problem: {}", e)))?;

    // 2. Execute solver
    let solution = T::solve(&problem)
        .await
        .map_err(|e| JsValue::from_str(&format!("Solver execution failed: {}", e)))?;

    // 3. Extract cost
    let cost = T::get_cost(&solution);

    // 4. Serialize solution to native binary
    let solution_bytes = bincode::serialize(&solution)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize binary solution: {}", e)))?;

    // 5. Generate deterministic hash
    let mut hasher = Sha256::new();
    hasher.update(&solution_bytes);
    let result_hash = format!("{:x}", hasher.finalize());

    // 6. Wrap in binary response structure
    let response = ArtifactResponseBinary { payload: solution_bytes, hash: result_hash, cost };

    bincode::serialize(&response)
        .map_err(|e| JsValue::from_str(&format!("Failed to pack final binary response: {}", e)))
}
