use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Solution {
    pub auction_id: String,
    pub mission_id: Option<String>,
    pub worker_id: String,
    pub result_hash: String,
    pub cost: f64,
    pub content_type: String,
    pub payload: Option<String>,
}
