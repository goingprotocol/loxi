use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
}

impl Location {
    pub fn new(lat: f64, lon: f64) -> Self {
        Self { lat, lon }
    }

    pub fn distance_to(&self, other: &Location) -> f64 {
        const EARTH_RADIUS_M: f64 = 6_371_000.0;

        let lat1 = self.lat.to_radians();
        let lat2 = other.lat.to_radians();
        let delta_lat = (other.lat - self.lat).to_radians();
        let delta_lon = (other.lon - self.lon).to_radians();

        let a = (delta_lat / 2.0).sin().powi(2)
            + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
        let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

        EARTH_RADIUS_M * c
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeWindow {
    pub start: u32,
    pub end: u32,
}

impl TimeWindow {
    pub fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    pub fn contains(&self, time: u32) -> bool {
        time >= self.start && time <= self.end
    }

    pub fn wait_time(&self, arrival_time: u32) -> u32 {
        self.start.saturating_sub(arrival_time)
    }

    pub fn late_by(&self, arrival_time: u32) -> u32 {
        arrival_time.saturating_sub(self.end)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stop {
    pub id: String,
    pub location: Location,
    pub time_window: TimeWindow,
    pub service_time: u32,
    pub demand: f64,
    pub priority: u32,
}

impl Stop {
    pub fn new(
        id: impl Into<String>,
        location: Location,
        time_window: TimeWindow,
        service_time: u32,
        demand: f64,
        priority: u32,
    ) -> Self {
        Self { id: id.into(), location, time_window, service_time, demand, priority }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vehicle {
    pub capacity: f64,
    pub start_location: Location,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_location: Option<Location>,
    pub shift_window: TimeWindow,
    pub speed_mps: f64,
}

impl Default for Vehicle {
    fn default() -> Self {
        Self {
            capacity: 100.0,
            start_location: Location::new(0.0, 0.0),
            end_location: None,
            shift_window: TimeWindow::new(0, 86400),
            speed_mps: 10.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskRole {
    Partitioner,
    MatrixPartition,
    Solver,
    Leaf, // For simple single-step tasks
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemConfig {
    pub partitioner_hash: Option<String>,
    pub matrix_artifact_hash: Option<String>,
    pub solver_artifact_hash: Option<String>,
    pub workflow_id: Option<String>,
    #[serde(default)] // Allow omit for backward compat
    pub priority_owner: Option<String>,
    #[serde(default)]
    pub min_cpu: Option<u32>,
    pub required_contexts: Vec<String>,
}

impl Default for ProblemConfig {
    fn default() -> Self {
        Self {
            partitioner_hash: Some("loxi_partitioner_v1".to_string()),
            matrix_artifact_hash: Some("loxi_valhalla_v1".to_string()),
            solver_artifact_hash: Some("loxi_solver_v1".to_string()),
            workflow_id: Some("standard_vrp_flow".to_string()),
            priority_owner: None,
            min_cpu: None,
            required_contexts: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Problem {
    pub id: Option<String>,
    pub mission_id: Option<String>,
    #[serde(default)]
    pub config: ProblemConfig,
    pub stops: Vec<Stop>,
    pub vehicle: Vehicle,
    #[serde(default = "default_fleet_size")]
    pub fleet_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance_matrix: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_matrix: Option<Vec<Vec<u32>>>,
    pub seed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solution: Option<Solution>,
    #[serde(default = "default_role")]
    pub role: TaskRole,
}

fn default_role() -> TaskRole {
    TaskRole::Leaf
}

fn default_fleet_size() -> usize {
    1
}

impl Problem {
    pub fn new(stops: Vec<Stop>, vehicle: Vehicle) -> Self {
        Self {
            id: None,
            mission_id: None,
            config: ProblemConfig::default(),
            stops,
            vehicle,
            fleet_size: 1,
            distance_matrix: None,
            time_matrix: None,
            seed: 0,
            solution: None,
            role: TaskRole::Leaf,
        }
    }

    pub fn distance(&self, from_idx: usize, to_idx: usize) -> f64 {
        if let Some(ref matrix) = self.distance_matrix {
            matrix[from_idx][to_idx]
        } else {
            self.stops[from_idx].location.distance_to(&self.stops[to_idx].location)
        }
    }

    pub fn travel_time(&self, from_idx: usize, to_idx: usize) -> u32 {
        if let Some(ref matrix) = self.time_matrix {
            matrix[from_idx][to_idx]
        } else {
            let dist = self.distance(from_idx, to_idx);
            (dist / self.vehicle.speed_mps) as u32
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.stops.is_empty() {
            return Err("Problem must have at least one stop".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Violation {
    pub violation_type: String,
    pub stop_id: String,
    pub magnitude: f64,
}

impl Violation {
    pub fn new(vtype: impl Into<String>, stop_id: String, magnitude: f64) -> Self {
        Self { violation_type: vtype.into(), stop_id, magnitude }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionMetadata {
    pub solver_version: String,
    pub solve_time_ms: u64,
    pub seed: Option<u64>,
    pub iterations: Option<u32>,
}

impl SolutionMetadata {
    pub fn new(version: impl Into<String>, time_ms: u64) -> Self {
        Self {
            solver_version: version.into(),
            solve_time_ms: time_ms,
            seed: None,
            iterations: None,
        }
    }
}

impl Default for SolutionMetadata {
    fn default() -> Self {
        Self {
            solver_version: "unknown".to_string(),
            solve_time_ms: 0,
            seed: None,
            iterations: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Solution {
    #[serde(default)]
    pub route: Vec<String>,
    #[serde(default)]
    pub unassigned_jobs: Vec<String>,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub cost_breakdown: CostBreakdown,
    #[serde(default)]
    pub violations: Vec<Violation>,
    #[serde(default)]
    pub metadata: SolutionMetadata,
    #[serde(default)]
    pub matrix: Option<serde_json::Value>,
}

impl Solution {
    pub fn new(route: Vec<String>, cost: f64, metadata: SolutionMetadata) -> Self {
        Self {
            route,
            unassigned_jobs: Vec::new(),
            cost,
            cost_breakdown: CostBreakdown::default(),
            violations: Vec::new(),
            metadata,
            matrix: None,
        }
    }

    pub fn num_stops(&self) -> usize {
        self.route.len()
    }
}
