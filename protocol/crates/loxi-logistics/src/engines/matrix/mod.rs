use crate::manager::types::{Location, Problem};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaProblem {
    pub sources: Vec<Location>,
    pub targets: Vec<Location>,
    pub costing: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaSolution {
    pub sources_to_targets: Vec<Vec<RoutingCost>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoutingCost {
    pub distance: f64,
    pub time: f64,
    pub from_index: usize,
    pub to_index: usize,
}

pub mod downloader;
pub mod lazy_fs;
pub mod valhalla_sys;

// Link to the native Valhalla engine (Phase 2 Unified WASM)
pub struct MatrixEngine;

impl MatrixEngine {
    pub fn calculate(request_json: &str) -> Result<String, String> {
        #[cfg(all(any(target_arch = "wasm32", target_arch = "wasm64"), feature = "include_wasm"))]
        {
            valhalla_sys::ValhallaEngine::matrix(request_json)
        }
        #[cfg(not(all(
            any(target_arch = "wasm32", target_arch = "wasm64"),
            feature = "include_wasm"
        )))]
        {
            let _ = request_json;
            Err("Matrix calculation via Valhalla is currently handled as an external WASM module."
                .to_string())
        }
    }

    pub fn calculate_matrices_for_problem(
        problem: &Problem,
    ) -> Result<(Vec<Vec<f64>>, Vec<Vec<u32>>), String> {
        let mut locations = Vec::new();

        // 1. Collect all unique locations in order
        locations.push(problem.vehicle.start_location);
        for stop in &problem.stops {
            locations.push(stop.location);
        }
        if let Some(end_loc) = problem.vehicle.end_location {
            locations.push(end_loc);
        }

        // 2. Build Valhalla Request
        let request = ValhallaProblem {
            sources: locations.clone(),
            targets: locations.clone(),
            costing: "auto".to_string(), // TODO: Support other costing types
        };

        let request_json =
            serde_json::to_string(&request).map_err(|e| format!("Serialization failed: {}", e))?;

        // 3. Call Native Valhalla
        let response_json = Self::calculate(&request_json)?;
        let solution: ValhallaSolution = serde_json::from_str(&response_json)
            .map_err(|e| format!("Deserialization failed ({}): {}", response_json, e))?;

        // 4. Map back to matrices
        let size = locations.len();
        let mut dist_matrix = vec![vec![0.0; size]; size];
        let mut time_matrix = vec![vec![0; size]; size];

        for (from_idx, row) in solution.sources_to_targets.iter().enumerate() {
            for (to_idx, cost) in row.iter().enumerate() {
                dist_matrix[from_idx][to_idx] = cost.distance * 1000.0; // Valhalla returns km, but we want meters
                time_matrix[from_idx][to_idx] = cost.time as u32;
            }
        }

        Ok((dist_matrix, time_matrix))
    }

    pub fn init(config_json_path: &str) -> Result<(), String> {
        #[cfg(all(any(target_arch = "wasm32", target_arch = "wasm64"), feature = "include_wasm"))]
        {
            valhalla_sys::ValhallaEngine::init(config_json_path)
        }
        #[cfg(not(all(
            any(target_arch = "wasm32", target_arch = "wasm64"),
            feature = "include_wasm"
        )))]
        {
            let _ = config_json_path;
            Ok(())
        }
    }
}
