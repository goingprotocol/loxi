use loxi_core::{
    Assignment, Bid, Message as LoxiMessage, NodeSpecs, OrchestratorLogic, TaskRequirement,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Auction {
    pub id: String,
    pub status: AuctionStatus,
    pub requirement: TaskRequirement,
    pub bids: Vec<Bid>,
    pub created_at: u64,
    pub assigned_at: Option<u64>, // Timestamp when lease was assigned
    pub posted_by: String,        // Architect/Authority ID
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum AuctionStatus {
    Open,
    Closed,
    Assigned(String), // Worker ID
    Completed,
}

pub struct AuctionManager {
    auctions: HashMap<String, Auction>,
    pub node_states: HashMap<String, String>, // "IDLE" or "BUSY"
}

impl AuctionManager {
    pub fn new() -> Self {
        Self { auctions: HashMap::new(), node_states: HashMap::new() }
    }

    /// Create a new auction for a specific task requirement
    pub fn create_auction(
        &mut self,
        auction_id: String,
        req: TaskRequirement,
        payload: Option<String>,
        posted_by: String,
    ) -> LoxiMessage {
        let auction = Auction {
            id: auction_id.clone(),
            status: AuctionStatus::Open,
            requirement: req.clone(),
            bids: Vec::new(),
            created_at: Self::now(),
            assigned_at: None,
            posted_by,
        };

        self.auctions.insert(auction_id.clone(), auction);

        // In L2, this would be an Event emission.
        // In Server Mode, this returns a message to be broadcasted via WebSocket.
        LoxiMessage::RequestLease {
            domain_id: "generic_grid".to_string(),
            requirement: req,
            count: 1,
            payload,
        }
    }

    /// Register a bid from a worker
    pub fn place_bid(&mut self, auction_id: &str, bid: Bid) -> Result<String, String> {
        if let Some(auction) = self.auctions.get_mut(auction_id) {
            if auction.status != AuctionStatus::Open {
                return Err("Auction is closed".to_string());
            }

            // Stateful Check: Is the worker busy?
            if let Some(state) = self.node_states.get(&bid.worker_id) {
                if state == "BUSY" {
                    return Err("Worker is BUSY".to_string());
                }
            }

            // Basic validation: Does the worker meet the hard requirements?
            if bid.specs.ram_mb < auction.requirement.min_ram_mb {
                return Err("Worker does not meet RAM requirements".to_string());
            }
            if auction.requirement.use_gpu && !bid.specs.is_webgpu_enabled {
                return Err("Worker does not meet GPU requirements".to_string());
            }

            auction.bids.push(bid);
            Ok("Bid placed".to_string())
        } else {
            Err("Auction not found".to_string())
        }
    }

    /// Close the auction and select the winner using the Tiered Waterfall Logic
    pub fn close_auction(&mut self, auction_id: &str) -> Option<Assignment> {
        if let Some(auction) = self.auctions.get_mut(auction_id) {
            auction.status = AuctionStatus::Closed;

            // Convert bids to NodeSpecs for the core logic
            let candidates: Vec<NodeSpecs> = auction.bids.iter().map(|b| b.specs.clone()).collect();

            if let Some(assignment) =
                OrchestratorLogic::select_best_node(&candidates, &auction.requirement)
            {
                auction.status = AuctionStatus::Assigned(assignment.node_id.clone());
                auction.assigned_at = Some(Self::now());

                // Mark Node as BUSY
                self.node_states.insert(assignment.node_id.clone(), "BUSY".to_string());

                Some(assignment)
            } else {
                None
            }
        } else {
            None
        }
    }

    pub fn get_auction(&self, auction_id: &str) -> Option<&Auction> {
        self.auctions.get(auction_id)
    }

    pub fn get_auction_mut(&mut self, auction_id: &str) -> Option<&mut Auction> {
        self.auctions.get_mut(auction_id)
    }

    /// Check for leases that have exceeded the timeout duration without a solution.
    /// Returns a list of (AuctionID, TaskRequirement) to be re-broadcasted.
    pub fn check_expired_leases(
        &mut self,
        timeout_ms: u64,
    ) -> Vec<(String, TaskRequirement, String)> {
        let now = Self::now();
        let mut expired = Vec::new();

        for (id, auction) in self.auctions.iter_mut() {
            let is_stale_open =
                auction.status == AuctionStatus::Open && (now - auction.created_at > timeout_ms);
            let is_expired_lease = if let AuctionStatus::Assigned(_) = auction.status {
                if let Some(assigned_at) = auction.assigned_at {
                    now - assigned_at > timeout_ms
                } else {
                    false
                }
            } else {
                false
            };

            if is_stale_open || is_expired_lease {
                // Reset/Refresh
                if is_expired_lease {
                    println!("♻️  Lease EXPIRED for Task {}. Revoking...", id);
                    auction.status = AuctionStatus::Open;
                    auction.assigned_at = None;
                } else {
                    println!("♻️  Auction {} is STALE (No bids). Re-broadcasting...", id);
                }
                auction.bids.clear(); // Clear old bids (if any stale ones)

                expired.push((id.clone(), auction.requirement.clone(), auction.posted_by.clone()));
            }
        }

        expired
    }

    pub fn get_open_auctions(&self) -> Vec<(String, TaskRequirement, String)> {
        self.auctions
            .iter()
            .filter(|(_, a)| a.status == AuctionStatus::Open)
            .map(|(id, a)| (id.clone(), a.requirement.clone(), a.posted_by.clone()))
            .collect()
    }

    fn now() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }

    pub fn set_node_idle(&mut self, node_id: &str) {
        self.node_states.insert(node_id.to_string(), "IDLE".to_string());
    }
}
