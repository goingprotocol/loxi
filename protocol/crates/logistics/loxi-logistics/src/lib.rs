#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub mod architect;
pub mod engines;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub mod server;
pub mod types;

/// Ticket-verification callback: returns `Some((sub, aud))` on success.
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub type VerifyFn = std::sync::Arc<dyn Fn(&str) -> Option<(String, String)> + Send + Sync>;

use crate::types::{Problem, Solution};
use loxi_wasm_sdk::LoxiArtifact;

pub struct LogisticsArtifact;

impl LoxiArtifact for LogisticsArtifact {
    type Problem = Problem;
    type Solution = Solution;

    fn solve(
        problem: &Self::Problem,
    ) -> impl std::future::Future<Output = Result<Self::Solution, String>> {
        let problem = problem.clone();
        async move {
            crate::engines::vrp::VrpSolver::solve(&problem)
                .map_err(|e| format!("Solver failed: {}", e))
        }
    }

    fn get_cost(solution: &Self::Solution) -> f64 {
        solution.cost
    }
}

pub struct VrpArtifact;
impl LoxiArtifact for VrpArtifact {
    type Problem = Problem;
    type Solution = Solution;
    fn solve(
        problem: &Self::Problem,
    ) -> impl std::future::Future<Output = Result<Self::Solution, String>> {
        let problem = problem.clone();
        async move {
            crate::engines::vrp::VrpSolver::solve(&problem)
                .map_err(|e| format!("VRP Solver failed: {}", e))
        }
    }
    fn get_cost(solution: &Self::Solution) -> f64 {
        solution.cost
    }
}

pub struct MatrixArtifact;
impl LoxiArtifact for MatrixArtifact {
    type Problem = Problem;
    type Solution = Solution;
    fn solve(
        problem: &Self::Problem,
    ) -> impl std::future::Future<Output = Result<Self::Solution, String>> {
        let problem = problem.clone();
        async move {
            crate::engines::matrix::MatrixEngine::calculate_matrices_for_problem(&problem).map(
                |(dist, time)| Solution {
                    matrix: Some(
                        serde_json::to_value(crate::engines::matrix::ValhallaSolution {
                            sources_to_targets: dist
                                .into_iter()
                                .zip(time)
                                .map(|(d_row, t_row)| {
                                    d_row
                                        .into_iter()
                                        .zip(t_row)
                                        .map(|(d, t)| crate::engines::matrix::RoutingCost {
                                            distance: d / 1000.0,
                                            time: t as f64,
                                            from_index: None,
                                            to_index: None,
                                        })
                                        .collect()
                                })
                                .collect(),
                        })
                        .unwrap(),
                    ),
                    ..Default::default()
                },
            )
        }
    }
    fn get_cost(_solution: &Self::Solution) -> f64 {
        0.0
    }
}

pub struct PartitionerArtifact;
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PartitionResponse {
    pub sectors: Vec<crate::engines::partitioner::Partition>,
    pub unassigned: Vec<String>,
}
impl LoxiArtifact for PartitionerArtifact {
    type Problem = Problem;
    type Solution = PartitionResponse;
    fn solve(
        problem: &Self::Problem,
    ) -> impl std::future::Future<Output = Result<Self::Solution, String>> {
        let problem = problem.clone();
        async move {
            let partitioner = crate::engines::partitioner::Partitioner::default();
            let (sectors, unassigned) = partitioner.partition_problem(&problem);
            Ok(PartitionResponse { sectors, unassigned })
        }
    }
    fn get_cost(_solution: &Self::Solution) -> f64 {
        0.0
    }
}
