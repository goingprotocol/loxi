use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Problem {
    pub auction_id: String,
    pub domain_id: String,
    pub payload: Option<String>,
}

impl Problem {
    pub fn new(auction_id: String, domain_id: String, payload: String) -> Self {
        Self { auction_id, domain_id, payload: Some(payload) }
    }
}
