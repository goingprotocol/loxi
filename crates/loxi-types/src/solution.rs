use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Violation {
    pub violation_type: String,
    pub stop_id: String,
    pub magnitude: f64,
}

impl Violation {
    pub fn new(
        violation_type: impl Into<String>,
        stop_id: impl Into<String>,
        magnitude: f64,
    ) -> Self {
        Self { violation_type: violation_type.into(), stop_id: stop_id.into(), magnitude }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionMetadata {
    pub solver_version: String,
    pub solve_time_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
}

impl SolutionMetadata {
    pub fn new(solver_version: impl Into<String>, solve_time_ms: u64) -> Self {
        Self { solver_version: solver_version.into(), solve_time_ms, seed: None, iterations: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Solution {
    pub route: Vec<String>,
    pub cost: f64,
    pub cost_breakdown: CostBreakdown,
    pub violations: Vec<Violation>,
    pub metadata: SolutionMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostBreakdown {
    pub total_distance: f64,
    pub total_time: u32,
    pub time_window_penalty: f64,
    pub capacity_penalty: f64,
    pub priority_cost: f64,
}

impl Default for CostBreakdown {
    fn default() -> Self {
        Self {
            total_distance: 0.0,
            total_time: 0,
            time_window_penalty: 0.0,
            capacity_penalty: 0.0,
            priority_cost: 0.0,
        }
    }
}

impl Solution {
    pub fn new(route: Vec<String>, cost: f64, metadata: SolutionMetadata) -> Self {
        Self {
            route,
            cost,
            cost_breakdown: CostBreakdown::default(),
            violations: Vec::new(),
            metadata,
        }
    }

    pub fn is_feasible(&self) -> bool {
        self.violations.is_empty()
    }

    pub fn num_stops(&self) -> usize {
        self.route.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_solution_creation() {
        let route = vec!["stop1".to_string(), "stop2".to_string(), "stop3".to_string()];
        let metadata = SolutionMetadata::new("0.1.0", 50);
        let solution = Solution::new(route, 1000.0, metadata);

        assert_eq!(solution.num_stops(), 3);
        assert!(solution.is_feasible());
        assert_eq!(solution.cost, 1000.0);
    }

    #[test]
    fn test_solution_with_violations() {
        let route = vec!["stop1".to_string()];
        let metadata = SolutionMetadata::new("0.1.0", 10);
        let mut solution = Solution::new(route, 500.0, metadata);

        solution.violations.push(Violation::new("time_window", "stop1", 300.0));
        assert!(!solution.is_feasible());
    }

    #[test]
    fn test_solution_serialization() {
        let route = vec!["stop1".to_string(), "stop2".to_string()];
        let metadata = SolutionMetadata::new("0.1.0", 25);
        let solution = Solution::new(route, 750.0, metadata);

        let json = serde_json::to_string_pretty(&solution).unwrap();
        let deserialized: Solution = serde_json::from_str(&json).unwrap();

        assert_eq!(solution.route, deserialized.route);
        assert_eq!(solution.cost, deserialized.cost);
    }
}
