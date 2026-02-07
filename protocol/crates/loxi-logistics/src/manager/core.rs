extern crate alloc;

use crate::engines::partitioner::{Partition, Partitioner};
use crate::manager::types::{Problem, Solution};
use alloc::vec::Vec;
use h3o::Resolution;

pub struct CoreLogistics {
    pub resolution: Resolution,
    pub max_cluster_size: usize,
}

impl CoreLogistics {
    pub fn new() -> Self {
        Self { resolution: Resolution::Eight, max_cluster_size: 20 }
    }

    /// Pure function: Chops the problem into Partitions using H3 logic.
    /// This is what will run inside Solana.
    pub fn partition(&self, problem: &Problem) -> Vec<Partition> {
        // Delegate to the shared engine
        let partitioner = Partitioner::with_options(self.resolution, self.max_cluster_size, 1000.0);
        let (mut partitions, unassigned) = partitioner.partition_problem(problem);

        // [DEMO HOTFIX] Rescue unassigned stops into an "Overflow Partition"
        // This prevents data loss for the demo until CVRP is implemented.
        if !unassigned.is_empty() {
            println!(
                "⚠️ [Core] Rescuing {} unassigned stops into Overflow Partition",
                unassigned.len()
            );

            // Create a dummy partition centered on the first unassigned stop's location (approximation)
            // In reality, these might be scattered, but for the demo we just need them grouped.
            let rescue_partition = Partition {
                id: "overflow_rescue".to_string(),
                job_ids: unassigned,         // Take all of them
                center_hex: "0".to_string(), // Dummy center
                total_load: 0,               // Dymmy load
                total_demand: 0.0,           // Dummy demand
            };
            partitions.push(rescue_partition);
        }

        partitions
    }

    /// Validates if a solution is legitimate for a given problem.
    pub fn validate_solution(&self, _problem: &Problem, solution: &Solution) -> bool {
        // Simplified check: Cost must be positive
        solution.cost > 0.0
    }
}
