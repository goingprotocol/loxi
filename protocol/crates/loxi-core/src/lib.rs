#![no_std]

#[macro_use]
extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskType {
    Compute,        // General purpose CPU/GPU task
    Proxy,          // Networking / Gateway task
    Custom(String), // Domain-specific custom labels
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
    #[serde(default)]
    pub owner_id: Option<String>, // The partner ID that owns this node (e.g. "marcos_diaz")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirement {
    pub id: String,
    pub affinities: Vec<String>, // Generic capability/data identifiers (e.g. "loxi_vrp_v1", "h3_cell_x")
    pub min_ram_mb: u64,
    pub min_cpu_threads: u32,
    pub use_gpu: bool,
    pub task_type: TaskType,
    #[serde(default)]
    pub priority_for_owner: Option<String>, // If set, prioritize workers with this owner_id
    #[serde(default)]
    pub metadata: Vec<(String, String)>, // Opaque domain metadata for the Architect
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assignment {
    pub node_id: String,
    pub task_type: TaskType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerLease {
    pub auction_id: String,
    pub worker_id: String,
    pub architect_address: String,
    pub task_type: TaskType,
    pub ticket: String, // Mandatory Access Token
    #[serde(default)]
    pub affinities: Vec<String>,
    #[serde(default)]
    pub metadata: Vec<(String, String)>,
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
    pub payload: Option<String>,
    #[serde(default)]
    pub metadata: Vec<(String, String)>,
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

    // Auth-based Data Fetch
    ClaimTask {
        auction_id: String,
        ticket: String,
    },

    // Phase 2: Worker Renting (The Grid)
    // Architect -> Orchestrator
    RequestLease {
        domain_id: String,
        requirement: TaskRequirement,
        count: u32,
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
    // SDK -> Architect (Direct Data Plane)
    PushSolution {
        auction_id: String,
        ticket: String,
        payload: String,
    },

    // Orchestrator -> Grid: Notifica quién ganó basado en el mejor costo/hash
    AuctionClosed {
        auction_id: String,
        winner_id: String,
        winning_hash: String,
    },

    // Orquestador -> Ganador: Orden de subir la data pesada al Architect
    RevealRequest {
        auction_id: String,
        destination: String,
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

            // 2. Data Affinity Scoring (Generic Capability boost)
            let mut affinity_score: u64 = 0;
            for req_affinity in &req.affinities {
                if node.affinity_hashes.contains(req_affinity) {
                    affinity_score += 5000; // Major boost for matching affinity (cached data/software)
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

            // 5. Load Balancing (Pseudo-Random Variance)
            // Use simple hashing of (NodeID + TaskID) to distribute load among identical nodes.
            // This avoids the "First Node Wins All" problem in homogenous clusters.
            let mut hash = 5381u64;
            for c in node.id.bytes() {
                hash = ((hash << 5).wrapping_add(hash)).wrapping_add(c as u64);
            }
            for c in req.id.bytes() {
                hash = ((hash << 5).wrapping_add(hash)).wrapping_add(c as u64);
            }
            let variance = hash % 50; // 0-49 points variation

            let total_score = tier_score + hardware_score + affinity_score + variance;

            if total_score > best_score {
                best_score = total_score;
                best_node = Some(node);
            }
        }

        best_node
            .map(|node| Assignment { node_id: node.id.clone(), task_type: req.task_type.clone() })
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
                owner_id: None,
            },
            NodeSpecs {
                id: "gaming_pc".to_string(),
                ram_mb: 16000,
                vram_mb: 8000,
                thread_count: 16,
                is_webgpu_enabled: true,
                affinity_hashes: vec![],
                verified_capacity: 5000,
                owner_id: None,
            },
        ];

        let req = TaskRequirement {
            id: "task_1".to_string(),
            affinities: vec!["capability_x".to_string()],
            min_ram_mb: 4000,
            min_cpu_threads: 4,
            use_gpu: true,
            task_type: TaskType::Compute,
            priority_for_owner: None, // Added field
            metadata: Vec::new(),
        };

        // Should pick gaming_pc
        let assignment = OrchestratorLogic::select_best_node(&nodes, &req).unwrap();
        assert_eq!(assignment.node_id, "gaming_pc");
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
                affinity_hashes: vec!["dataset_alpha".to_string()],
                verified_capacity: 500,
                owner_id: None,
            },
            NodeSpecs {
                id: "powerful_pc".to_string(),
                ram_mb: 16000,
                vram_mb: 8000,
                thread_count: 16,
                is_webgpu_enabled: true,
                affinity_hashes: vec![],
                verified_capacity: 5000,
                owner_id: None,
            },
        ];

        let req = TaskRequirement {
            id: "task_2".to_string(),
            affinities: vec!["module_gamma".to_string(), "dataset_alpha".to_string()],
            min_ram_mb: 2000,
            min_cpu_threads: 2,
            use_gpu: false,
            task_type: TaskType::Compute,
            priority_for_owner: None, // Added field
            metadata: Vec::new(),
        };

        // Even though PC is more powerful, the phone has the data affinity!
        let assignment = OrchestratorLogic::select_best_node(&nodes, &req).unwrap();
        assert_eq!(assignment.node_id, "expert_phone");
    }

    #[test]
    fn test_task_type_serialization() {
        let compute = TaskType::Compute;
        let custom = TaskType::Custom("generic_module".to_string());

        let s_compute = serde_json::to_string(&compute).unwrap();
        let s_custom = serde_json::to_string(&custom).unwrap();

        assert_eq!(s_compute, "\"Compute\"");
        assert_eq!(s_custom, "{\"Custom\":\"generic_module\"}");
    }
}
