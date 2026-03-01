use loxi_core::{
    Assignment, Bid, Message as LoxiMessage, NodeSpecs, OrchestratorLogic, TaskRequirement,
};
use serde::{Deserialize, Serialize};

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
    Assigned(String),
}

pub struct ArchitectAuction {
    pub auctions: dashmap::DashMap<String, Auction>,
}

impl Default for ArchitectAuction {
    fn default() -> Self {
        Self::new()
    }
}

impl ArchitectAuction {
    pub fn new() -> Self {
        Self { auctions: dashmap::DashMap::new() }
    }

    pub fn create_auction(
        &self,
        auction_id: String,
        domain_id: String,
        req: TaskRequirement,
    ) -> LoxiMessage {
        let auction = Auction {
            id: auction_id.clone(),
            status: AuctionStatus::Open,
            requirement: req.clone(),
            bids: Vec::new(),
            created_at: 0,
        };

        self.auctions.insert(auction_id.clone(), auction);
        LoxiMessage::RequestLease { domain_id, requirement: req, count: 1 }
    }

    pub fn place_bid(&self, auction_id: &str, bid: Bid) -> Result<String, String> {
        if let Some(mut auction) = self.auctions.get_mut(auction_id) {
            if auction.status != AuctionStatus::Open {
                return Err("Auction is closed".to_string());
            }

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

    pub fn close_auction(&self, auction_id: &str) -> Option<Assignment> {
        if let Some(mut auction) = self.auctions.get_mut(auction_id) {
            auction.status = AuctionStatus::Closed;
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
