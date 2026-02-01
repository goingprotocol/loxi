#![no_std]

#[macro_use]
extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskType {
    Compute,        // General purpose CPU task
    Storage,        // Data-heavy / I/O task
    Batch,          // Specialized Batch/Group task (Formerly Matrix)
    Custom(String), // Domain-specific custom task types
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSpecs {
    pub id: String,
    pub ram_mb: u64,
    pub vram_mb: u64,
    pub thread_count: u32,
    pub is_webgpu_enabled: bool,
    pub affinity_hashes: Vec<String>, // Announce cached data (e.g. H3 cells, model shards)
    pub verified_capacity: u32,       // Score from Hardware Passport (e.g., max stops handled)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirement {
    pub id: String,
    pub artifact_hash: String,       // WASM Artifact identifier (SHA-256)
    pub context_hashes: Vec<String>, // Required data contexts
    pub min_ram_mb: u64,
    pub use_gpu: bool,
    pub task_type: TaskType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assignment {
    pub node_id: String,
    pub artifact_hash: String,
    pub task_type: TaskType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerLease {
    pub auction_id: String,
    pub worker_id: String,
    pub architect_address: String,
    pub artifact_hash: String,
    pub task_type: TaskType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainAuthority {
    pub domain_id: String,
    pub authority_address: String, // WebSocket or Smart Contract Address
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Solution {
    pub auction_id: String,
    pub worker_id: String,
    pub result_hash: String,
    pub cost: f64,
    pub content_type: String,
    pub payload: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,

    // FUTURE: Consensus Validation & Slashing
    // When enabled, multiple workers solve with different seeds
    // and the Orchestrator validates hash consistency
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consensus_group: Option<String>, // Group ID for multi-seed validation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>, // Seed used for this specific solution
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bid {
    pub auction_id: String,
    pub worker_id: String,
    pub specs: NodeSpecs,
    pub price: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Message {
    // Phase 1: Registration & Discovery
    RegisterNode(NodeSpecs),
    RegisterAuthority(DomainAuthority),
    DiscoverAuthority {
        domain_id: String,
    },
    AuthorityFound(DomainAuthority),

    // Phase 2: Worker Renting (The Grid)
    // Architect -> Orchestrator
    RequestLease {
        domain_id: String,
        requirement: TaskRequirement,
        count: u32,
        payload: Option<String>,
    },
    // Orchestrator -> SDK
    LeaseAssignment(WorkerLease),

    // Phase 3: Auction Logic (Agile L2 Simulation)
    // Architect -> Grid
    PostTask {
        auction_id: String,
        requirement: TaskRequirement,
        payload: Option<String>,
    },
    // SDK -> Grid
    SubmitBid(Bid),
    // SDK -> Grid: Final solution submission
    SubmitSolution(Solution),
    // SDK -> Grid: Push arbitrary data or partial results (streaming, telemetry, etc.)
    PushData {
        auction_id: String,
        payload: String,
        progress: f32,
    },

    // Orchestrator -> Grid: Notifica quién ganó basado en el mejor costo/hash
    AuctionClosed {
        auction_id: String,
        winner_id: String,
        winning_hash: String,
    },

    // Orquestador -> Ganador: Orden de subir la data pesada al Architect
    ConsensusReached {
        auction_id: String,
        winner_id: String,
    },

    // Mission Lifecycle Management
    UpdateMissionStatus {
        mission_id: String,
        status: String, // e.g., "Starting", "In Progress", "Completed", "Failed"
        details: Option<String>,
    },

    // Phase 4: Control & Status
    KeepAlive,
    Error(String),
}

pub struct OrchestratorLogic;

impl OrchestratorLogic {
    /// Pure function: Takes a list of nodes and specific requirements,
    /// returns the ID of the best candidate.
    pub fn select_best_node(nodes: &[NodeSpecs], req: &TaskRequirement) -> Option<Assignment> {
        let mut best_node: Option<&NodeSpecs> = None;
        let mut best_score: u64 = 0;

        for node in nodes {
            // 1. Hard Constraints (Must meet min reqs)
            if node.ram_mb < req.min_ram_mb {
                continue;
            }
            if req.use_gpu && !node.is_webgpu_enabled {
                continue;
            }

            // 2. Data Affinity Scoring (The "Expertise" multiplier)
            let mut affinity_score: u64 = 0;
            for req_hash in &req.context_hashes {
                if node.affinity_hashes.contains(req_hash) {
                    affinity_score += 5000; // Major boost for having the data locally
                }
            }

            // 3. Tier Scoring (Hardware Classification)
            let tier_score = if node.is_webgpu_enabled && node.ram_mb >= 16000 {
                3000
            } else if node.ram_mb >= 8000 {
                2000
            } else {
                1000
            };

            // 4. Granular Scoring (Tie-breaker)
            let hardware_score = node.ram_mb / 1024 + (node.thread_count as u64 * 10);

            let total_score = tier_score + hardware_score + affinity_score;

            if total_score > best_score {
                best_score = total_score;
                best_node = Some(node);
            }
        }

        best_node.map(|node| Assignment {
            node_id: node.id.clone(),
            artifact_hash: req.artifact_hash.clone(),
            task_type: req.task_type.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;

    #[test]
    fn test_select_best_node() {
        let nodes = vec![
            NodeSpecs {
                id: "weak_phone".to_string(),
                ram_mb: 2000,
                vram_mb: 0,
                thread_count: 4,
                is_webgpu_enabled: false,
                affinity_hashes: vec![],
                verified_capacity: 100,
            },
            NodeSpecs {
                id: "gaming_pc".to_string(),
                ram_mb: 16000,
                vram_mb: 8000,
                thread_count: 16,
                is_webgpu_enabled: true,
                affinity_hashes: vec![],
                verified_capacity: 5000,
            },
        ];

        let req = TaskRequirement {
            id: "task_1".to_string(),
            artifact_hash: "artifact_hash_123".to_string(),
            context_hashes: vec![],
            min_ram_mb: 4000,
            use_gpu: true,
            task_type: TaskType::Compute,
            mission_id: None,
            workflow_id: None,
            state: None,
        };

        // Should pick gaming_pc
        let assignment = OrchestratorLogic::select_best_node(&nodes, &req).unwrap();
        assert_eq!(assignment.node_id, "gaming_pc");
        assert_eq!(assignment.artifact_hash, "artifact_hash_123");
    }

    #[test]
    fn test_affinity_scoring() {
        let nodes = vec![
            NodeSpecs {
                id: "expert_phone".to_string(),
                ram_mb: 4000,
                vram_mb: 0,
                thread_count: 8,
                is_webgpu_enabled: false,
                affinity_hashes: vec!["target_data".to_string()],
                verified_capacity: 500,
            },
            NodeSpecs {
                id: "powerful_pc".to_string(),
                ram_mb: 16000,
                vram_mb: 8000,
                thread_count: 16,
                is_webgpu_enabled: true,
                affinity_hashes: vec![],
                verified_capacity: 5000,
            },
        ];

        let req = TaskRequirement {
            id: "task_2".to_string(),
            artifact_hash: "solve_wasm".to_string(),
            context_hashes: vec!["target_data".to_string()],
            min_ram_mb: 2000,
            use_gpu: false,
            task_type: TaskType::Compute,
            mission_id: None,
            workflow_id: None,
            state: None,
        };

        // Even though PC is more powerful, the phone has the data affinity!
        let assignment = OrchestratorLogic::select_best_node(&nodes, &req).unwrap();
        assert_eq!(assignment.node_id, "expert_phone");
    }

    #[test]
    fn test_task_type_serialization() {
        let compute = TaskType::Compute;
        let custom = TaskType::Custom("partitioner".to_string());

        let s_compute = serde_json::to_string(&compute).unwrap();
        let s_custom = serde_json::to_string(&custom).unwrap();

        assert_eq!(s_compute, "\"Compute\"");
        assert_eq!(s_custom, "{\"Custom\":\"partitioner\"}");
    }
}
