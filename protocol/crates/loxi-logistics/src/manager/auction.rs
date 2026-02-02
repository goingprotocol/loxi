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
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum AuctionStatus {
    Open,
    Closed,
    Assigned(String), // Worker ID
}

pub struct AuctionManager {
    auctions: HashMap<String, Auction>,
}

impl AuctionManager {
    pub fn new() -> Self {
        Self { auctions: HashMap::new() }
    }

    /// Create a new auction for a specific task requirement
    pub fn create_auction(&mut self, auction_id: String, req: TaskRequirement) -> LoxiMessage {
        let auction = Auction {
            id: auction_id.clone(),
            status: AuctionStatus::Open,
            requirement: req.clone(),
            bids: Vec::new(),
            created_at: 0, // In real implementation use current time
        };

        self.auctions.insert(auction_id.clone(), auction);

        // In L2, this would be an Event emission.
        // In Server Mode, this returns a message to be broadcasted via WebSocket.
        LoxiMessage::RequestLease { domain_id: auction_id.clone(), requirement: req, count: 1 }
    }

    /// Register a bid from a worker
    pub fn place_bid(&mut self, auction_id: &str, bid: Bid) -> Result<String, String> {
        if let Some(auction) = self.auctions.get_mut(auction_id) {
            if auction.status != AuctionStatus::Open {
                return Err("Auction is closed".to_string());
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
                Some(assignment)
            } else {
                None
            }
        } else {
            None
        }
    }
}
