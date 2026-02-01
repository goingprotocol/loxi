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
        let (partitions, _unassigned) = partitioner.partition_problem(problem);
        partitions
    }

    /// Validates if a solution is legitimate for a given problem.
    pub fn validate_solution(&self, _problem: &Problem, solution: &Solution) -> bool {
        // Simplified check: Cost must be positive
        solution.cost > 0.0
    }
}
