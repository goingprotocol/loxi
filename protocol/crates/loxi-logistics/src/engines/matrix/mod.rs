use crate::manager::types::Location;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaProblem {
    pub locations: Vec<Location>,
    pub costing: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaSolution {
    pub sources_to_targets: Vec<Vec<RoutingCost>>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoutingCost {
    pub distance: f64,
    pub time: f64,
    pub from_index: usize,
    pub to_index: usize,
}

pub mod downloader;

// Placeholder for Valhalla matrix calculation logic
// This will eventually interface with the precompiled loxi_valhalla.wasm
pub struct MatrixEngine;

impl MatrixEngine {
    pub fn calculate(_request_json: &str) -> Result<String, String> {
        Err("Matrix calculation via Valhalla is currently handled as an external WASM module."
            .to_string())
    }
}
